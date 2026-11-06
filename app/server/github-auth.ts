import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';

// Connexion GitHub (plan GitHub, étape G1, 2026-11-06) : GitHub App
// « DS-Studio App », device flow. L'app affiche un code, le dev le saisit sur
// github.com/login/device ; aucun secret nulle part (le `client_id` est public
// et le renouvellement d'un jeton obtenu par device flow n'exige pas le
// `client_secret`, doc GitHub lue le 2026-11-06). Jetons dans `github.json`
// du dossier des réglages, lus par le serveur local seulement, jamais rendus
// au navigateur. Réservé à Pro (cadrage GitHub, décision 8).
export const GITHUB_CLIENT_ID = 'Iv23liZqDLgcMvMUlhMN';
export const GITHUB_APP_SLUG = 'ds-studio-app';
export const PRO_ONLY = 'GitHub est réservé à DS-Studio Pro : passe Pro dans Réglages → Compte.';
const SESSION_LOST = 'Connexion GitHub expirée ou retirée : reconnecte GitHub dans Réglages.';
const UNREACHABLE = 'GitHub injoignable (réseau ou délai dépassé).';
const API_VERSION = '2022-11-28';
// Jeton renouvelé une minute avant son expiration.
const MARGIN_MS = 60_000;
// Bornes de la liste des dépôts : 10 installations, 3 pages de 100 dépôts chacune.
const MAX_INSTALLATIONS = 10;
const MAX_PAGES = 3;

const storedSchema = z
  .object({
    login: z.string().min(1).max(100),
    accessToken: z.string().min(10).max(500),
    accessExpiresAt: z.string().nullable(),
    refreshToken: z.string().min(10).max(500).nullable(),
    refreshExpiresAt: z.string().nullable(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;

const deviceSchema = z.object({
  device_code: z.string().min(10).max(200),
  user_code: z.string().min(4).max(20),
  verification_uri: z.string().url().max(200),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().positive().max(120).default(5),
});
const tokenSchema = z.object({
  access_token: z.string().min(10).max(500),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(10).max(500).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

interface Pending {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
  nextAt: number;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GithubStatus {
  status: 'none' | 'pending' | 'connected';
  /** Licence Pro valide ou en grâce : sinon connexion et dépôts refusés. */
  pro: boolean;
  login: string | null;
  /** Code à saisir sur `verificationUri` (connexion en cours seulement). */
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: string | null;
  /** Page où le dev ajoute ou retire des dépôts accessibles à DS-Studio. */
  installUrl: string;
  message: string | null;
}

export interface GithubAuthOptions {
  /** Dossier de `github.json` (réglages de l'utilisateur, comme `account.json`). */
  dir: string;
  isPro: () => boolean;
  clientId?: string;
  /** github.com (connexion) et api.github.com ; remplacés par un faux GitHub en test. */
  loginUrl?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Sondage automatique pendant la connexion ; coupé dans les tests (`pollOnce`). */
  autoPoll?: boolean;
}

export class GithubAuth {
  private stored: Stored | null = null;
  private pending: Pending | null = null;
  private message: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly file: string;
  private readonly clientId: string;
  private readonly loginUrl: string;
  private readonly apiUrl: string;
  private readonly now: () => Date;
  private constructor(private readonly options: GithubAuthOptions) {
    this.file = path.join(options.dir, 'github.json');
    this.clientId = options.clientId || GITHUB_CLIENT_ID;
    this.loginUrl = (options.loginUrl || 'https://github.com').replace(/\/+$/, '');
    this.apiUrl = (options.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.now = options.now ?? (() => new Date());
  }

  // Relit la connexion gardée sur le poste ; un fichier illisible vaut « déconnecté ».
  static async open(options: GithubAuthOptions) {
    const auth = new GithubAuth(options);
    try {
      auth.stored = storedSchema.parse(JSON.parse(await readPrivate(auth.file, 100_000)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('github.json illisible : GitHub déconnecté.');
    }
    return auth;
  }

  private ms() {
    return this.now().getTime();
  }
  private async save() {
    await fs.mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify(this.stored, null, 2) + '\n');
  }
  private async forget(message: string | null) {
    this.stored = null;
    this.message = message;
    await fs.rm(this.file, { force: true });
  }
  private requirePro() {
    if (!this.options.isPro()) throw new StudioError(PRO_ONLY, 402);
  }

  // Formulaire OAuth de github.com : paramètres en corps encodé, réponse JSON
  // demandée par `Accept` ; les refus (attente, code expiré) arrivent en 200
  // avec un champ `error`.
  private async oauth(route: string, params: Record<string, string>) {
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(this.loginUrl + route, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'DS-Studio' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StudioError(UNREACHABLE, 502);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new StudioError(`GitHub a refusé la connexion (${res.status}).`, 502);
    return body;
  }

  private async accept(body: Record<string, unknown>) {
    const t = tokenSchema.parse(body);
    const at = this.ms();
    const user = await this.call<{ login?: string }>('/user', {}, t.access_token);
    this.stored = {
      login: String(user.login ?? 'inconnu').slice(0, 100),
      accessToken: t.access_token,
      accessExpiresAt: t.expires_in ? new Date(at + t.expires_in * 1000).toISOString() : null,
      refreshToken: t.refresh_token ?? null,
      refreshExpiresAt: t.refresh_token_expires_in ? new Date(at + t.refresh_token_expires_in * 1000).toISOString() : null,
    };
    this.message = null;
    await this.save();
  }

  // Début de connexion : code à afficher, sondage en arrière-plan au rythme
  // demandé par GitHub. Une connexion en cours est remplacée.
  async start() {
    this.requirePro();
    this.cancel();
    const d = deviceSchema.parse(await this.oauth('/login/device/code', { client_id: this.clientId }));
    const at = this.ms();
    this.pending = {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      expiresAt: at + d.expires_in * 1000,
      intervalMs: d.interval * 1000,
      nextAt: at + d.interval * 1000,
    };
    this.message = null;
    this.schedule();
    return this.status();
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    return this.status();
  }

  private schedule() {
    if (this.options.autoPoll === false || !this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pollOnce().then(() => this.schedule()), Math.max(0, this.pending.nextAt - this.ms()));
    this.timer.unref();
  }

  // Une demande de jeton pendant la connexion (exposée pour les tests).
  // N'échoue jamais : l'issue se lit dans `status()`.
  async pollOnce() {
    const p = this.pending;
    if (!p) return this.status();
    if (this.ms() >= p.expiresAt) {
      this.pending = null;
      this.message = 'Code expiré : relance la connexion GitHub.';
      return this.status();
    }
    try {
      const body = await this.oauth('/login/oauth/access_token', {
        client_id: this.clientId,
        device_code: p.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (this.pending !== p) return this.status();
      const error = typeof body.error === 'string' ? body.error : null;
      if (error === 'authorization_pending') p.nextAt = this.ms() + p.intervalMs;
      else if (error === 'slow_down') {
        // GitHub ajoute 5 s à chaque `slow_down` et rend le nouveau rythme.
        const interval = typeof body.interval === 'number' ? body.interval * 1000 : p.intervalMs + 5000;
        p.intervalMs = Math.max(interval, p.intervalMs + 5000);
        p.nextAt = this.ms() + p.intervalMs;
      } else if (error) {
        this.pending = null;
        this.message =
          error === 'access_denied'
            ? 'Connexion GitHub refusée sur github.com.'
            : error === 'expired_token'
              ? 'Code expiré : relance la connexion GitHub.'
              : `Connexion GitHub impossible (${error.slice(0, 60)}).`;
      } else {
        this.pending = null;
        await this.accept(body);
      }
    } catch (e) {
      // Réseau coupé : on réessaie au prochain tour, le code reste valable.
      p.nextAt = this.ms() + p.intervalMs;
      this.message = e instanceof StudioError ? e.message : UNREACHABLE;
    }
    return this.status();
  }

  async logout() {
    this.cancel();
    await this.forget(null);
    return this.status();
  }

  // Jeton valable, renouvelé s'il expire (une seule fois à la fois) ;
  // renouvellement refusé → déconnexion.
  async token(): Promise<string> {
    this.requirePro();
    const s = this.stored;
    if (!s) throw new StudioError('GitHub n’est pas connecté : connecte-le dans Réglages.', 409);
    const expires = s.accessExpiresAt ? new Date(s.accessExpiresAt).getTime() : Infinity;
    if (this.ms() < expires - MARGIN_MS) return s.accessToken;
    this.refreshing ??= this.renew(s).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async renew(s: Stored) {
    const usable = s.refreshToken && (!s.refreshExpiresAt || this.ms() < new Date(s.refreshExpiresAt).getTime());
    if (!usable) {
      await this.forget(SESSION_LOST);
      throw new StudioError(SESSION_LOST, 401);
    }
    const body = await this.oauth('/login/oauth/access_token', {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: s.refreshToken!,
    });
    if (typeof body.error === 'string') {
      await this.forget(SESSION_LOST);
      throw new StudioError(SESSION_LOST, 401);
    }
    await this.accept(body);
    return this.stored!.accessToken;
  }

  // Un appel à l'API GitHub avec le jeton de l'utilisateur ; 401 → déconnexion.
  private async call<T>(route: string, init: { method?: string; json?: unknown } = {}, token?: string): Promise<T> {
    const bearer = token ?? (await this.token());
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(this.apiUrl + route, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'DS-Studio',
          ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new StudioError(UNREACHABLE, 502);
    }
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (res.status === 401) {
      if (!token) await this.forget(SESSION_LOST);
      throw new StudioError(SESSION_LOST, 401);
    }
    if (!res.ok) throw new StudioError(`GitHub : ${String(data.message ?? res.status).slice(0, 200)}.`, 502);
    return data;
  }

  // Dépôts où DS-Studio est installé et que l'utilisateur peut voir (le jeton
  // n'a que l'intersection des deux, doc GitHub).
  async repos(): Promise<GithubRepo[]> {
    const { installations = [] } = await this.call<{ installations?: { id: number }[] }>('/user/installations?per_page=100');
    const repos: GithubRepo[] = [];
    for (const inst of installations.slice(0, MAX_INSTALLATIONS)) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await this.call<{ repositories?: { full_name: string; private: boolean; default_branch: string }[] }>(
          `/user/installations/${Number(inst.id)}/repositories?per_page=100&page=${page}`,
        );
        const list = r.repositories ?? [];
        for (const repo of list) repos.push({ fullName: repo.full_name, private: !!repo.private, defaultBranch: repo.default_branch || 'main' });
        if (list.length < 100) break;
      }
    }
    return [...new Map(repos.map((r) => [r.fullName, r])).values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  status(): GithubStatus {
    const p = this.pending;
    return {
      status: this.stored ? 'connected' : p ? 'pending' : 'none',
      pro: this.options.isPro(),
      login: this.stored?.login ?? null,
      userCode: p?.userCode ?? null,
      verificationUri: p?.verificationUri ?? null,
      expiresAt: p ? new Date(p.expiresAt).toISOString() : null,
      installUrl: `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`,
      message: this.message,
    };
  }

  stop() {
    this.cancel();
  }
}
