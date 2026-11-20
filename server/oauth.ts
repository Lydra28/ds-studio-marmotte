// Connexion avec Google et GitHub, et connexion de l'app par le site (cadrage
// du 2026-11-16, `cadrage/2026-11-16-cadrage-oauth.md` du projet).
//
// Fournisseurs : flux « code d'autorisation » côté serveur, par redirections
// (CSP du site : aucun script tiers). `state` et vérificateur PKCE dans un
// cookie httpOnly de l'API, limité aux routes OAuth et à 10 min : le retour
// n'est accepté que dans le navigateur qui a lancé la connexion. Seules les
// adresses que le fournisseur garantit vérifiées sont prises. GitHub ne sert
// que d'identité : `read:user user:email`, aucun accès aux dépôts (ceux-ci
// restent la connexion séparée de l'app, réservée à Pro).
//
// Rattachement : identité déjà connue → son compte ; sinon compte de même
// adresse (s'il n'avait jamais confirmé son adresse, le mot de passe choisi
// par n'importe qui et ses sessions tombent) ; sinon compte neuf, confirmé,
// sans mot de passe.
//
// App : elle demande un lien (`/app-link`), ouvre le site sur
// `/compte/app/?code=…`, le site connecté l'approuve (`/app-link/approve`),
// l'app récupère sa session (`/app-link/token`). Rien à déclarer côté OS.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { body, COOKIE, sha256, type Account, type Row } from './auth.js';
import { ApiError, type Deps } from './core.js';
import { requestIpKey } from './ip-key.js';

export type Provider = 'google' | 'github';
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}
export interface OAuthConfig {
  google?: OAuthClient;
  github?: OAuthClient;
  /** Remplacé par les tests (faux Google, faux GitHub) ; aucun réseau en test. */
  fetch?: typeof fetch;
}

interface Endpoints {
  authorize: string;
  token: string;
  scope: string;
}
export const ENDPOINTS: Record<Provider, Endpoints> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email', // ni nom ni photo : rien d'autre que l'adresse n'est utile
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    scope: 'read:user user:email',
  },
};
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GITHUB_API = 'https://api.github.com';

export const STATE_COOKIE = 'ds_oauth';
const STATE_MINUTES = 10;
export const LINK_MINUTES = 10;
/** Intervalle conseillé à l'app entre deux demandes de session, en secondes. */
export const LINK_INTERVAL = 2;
/** Liens demandés par heure depuis une même adresse IP, puis tous clients confondus. */
export const LINKS_PER_IP_PER_HOUR = 30;
export const LINKS_PER_HOUR = 600;
/** Codes essayés par compte du site en 10 min (devinette de codes actifs). */
export const APPROVALS_PER_10_MIN = 10;
const LINK_GONE = 'Code inconnu, expiré ou déjà utilisé : relancer la connexion depuis l’app.';
export const LINK_RETYPE =
  'Ce lien a été créé depuis un autre réseau que ce navigateur : saisir le code affiché dans votre DS-Studio. Sans connexion lancée par vous dans DS-Studio, fermer cette page.';
// Code court montré par l'app et le site : sans voyelles ni caractères
// ambigus, 8 caractères (20^8 ≈ 2,6·10^10), valable 10 min.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const userCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/, 'Code de connexion invalide.')
  .transform((v) => (v.includes('-') ? v : `${v.slice(0, 4)}-${v.slice(4)}`));

const b64url = (b: Buffer) => b.toString('base64url');
const newUserCode = () => {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
};

// Refus attendu du fournisseur à l'échange du code (code faux, déjà servi ou
// expiré : 4xx, ou GitHub qui répond 200 avec `error`). Jamais signalé à
// Sentry : un tiers le provoque à volonté (audit du 2026-11-18, n° 4).
// 5xx, réseau, profil illisible : signalés.
class ProviderRefusal extends Error {}
/** Erreurs de l'échange du code dues au seul code (faux, expiré, rejoué) : attendues, jamais signalées. */
const CODE_REFUSALS = new Set(['invalid_grant', 'bad_verification_code']);

/** Ce que le fournisseur garantit : identifiant stable et adresse vérifiée (sinon `null`). */
export interface Identity {
  subject: string;
  email: string | null;
}

// Erreurs renvoyées au site par `?oauth=<code>` (messages dans site/src/scripts/oauth.ts).
type Failure = 'refus' | 'etat' | 'adresse' | 'indisponible' | 'trop' | 'erreur';

interface Kit {
  openSession(accountId: string, client: 'app' | 'site'): Promise<{ token: string; expiresAt: Date }>;
  siteCookie(c: Context, session: { token: string; expiresAt: Date }): void;
  admitSignup(c: Context): Promise<() => void>;
  welcome(accountId: string, on?: Pick<Deps['db'], 'query'>): Promise<void>;
  toAccount(r: Row): Account;
  accountColumns: string;
}

export function oauthRoutes(deps: Deps, kit: Kit) {
  const now = () => (deps.now ?? (() => new Date()))();
  const db = deps.db;
  const config = deps.oauth ?? {};
  const http = config.fetch ?? fetch;
  const routes = new Hono();
  const secure = deps.publicUrl.startsWith('https://');
  // Cookie d'état signé (HMAC-SHA256, audit du 2026-11-18, n° 4) : un état
  // que ce serveur n'a pas émis, ou de plus de 10 min, est refusé avant tout
  // appel au fournisseur. Clé aléatoire par processus, aucune variable de plus
  // dans Render : une seule instance, et un redéploiement ne fait échouer
  // qu'une connexion en cours (`?oauth=etat`, à relancer).
  const stateKey = randomBytes(32);
  const mac = (payload: string) => createHmac('sha256', stateKey).update(payload).digest();
  const sealState = (v: { p: Provider; s: string; v: string; a: string | null }) => {
    const payload = b64url(Buffer.from(JSON.stringify({ ...v, t: now().getTime() })));
    return `${payload}.${b64url(mac(payload))}`;
  };
  const callbackUrl = (p: Provider) => `${deps.publicUrl}/v1/auth/oauth/${p}/callback`;
  const providerOf = (c: Context): Provider => {
    const p = c.req.param('provider');
    if (p !== 'google' && p !== 'github') throw new ApiError('Fournisseur inconnu.', 404);
    return p;
  };

  // Retour vers le site : page Compte (ou page de connexion de l'app), avec
  // l'erreur éventuelle. Sans site (développement) : page minimale de l'API.
  const back = (c: Context, opts: { app?: string; failure?: Failure }) => {
    if (!deps.siteUrl) {
      return opts.failure
        ? c.html(page('Connexion refusée', `Erreur : ${opts.failure}.`), 400)
        : c.html(page('Connecté', 'Session ouverte sur le site.'));
    }
    const url = new URL(opts.app ? '/compte/app/' : '/compte/', deps.siteUrl);
    if (opts.app) url.searchParams.set('code', opts.app);
    if (opts.failure) url.searchParams.set('oauth', opts.failure);
    return c.redirect(url.toString(), 302);
  };

  routes.get('/oauth/:provider/start', async (c) => {
    const provider = providerOf(c);
    const parsedApp = c.req.query('app') ? userCodeSchema.safeParse(c.req.query('app')) : null;
    const app = parsedApp?.success ? parsedApp.data : undefined;
    const client = config[provider];
    if (!client) return back(c, { app, failure: 'indisponible' });
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    setCookie(c, STATE_COOKIE, sealState({ p: provider, s: state, v: verifier, a: app ?? null }), {
      httpOnly: true,
      secure,
      sameSite: 'Lax', // envoyé au retour du fournisseur (navigation de premier niveau)
      path: '/v1/auth/oauth',
      maxAge: STATE_MINUTES * 60,
    });
    const url = new URL(ENDPOINTS[provider].authorize);
    url.searchParams.set('client_id', client.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', ENDPOINTS[provider].scope);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    if (provider === 'google') url.searchParams.set('prompt', 'select_account');
    return c.redirect(url.toString(), 302);
  });

  routes.get('/oauth/:provider/callback', async (c) => {
    const provider = providerOf(c);
    const saved = readState(getCookie(c, STATE_COOKIE));
    deleteCookie(c, STATE_COOKIE, { path: '/v1/auth/oauth' });
    const app = saved?.a ?? undefined;
    if (c.req.query('error')) return back(c, { app, failure: 'refus' }); // annulé chez le fournisseur
    const code = c.req.query('code');
    if (!saved || saved.p !== provider || !code || c.req.query('state') !== saved.s) return back(c, { app, failure: 'etat' });
    const client = config[provider];
    if (!client) return back(c, { app, failure: 'indisponible' });
    let identity: Identity;
    try {
      identity = await fetchIdentity(provider, client, code, saved.v);
    } catch (e) {
      if (!(e instanceof ProviderRefusal)) deps.report?.(e);
      console.warn(`OAuth ${provider} : ${e instanceof Error ? e.message : String(e)}`);
      return back(c, { app, failure: 'erreur' });
    }
    if (!identity.email) return back(c, { app, failure: 'adresse' });
    const who = identity as Identity & { email: string };
    try {
      // Deux retours simultanés pour la même adresse ou la même identité
      // (double clic, deux onglets, formulaire en même temps) : le second
      // bute sur une contrainte d'unicité, rejoue une fois et trouve le compte.
      let accountId: string;
      try {
        accountId = await resolveAccount(c, provider, who);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        accountId = await resolveAccount(c, provider, who);
      }
      kit.siteCookie(c, await kit.openSession(accountId, 'site'));
      return back(c, { app });
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) return back(c, { app, failure: 'trop' });
      deps.report?.(e);
      console.warn(`OAuth ${provider} : ${e instanceof Error ? e.message : String(e)}`);
      return back(c, { app, failure: 'erreur' });
    }
  });

  function readState(raw: string | undefined): { p: Provider; s: string; v: string; a: string | null } | null {
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = raw.slice(0, dot);
    const given = Buffer.from(raw.slice(dot + 1), 'base64url');
    const want = mac(payload);
    // Comparaison à temps constant, longueurs vérifiées d'abord (timingSafeEqual l'exige).
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    try {
      const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      if ((v.p !== 'google' && v.p !== 'github') || typeof v.s !== 'string' || typeof v.v !== 'string') return null;
      // Le `maxAge` du cookie ne lie que le navigateur : l'âge est revérifié ici.
      const age = typeof v.t === 'number' ? now().getTime() - v.t : NaN;
      if (!(age >= 0 && age <= STATE_MINUTES * 60_000)) return null;
      return { p: v.p, s: v.s, v: v.v, a: typeof v.a === 'string' ? v.a : null };
    } catch {
      return null;
    }
  }

  // Code d'autorisation → jeton d'accès → identité. Jeton jamais gardé.
  async function fetchIdentity(provider: Provider, client: OAuthClient, code: string, verifier: string): Promise<Identity> {
    const tokenRes = await http(ENDPOINTS[provider].token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(provider),
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (!tokenRes.ok || !tokenBody.access_token) {
      const detail = `jeton refusé (${tokenRes.status} ${tokenBody.error ?? ''})`.replace(' )', ')');
      // Seul un code faux, expiré ou rejoué est attendu (Google `invalid_grant`
      // en 400, GitHub `bad_verification_code` en 200) : pas de signalement.
      // Un client mal réglé (`invalid_client`, `redirect_uri_mismatch`…) coupe
      // la connexion pour tous : signalé (relecture du 2026-11-19).
      const refused = tokenRes.status < 500 && CODE_REFUSALS.has(tokenBody.error ?? '');
      throw refused ? new ProviderRefusal(detail) : new Error(detail);
    }
    const auth = { authorization: `Bearer ${tokenBody.access_token}` };
    if (provider === 'google') {
      const res = await http(GOOGLE_USERINFO, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`profil Google illisible (${res.status})`);
      const me = (await res.json()) as { sub?: string; email?: string; email_verified?: boolean | string };
      if (!me.sub) throw new Error('profil Google sans identifiant');
      const verified = me.email_verified === true || me.email_verified === 'true';
      return { subject: me.sub, email: verified && me.email ? me.email.trim().toLowerCase() : null };
    }
    const gh = { ...auth, accept: 'application/vnd.github+json', 'user-agent': 'DS-Studio', 'x-github-api-version': '2022-11-28' };
    const [userRes, emailsRes] = await Promise.all([
      http(`${GITHUB_API}/user`, { headers: gh, signal: AbortSignal.timeout(10_000) }),
      http(`${GITHUB_API}/user/emails`, { headers: gh, signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!userRes.ok) throw new Error(`profil GitHub illisible (${userRes.status})`);
    const user = (await userRes.json()) as { id?: number };
    if (typeof user.id !== 'number') throw new Error('profil GitHub sans identifiant');
    const emails = emailsRes.ok ? ((await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[]) : [];
    // L'adresse principale, et seulement si GitHub l'a vérifiée.
    const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
    return { subject: String(user.id), email: primary ? primary.email.trim().toLowerCase() : null };
  }

  async function resolveAccount(c: Context, provider: Provider, identity: { subject: string; email: string }) {
    const known = await db.query<{ account_id: string }>(
      `SELECT i.account_id FROM account_identities i JOIN accounts a ON a.id = i.account_id
        WHERE i.provider = $1 AND i.subject = $2 AND a.deleted_at IS NULL`,
      [provider, identity.subject],
    );
    if (known.rows[0]) {
      await db.query('UPDATE account_identities SET last_used_at = $3, email = $4 WHERE provider = $1 AND subject = $2', [
        provider,
        identity.subject,
        now(),
        identity.email,
      ]);
      return known.rows[0].account_id;
    }
    const existing = await db.query<{ id: string; email_verified_at: Date | string | null }>(
      'SELECT id, email_verified_at FROM accounts WHERE email = $1 AND deleted_at IS NULL',
      [identity.email],
    );
    // Compte neuf : mêmes plafonds que le formulaire, vérifiés hors transaction.
    const counted = existing.rows[0] ? null : await kit.admitSignup(c);
    const accountId = await db.transaction(async (tx) => {
      let id = existing.rows[0]?.id;
      if (id && !existing.rows[0].email_verified_at) {
        // Adresse jamais confirmée : le fournisseur prouve qu'elle est à
        // cette personne ; le mot de passe posé par n'importe qui tombe.
        // Relu dans la transaction : confirmée par mail entre-temps, rien ne tombe.
        const taken = await tx.query(
          'UPDATE accounts SET email_verified_at = $2, password_hash = NULL WHERE id = $1 AND email_verified_at IS NULL RETURNING id',
          [id, now()],
        );
        if (taken.rows.length) {
          await tx.query('DELETE FROM sessions WHERE account_id = $1', [id]);
          await tx.query('DELETE FROM app_links WHERE account_id = $1', [id]);
          await tx.query('DELETE FROM email_tokens WHERE account_id = $1', [id]);
          await kit.welcome(id, tx);
        }
      }
      if (!id) {
        const created = await tx.query<{ id: string }>(
          'INSERT INTO accounts (email, password_hash, email_verified_at, created_at, last_active_at) VALUES ($1, NULL, $2, $2, $2) RETURNING id',
          [identity.email, now()],
        );
        id = created.rows[0].id;
        await kit.welcome(id, tx);
      }
      const linked = await tx.query(
        `INSERT INTO account_identities (provider, subject, account_id, email, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (provider, subject) DO NOTHING RETURNING account_id`,
        [provider, identity.subject, id, identity.email, now()],
      );
      // Identité liée entre-temps par une autre requête : tout est annulé
      // (pas de compte en double) et l'appelant rejoue.
      if (!linked.rows.length) throw Object.assign(new Error('Identité liée entre-temps.'), { code: '23505' });
      return id;
    });
    counted?.();
    return accountId;
  }

  // --- Connexion de l'app par le site ---

  // shortcut: compteurs en mémoire, exacts pour une seule instance Render
  // (revoir avant plusieurs instances) ; IP falsifiable par l'URL onrender.com
  // tant que le secret d'origine n'est pas en refus. Plafond global en base.
  const linksByIp = new Map<string, number[]>();
  // Réseau de la requête : empreinte de `CF-Connecting-IP` (null sans en-tête,
  // en développement), pays de `CF-IPCountry` s'il est lisible.
  const ipHashOf = (c: Context) => {
    const ip = c.req.header('cf-connecting-ip');
    return ip ? sha256(`ip:${ip}`) : null;
  };
  const countryOf = (c: Context) => {
    const v = c.req.header('cf-ipcountry')?.toUpperCase() ?? '';
    return /^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1' ? v : null;
  };
  routes.post('/app-link', async (c) => {
    const ip = requestIpKey(c); // par /64 en IPv6 (ip-key.ts)
    const since = now().getTime() - 3600_000;
    const mine = (linksByIp.get(ip) ?? []).filter((at) => at > since);
    if (mine.length >= LINKS_PER_IP_PER_HOUR) throw new ApiError('Trop de demandes de connexion depuis cette connexion : réessayer dans une heure.', 429);
    const recent = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM app_links WHERE created_at > $1', [new Date(since)]);
    if (recent.rows[0].n >= LINKS_PER_HOUR) throw new ApiError('Trop de demandes de connexion en ce moment : réessayer dans quelques minutes.', 429);
    if (linksByIp.size > 10_000) for (const [key, list] of linksByIp) if (!list.some((at) => at > since)) linksByIp.delete(key);
    linksByIp.set(ip, [...mine, now().getTime()]);
    const deviceCode = b64url(randomBytes(32));
    const expiresAt = new Date(now().getTime() + LINK_MINUTES * 60_000);
    let userCode = '';
    for (let attempt = 0; attempt < 5 && !userCode; attempt++) {
      const candidate = newUserCode();
      const inserted = await db.query(
        `INSERT INTO app_links (device_hash, user_code, created_at, expires_at, ip_hash, country) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_code) DO NOTHING RETURNING user_code`,
        [sha256(deviceCode), candidate, now(), expiresAt, ipHashOf(c), countryOf(c)],
      );
      if (inserted.rows.length) userCode = candidate;
    }
    if (!userCode) throw new ApiError('Code de connexion indisponible : réessayer.', 503);
    const base = deps.siteUrl ?? deps.publicUrl;
    return c.json({
      deviceCode,
      userCode,
      url: `${base}/compte/app/?code=${userCode}`,
      expiresAt: expiresAt.toISOString(),
      interval: LINK_INTERVAL,
    });
  });

  // Le site connecté approuve le code montré par l'app (cookie du site). Un
  // seul message pour inconnu, expiré et déjà servi, et des essais comptés
  // par compte : on ne devine pas un code actif. Code venu du lien (un clic) :
  // accepté seulement si le navigateur est sur le réseau qui a créé le code,
  // sinon 409 et le site fait saisir le code (`typed`), lu dans l'app : un
  // lien envoyé par un tiers ne suffit plus. Chaque liaison prévient par mail.
  // Risque accepté par Romain le 2026-11-16 (AGENTS.md, « Connexion Google et GitHub »).
  const approvalsByAccount = new Map<string, number[]>(); // shortcut: en mémoire, comme ci-dessus
  routes.post('/app-link/approve', async (c) => {
    const account = await requireSiteAccount(c);
    const since = now().getTime() - 600_000;
    const tries = (approvalsByAccount.get(account.id) ?? []).filter((at) => at > since);
    if (tries.length >= APPROVALS_PER_10_MIN) throw new ApiError('Trop d’essais : réessayer dans quelques minutes.', 429);
    if (approvalsByAccount.size > 10_000) for (const [key, list] of approvalsByAccount) if (!list.some((at) => at > since)) approvalsByAccount.delete(key);
    approvalsByAccount.set(account.id, [...tries, now().getTime()]);
    const { code, typed } = await body(c, z.object({ code: userCodeSchema, typed: z.boolean().optional() }));
    const at = now();
    const found = await db.query<{ ip_hash: string | null }>(
      'SELECT ip_hash FROM app_links WHERE user_code = $1 AND approved_at IS NULL AND expires_at > $2',
      [code, at],
    );
    if (!found.rows.length) throw new ApiError(LINK_GONE, 410);
    const here = ipHashOf(c);
    if (!typed && (!here || found.rows[0].ip_hash !== here)) throw new ApiError(LINK_RETYPE, 409);
    const done = await db.query<{ country: string | null }>(
      'UPDATE app_links SET account_id = $2, approved_at = $3 WHERE user_code = $1 AND approved_at IS NULL AND expires_at > $3 RETURNING country',
      [code, account.id, at],
    );
    if (!done.rows.length) throw new ApiError(LINK_GONE, 410);
    await alertLinked(account.id, at, done.rows[0].country);
    return c.json({ ok: true, message: 'App connectée : retourner dans DS-Studio.' });
  });

  // Mail à chaque app connectée : la victime d'un lien piégé le voit tout de
  // suite. Un échec d'envoi ne défait pas la liaison (signalé à Sentry).
  async function alertLinked(accountId: string, at: Date, country: string | null) {
    try {
      const { rows } = await db.query<{ email: string }>('SELECT email FROM accounts WHERE id = $1', [accountId]);
      if (!rows[0]) return;
      const when = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(at);
      await deps.mailer.send({
        to: rows[0].email,
        subject: 'DS-Studio : nouvelle app connectée à votre compte',
        text:
          `Bonjour,\n\nUne app DS-Studio vient d’être connectée à votre compte le ${when} (heure de Paris)` +
          `${country ? `, depuis une connexion située dans le pays « ${country} »` : ''}.\n\n` +
          'Si c’était vous, rien à faire. Sinon, choisir un nouveau mot de passe avec « mot de passe oublié », ' +
          'sur le site ou dans l’app : toutes les sessions de votre compte, celle de cette app comprise, seront coupées.',
      });
    } catch (e) {
      deps.report?.(e);
    }
  }

  // L'app demande sa session : en attente (202), refusée (410), ou remise une seule fois.
  // shortcut: sans plafond (deviceCode de 256 bits, une requête indexée par
  // appel) ; en ajouter un par IP si les journaux montrent un abus.
  routes.post('/app-link/token', async (c) => {
    const { deviceCode } = await body(c, z.object({ deviceCode: z.string().min(20).max(100) }));
    const { rows } = await db.query<{ account_id: string | null; expires_at: Date | string; approved_at: Date | string | null }>(
      'SELECT account_id, expires_at, approved_at FROM app_links WHERE device_hash = $1',
      [sha256(deviceCode)],
    );
    const link = rows[0];
    if (!link || new Date(link.expires_at) <= now()) throw new ApiError('Connexion expirée : la relancer depuis l’app.', 410);
    if (!link.approved_at || !link.account_id) return c.json({ pending: true }, 202);
    // Usage unique : seul le premier appel qui retire le lien reçoit la session.
    const taken = await db.query('DELETE FROM app_links WHERE device_hash = $1 RETURNING device_hash', [sha256(deviceCode)]);
    if (!taken.rows.length) throw new ApiError('Connexion expirée : la relancer depuis l’app.', 410);
    const session = await kit.openSession(link.account_id, 'app');
    const account = await db.query<Row>(`SELECT ${kit.accountColumns} FROM accounts WHERE id = $1`, [link.account_id]);
    return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString(), account: kit.toAccount(account.rows[0]) });
  });

  // Compte de la session du site (cookie) ; les sessions de l'app n'approuvent pas.
  async function requireSiteAccount(c: Context) {
    const token = getCookie(c, COOKIE);
    if (!token) throw new ApiError('Connexion requise : se connecter sur le site.', 401);
    const { rows } = await db.query<{ account_id: string; expires_at: Date | string }>(
      `SELECT s.account_id, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.client = 'site' AND a.deleted_at IS NULL`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at) <= now()) throw new ApiError('Session expirée : se reconnecter sur le site.', 401);
    return { id: row.account_id };
  }

  return routes;
}

const isUniqueViolation = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';

const page = (title: string, text: string) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>DS-Studio · ${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
