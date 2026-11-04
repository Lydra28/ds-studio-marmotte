import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { verifyLicense, type LicenseCheck, type LicensePayload } from '../../server/license.js';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';

// Compte DS-Studio dans l'app (lot 3) : le serveur local porte la session
// (jeton dans `account.json` du dossier de réglages, jamais rendu au
// navigateur), la licence signée vérifiée hors ligne avec la clé publique
// embarquée, et l'usage lu sur `/v1/me`. Seul module qui parle au serveur
// distant : l'agent et le Mur passent par `relay`, avec le jeton du compte.
export const DEFAULT_API_URL = 'https://api.design-system-studio.fr';
export type Origin = 'assistant' | 'wall';
export type Tier = 'free' | 'pro';
export type OffReason = 'account' | 'offline';
export type Pack = '5' | '10' | '20';
export interface Subscription {
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export const NOT_CONNECTED = 'Assistant indisponible : connecte-toi à ton compte DS-Studio dans Réglages. Tout le reste fonctionne.';
export const OFFLINE = 'Serveur DS-Studio injoignable (réseau ou délai dépassé) : l’atelier continue sans l’assistant.';
const SESSION_LOST = 'Session expirée : reconnecte-toi dans Réglages.';

// Rafraîchissement de `/v1/me` toutes les 10 min en ligne, nouvel essai toutes
// les 60 s hors ligne ; licence renouvelée après 6 h ou dès qu'elle n'est plus valide.
const TICK_MS = 60_000;
const REFRESH_MS = 10 * 60_000;
const LICENSE_RENEW_MS = 6 * 3600_000;

const storedSchema = z
  .object({
    token: z.string().min(10),
    email: z.string(),
    license: z.string().nullable().default(null),
    licenseAt: z.string().nullable().default(null),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;

// Catalogue du serveur (lot 7, `catalog` de server/billing.ts) : prix en
// centimes d'euro, seule source des montants affichés par l'app.
export interface Catalog {
  currency: 'eur';
  mode: 'live' | 'test' | 'off';
  pro: { amountCents: number; interval: 'month'; includedCents: number };
  packs: { pack: '5' | '10' | '20'; amountCents: number }[];
  welcomeCents: number;
  generationCents: { wall: number; assistant: number };
}

// Ce que `/v1/me` rend (server/app.ts) ; l'app n'en lit que ces champs.
interface Me {
  email: string;
  plan: Tier;
  tier?: Tier;
  gifted: boolean;
  dailyCapCents: number;
  /** Centimes d'euro (lot 4). */
  creditCents: number;
  welcome?: boolean;
  subscription?: Subscription | null;
  usage?: { todayCents: number; monthCents: number; resetAt: string; includedLeftCents: number };
  catalog?: Catalog;
}

export interface AccountStatus {
  status: 'none' | 'connected';
  /** Faux dès qu'un appel au serveur a échoué (réseau), vrai au suivant qui aboutit. */
  online: boolean;
  email: string | null;
  /** Palier effectif : celui d'une licence valide ou en grâce, sinon gratuit. */
  tier: Tier;
  /** Palier du compte côté serveur (abonnement), que la licence peut suivre avec retard. */
  plan: Tier;
  gifted: boolean;
  /** Crédit de bienvenue encore entier : « une génération offerte ». */
  welcome: boolean;
  subscription: Subscription | null;
  license: { state: LicenseCheck['status'] | 'none'; expiresAt: string | null; graceUntil: string | null } | null;
  /** `todayCents`, `monthCents`, `dailyCapCents` : coût du modèle en centimes de dollar ; `includedLeftCents`, `creditCents` : centimes d'euro. */
  usage: { todayCents: number; monthCents: number; resetAt: string; includedLeftCents: number; creditCents: number; dailyCapCents: number } | null;
  /** Prix du serveur, connus après le premier `/v1/me` ; null avant (rien d'affiché en dur). */
  catalog: Catalog | null;
  /** Dernier échec (réseau, session perdue), pour Réglages. */
  message: string | null;
}

export interface AccountOptions {
  /** Dossier de `account.json` (réglages de l'utilisateur). */
  dir: string;
  apiUrl?: string;
  /** Clé publique PEM des licences ; absente ou nulle : aucune licence vérifiable, palier gratuit. */
  publicKey?: string | null;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class AccountClient {
  private stored: Stored | null = null;
  private me: Me | null = null;
  private online = true;
  private message: string | null = null;
  private refreshedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly apiUrl: string;
  private readonly now: () => Date;
  private constructor(private readonly options: AccountOptions) {
    this.file = path.join(options.dir, 'account.json');
    this.apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    this.now = options.now ?? (() => new Date());
  }

  // Relit la session gardée sur le poste ; un fichier illisible vaut « déconnecté ».
  static async open(options: AccountOptions) {
    const client = new AccountClient(options);
    try {
      client.stored = storedSchema.parse(JSON.parse(await readPrivate(client.file, 100_000)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('account.json illisible : compte déconnecté.');
    }
    return client;
  }

  private async save() {
    await fs.mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.file, JSON.stringify(this.stored, null, 2) + '\n');
  }
  private async forget(message: string | null) {
    this.stored = null;
    this.me = null;
    this.message = message;
    await fs.rm(this.file, { force: true });
  }

  // Un appel au serveur : JSON dans les deux sens, jeton de session ajouté
  // (sauf `auth: false`), erreurs du serveur transmises telles quelles avec
  // leur statut, réseau coupé → hors ligne, session refusée → déconnexion.
  private async api<T = Record<string, unknown>>(
    route: string,
    init: { json?: unknown; method?: string; auth?: boolean; origin?: Origin; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) headers['content-type'] = 'application/json';
    if (init.auth !== false) {
      if (!this.stored) throw new StudioError(NOT_CONNECTED, 503);
      headers.authorization = `Bearer ${this.stored.token}`;
    }
    if (init.origin) headers['x-ds-origin'] = init.origin;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.apiUrl + route, {
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      });
    } catch {
      this.online = false;
      this.message = OFFLINE;
      throw new StudioError(OFFLINE, 502);
    }
    this.online = true;
    this.message = null;
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (response.status === 401 && init.auth !== false) {
      await this.forget(SESSION_LOST);
      throw new StudioError(SESSION_LOST, 401);
    }
    if (!response.ok)
      throw new StudioError(typeof body.error === 'string' ? body.error : `Serveur DS-Studio : erreur ${response.status}.`, response.status);
    return body as T;
  }

  async signup(email: string, password: string) {
    const r = await this.api<{ message?: string }>('/v1/auth/signup', { json: { email, password }, auth: false });
    return r.message ?? 'Compte créé.';
  }
  async login(email: string, password: string) {
    const r = await this.api<{ token: string; account: Me }>('/v1/auth/login', { json: { email, password, client: 'app' }, auth: false });
    this.stored = { token: r.token, email: r.account.email, license: null, licenseAt: null };
    this.me = r.account;
    await this.save();
    await this.refresh();
    return this.status();
  }
  async forgot(email: string) {
    const r = await this.api<{ message?: string }>('/v1/auth/forgot', { json: { email }, auth: false });
    return r.message ?? 'Mail envoyé.';
  }
  async reset(code: string, password: string) {
    const r = await this.api<{ message?: string }>('/v1/auth/reset', { json: { token: code, password }, auth: false });
    return r.message ?? 'Mot de passe changé.';
  }
  async logout() {
    if (this.stored) await this.api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    await this.forget(null);
    return this.status();
  }

  // Compte et usage à jour, licence renouvelée quand il faut. N'échoue jamais :
  // un problème se lit dans `status().message` et `online`.
  async refresh() {
    if (!this.stored) return this.status();
    try {
      this.me = await this.api<Me>('/v1/me');
      this.refreshedAt = this.now().getTime();
      const check = this.license();
      const age = this.stored.licenseAt ? this.now().getTime() - new Date(this.stored.licenseAt).getTime() : Infinity;
      // Palier changé côté serveur (abonnement pris ou résilié, compte offert) : licence renouvelée sans attendre.
      const effective: Tier = this.me.gifted ? 'pro' : this.me.plan;
      const stale = check?.status === 'valid' && (check.payload.tier !== effective || check.payload.gifted !== this.me.gifted);
      if (!check || check.status !== 'valid' || age >= LICENSE_RENEW_MS || stale) {
        const issued = await this.api<{ license: string }>('/v1/license', { method: 'POST' });
        this.stored.license = issued.license;
        this.stored.licenseAt = this.now().toISOString();
        await this.save();
      }
    } catch (e) {
      // Hors ligne ou session perdue : déjà noté par `api`.
      if (!(e instanceof StudioError)) throw e;
    }
    return this.status();
  }

  // Appel du relais (agent, Mur) : corps OpenRouter transmis tel quel,
  // réponse OpenRouter telle quelle ; 402, 429, 502, 503 du serveur remontent
  // avec leur message.
  relay<T = Record<string, unknown>>(body: unknown, origin: Origin) {
    return this.api<T>('/v1/relay/chat', { json: body, origin, timeoutMs: 120_000 });
  }

  // Achats (lot 4) : le serveur rend l'adresse d'une page Stripe (Checkout ou
  // portail), que Réglages ouvre dans le navigateur ; le compte change ensuite
  // par webhook, visible au rafraîchissement suivant.
  checkout(kind: 'pro' | 'credits', pack?: Pack) {
    return this.api<{ url: string }>('/v1/billing/checkout', { json: { kind, pack } });
  }
  portal() {
    return this.api<{ url: string }>('/v1/billing/portal', { json: {} });
  }

  // La licence gardée, vérifiée avec la clé publique à l'instant présent.
  license(): LicenseCheck | null {
    if (!this.stored?.license) return null;
    if (!this.options.publicKey) return { status: 'invalid', reason: 'clé publique absente' };
    return verifyLicense(this.options.publicKey, this.stored.license, this.now());
  }

  status(): AccountStatus {
    const check = this.license();
    const payload: LicensePayload | null = check && check.status !== 'invalid' ? check.payload : null;
    const live = check && (check.status === 'valid' || check.status === 'grace');
    const u = this.me?.usage;
    return {
      status: this.stored ? 'connected' : 'none',
      online: this.online,
      email: this.stored?.email ?? null,
      tier: live && payload ? payload.tier : 'free',
      plan: this.me?.plan ?? 'free',
      gifted: live && payload ? payload.gifted : false,
      welcome: this.me?.welcome ?? false,
      subscription: this.me?.subscription ?? null,
      license: this.stored
        ? {
            state: check?.status ?? 'none',
            expiresAt: payload ? new Date(payload.exp).toISOString() : null,
            graceUntil: payload ? new Date(payload.grace).toISOString() : null,
          }
        : null,
      usage:
        this.me && u
          ? {
              todayCents: u.todayCents,
              monthCents: u.monthCents,
              resetAt: u.resetAt,
              includedLeftCents: u.includedLeftCents,
              creditCents: this.me.creditCents,
              dailyCapCents: this.me.dailyCapCents,
            }
          : null,
      catalog: this.me?.catalog ?? null,
      message: this.message,
    };
  }

  // Les panneaux (agent, Mur, plugin) : actifs seulement connecté et en ligne.
  enabled(): { enabled: boolean; reason: OffReason | null } {
    if (!this.stored) return { enabled: false, reason: 'account' };
    if (!this.online) return { enabled: false, reason: 'offline' };
    return { enabled: true, reason: null };
  }
  off(reason: OffReason) {
    return reason === 'account' ? NOT_CONNECTED : OFFLINE;
  }

  // Minuterie de fond : usage à jour, retour en ligne constaté sans action de
  // l'utilisateur. Sans effet sur l'arrêt du processus (`unref`).
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.stored) return;
      if (!this.online || this.now().getTime() - this.refreshedAt >= REFRESH_MS) void this.refresh();
    }, TICK_MS);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
