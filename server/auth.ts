// Comptes, sessions et jetons de mail (étape 2.2 du lot 2). Mot de passe +
// adresse vérifiée ; session = jeton aléatoire porté en `Authorization:
// Bearer` (app) ou en cookie `ds_session` (site), dont seule l'empreinte est
// en base. Les jetons de mail sont à usage unique et datés. Aucune
// énumération silencieuse : les messages disent ce qui se passe, l'audience
// est celle d'un outil de designers, Cloudflare limite le débit devant.
import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { ApiError, type Deps } from './core.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { addCredits, WELCOME_CENTS } from './credits.js';

export interface Account {
  id: string;
  email: string;
  plan: 'free' | 'pro';
  gifted: boolean;
  dailyCapCents: number;
  /** Crédits prépayés restants, centimes d'euro (lot 4) ; un appel peut les passer sous zéro. */
  creditCents: number;
  /** Crédits inclus chaque mois dans Pro, centimes d'euro. */
  monthlyIncludedCents: number;
  emailVerifiedAt: string | null;
  createdAt: string;
  /** Stripe (lot 4) : client et abonnement, `null` tant que le compte n'a rien acheté. */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** Statut Stripe de l'abonnement (active, trialing, past_due, canceled…). */
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Début de la période des crédits inclus Pro (remis à chaque facture payée) ; `null` : mois civil UTC. */
  includedSince: string | null;
  /** Crédit de bienvenue posé, à la confirmation du mail. */
  welcomeCreditedAt: string | null;
}
export interface Session {
  tokenHash: string;
  client: 'app' | 'site';
  expiresAt: Date;
}

export const SESSION_DAYS = 30;
export const VERIFY_HOURS = 24;
export const RESET_HOURS = 1;
export const COOKIE = 'ds_session';

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Adresse mail invalide.')
  .max(200);
const passwordSchema = z
  .string()
  .min(10, 'Mot de passe trop court : 10 caractères au moins.')
  .max(200, 'Mot de passe trop long.');
const clientSchema = z.enum(['app', 'site']).default('app');

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const hours = (n: number) => n * 3600_000;
const days = (n: number) => n * 86400_000;

// Lecture du corps avec un message d'erreur lisible plutôt qu'une pile Zod.
export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Requête invalide.', 400);
  return parsed.data;
}

type Row = {
  id: string;
  email: string;
  password_hash: string;
  plan: 'free' | 'pro';
  gifted: boolean;
  daily_cap_cents: number;
  credit_cents: number;
  monthly_included_cents: number;
  email_verified_at: Date | string | null;
  created_at: Date | string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  current_period_end: Date | string | null;
  cancel_at_period_end: boolean;
  included_since: Date | string | null;
  welcome_credited_at: Date | string | null;
};
const iso = (v: Date | string | null) => (v == null ? null : new Date(v).toISOString());
const toAccount = (r: Row): Account => ({
  id: r.id,
  email: r.email,
  plan: r.plan,
  gifted: r.gifted,
  dailyCapCents: r.daily_cap_cents,
  creditCents: Number(r.credit_cents),
  monthlyIncludedCents: r.monthly_included_cents,
  emailVerifiedAt: iso(r.email_verified_at),
  createdAt: iso(r.created_at) as string,
  stripeCustomerId: r.stripe_customer_id,
  stripeSubscriptionId: r.stripe_subscription_id,
  subscriptionStatus: r.subscription_status,
  currentPeriodEnd: iso(r.current_period_end),
  cancelAtPeriodEnd: r.cancel_at_period_end,
  includedSince: iso(r.included_since),
  welcomeCreditedAt: iso(r.welcome_credited_at),
});

const ACCOUNT_COLUMNS =
  'id, email, password_hash, plan, gifted, daily_cap_cents, credit_cents, monthly_included_cents, email_verified_at, created_at, ' +
  'stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, cancel_at_period_end, included_since, welcome_credited_at';

export function authRoutes(deps: Deps) {
  const now = () => (deps.now ?? (() => new Date()))();
  const db = deps.db;

  async function accountByEmail(email: string) {
    const { rows } = await db.query<Row>(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE email = $1`, [email]);
    return rows[0];
  }

  async function issueEmailToken(accountId: string, purpose: 'verify' | 'reset') {
    const token = newToken();
    const ttl = purpose === 'verify' ? hours(VERIFY_HOURS) : hours(RESET_HOURS);
    await db.query('INSERT INTO email_tokens (token_hash, account_id, purpose, expires_at) VALUES ($1, $2, $3, $4)', [
      sha256(token),
      accountId,
      purpose,
      new Date(now().getTime() + ttl),
    ]);
    return token;
  }

  // Jeton de mail valide (bon usage, non consommé, non expiré) → compte ; le marque utilisé.
  async function consumeEmailToken(token: string, purpose: 'verify' | 'reset') {
    const { rows } = await db.query<{ account_id: string; expires_at: Date | string; used_at: Date | string | null }>(
      'SELECT account_id, expires_at, used_at FROM email_tokens WHERE token_hash = $1 AND purpose = $2',
      [sha256(token), purpose],
    );
    const row = rows[0];
    if (!row || row.used_at) throw new ApiError('Lien invalide ou déjà utilisé. Demande un nouveau lien.', 400);
    if (new Date(row.expires_at) <= now()) throw new ApiError('Lien expiré. Demande un nouveau lien.', 400);
    await db.query('UPDATE email_tokens SET used_at = $2 WHERE token_hash = $1', [sha256(token), now()]);
    return row.account_id;
  }

  async function sendVerification(account: { id: string; email: string }) {
    const token = await issueEmailToken(account.id, 'verify');
    // Site en ligne : page de confirmation du site (POST /verify) ; sinon la page minimale de l'API.
    const link = deps.siteUrl ? `${deps.siteUrl}/compte/verifier/?token=${token}` : `${deps.publicUrl}/v1/auth/verify?token=${token}`;
    await deps.mailer.send({
      to: account.email,
      subject: 'DS-Studio : confirme ton adresse',
      text: `Bonjour,\n\nPour activer ton compte DS-Studio, ouvre ce lien (valable ${VERIFY_HOURS} h) :\n${link}\n\nSi tu n’es pas à l’origine de cette demande, ignore ce mail.`,
    });
  }

  async function openSession(accountId: string, client: 'app' | 'site') {
    const token = newToken();
    const expiresAt = new Date(now().getTime() + days(SESSION_DAYS));
    await db.query(
      'INSERT INTO sessions (token_hash, account_id, client, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $4, $5)',
      [sha256(token), accountId, client, now(), expiresAt],
    );
    await markActive(db, accountId, now());
    return { token, expiresAt };
  }

  const auth = new Hono();

  auth.post('/signup', async (c) => {
    const data = await body(c, z.object({ email: emailSchema, password: passwordSchema }));
    if (await accountByEmail(data.email)) throw new ApiError('Un compte existe déjà avec cette adresse. Connecte-toi ou utilise « mot de passe oublié ».', 409);
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO accounts (email, password_hash, created_at, last_active_at) VALUES ($1, $2, $3, $3) RETURNING id',
      [data.email, await hashPassword(data.password), now()],
    );
    await sendVerification({ id: rows[0].id, email: data.email });
    return c.json({ ok: true, message: 'Compte créé : un mail de confirmation vient de partir.' }, 201);
  });

  auth.post('/resend', async (c) => {
    const { email } = await body(c, z.object({ email: emailSchema }));
    const account = await accountByEmail(email);
    if (account && !account.email_verified_at) await sendVerification(account);
    return c.json({ ok: true, message: 'Si un compte non confirmé existe à cette adresse, un nouveau mail vient de partir.' });
  });

  const verify = async (token: string) => {
    const accountId = await consumeEmailToken(token, 'verify');
    await db.query('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [accountId, now()]);
    // Crédit de bienvenue (lot 4) : une génération, posée une seule fois par compte.
    if (await addCredits(db, { accountId, deltaCents: WELCOME_CENTS, reason: 'welcome', ref: `welcome:${accountId}`, now: now() }))
      await db.query('UPDATE accounts SET welcome_credited_at = $2 WHERE id = $1', [accountId, now()]);
  };
  auth.post('/verify', async (c) => {
    const { token } = await body(c, z.object({ token: z.string().min(10) }));
    await verify(token);
    return c.json({ ok: true, message: 'Adresse confirmée. Tu peux te connecter.' });
  });
  // Lien du mail ouvert dans un navigateur : une page minimale, sans site vitrine (lot 7).
  auth.get('/verify', async (c) => {
    const token = c.req.query('token') ?? '';
    try {
      await verify(token);
      return c.html(htmlPage('Adresse confirmée', 'Ton compte DS-Studio est actif. Retourne dans l’application pour te connecter.'));
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Erreur inattendue.';
      return c.html(htmlPage('Lien refusé', message), e instanceof ApiError ? (e.status as 400) : 500);
    }
  });

  auth.post('/login', async (c) => {
    const data = await body(c, z.object({ email: emailSchema, password: passwordSchema.or(z.string()), client: clientSchema }));
    const account = await accountByEmail(data.email);
    if (!account || !(await verifyPassword(data.password, account.password_hash))) throw new ApiError('Adresse ou mot de passe incorrect.', 401);
    if (!account.email_verified_at) throw new ApiError('Adresse non confirmée : ouvre le lien reçu par mail (ou demande-en un nouveau).', 403);
    const session = await openSession(account.id, data.client);
    if (data.client === 'site') {
      setCookie(c, COOKIE, session.token, {
        httpOnly: true,
        secure: deps.publicUrl.startsWith('https://'),
        sameSite: 'Lax',
        path: '/',
        expires: session.expiresAt,
        ...(deps.cookieDomain ? { domain: deps.cookieDomain } : {}),
      });
      // Le site ne voit jamais le jeton : il vit dans le cookie httpOnly seul.
      return c.json({ expiresAt: session.expiresAt.toISOString(), account: toAccount(account) });
    }
    return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString(), account: toAccount(account) });
  });

  auth.post('/forgot', async (c) => {
    const { email } = await body(c, z.object({ email: emailSchema }));
    const account = await accountByEmail(email);
    if (account) {
      const token = await issueEmailToken(account.id, 'reset');
      await deps.mailer.send({
        to: account.email,
        subject: 'DS-Studio : nouveau mot de passe',
        text: `Bonjour,\n\nPour choisir un nouveau mot de passe DS-Studio, utilise ce code dans l’application (valable ${RESET_HOURS} h) :\n${token}\n\nSi tu n’es pas à l’origine de cette demande, ignore ce mail : rien ne change.`,
      });
    }
    return c.json({ ok: true, message: 'Si un compte existe à cette adresse, un mail vient de partir.' });
  });

  auth.post('/reset', async (c) => {
    const data = await body(c, z.object({ token: z.string().min(10), password: passwordSchema }));
    const accountId = await consumeEmailToken(data.token, 'reset');
    await db.query('UPDATE accounts SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, $3) WHERE id = $1', [
      accountId,
      await hashPassword(data.password),
      now(),
    ]);
    // Toute session ouverte avec l'ancien mot de passe tombe.
    await db.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
    return c.json({ ok: true, message: 'Mot de passe changé. Reconnecte-toi.' });
  });

  auth.post('/logout', async (c) => {
    const token = bearer(c);
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    deleteCookie(c, COOKIE, { path: '/', ...(deps.cookieDomain ? { domain: deps.cookieDomain } : {}) });
    return c.body(null, 204);
  });

  return auth;
}

// Activité du compte (durées de conservation, server/retention.ts) : une
// connexion ou une requête authentifiée repousse la suppression pour
// inactivité et annule l'avertissement déjà parti.
async function markActive(db: Pick<Deps['db'], 'query'>, accountId: string, at: Date) {
  await db.query('UPDATE accounts SET last_active_at = $2, inactivity_warned_at = NULL WHERE id = $1', [accountId, at]);
}

const bearer = (c: Context) => {
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return getCookie(c, COOKIE) ?? null;
};

// Compte de la session portée par la requête, ou 401. Prolonge la session
// (glissante) au plus une fois par heure.
export function requireAccount(deps: Deps) {
  const now = () => (deps.now ?? (() => new Date()))();
  return async (c: Context): Promise<Account> => {
    const token = bearer(c);
    if (!token) throw new ApiError('Connexion requise.', 401);
    const { rows } = await deps.db.query<Row & { expires_at: Date | string; last_seen_at: Date | string; token_hash: string }>(
      `SELECT a.${ACCOUNT_COLUMNS.split(', ').join(', a.')}, s.expires_at, s.last_seen_at, s.token_hash
       FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row || new Date(row.expires_at) <= now()) throw new ApiError('Session expirée : reconnecte-toi.', 401);
    if (now().getTime() - new Date(row.last_seen_at).getTime() > hours(1)) {
      await deps.db.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE token_hash = $1', [
        row.token_hash,
        now(),
        new Date(now().getTime() + days(SESSION_DAYS)),
      ]);
      await markActive(deps.db, row.id as string, now());
    }
    return toAccount(row);
  };
}

export const htmlPage = (title: string, text: string) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DS-Studio · ${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#0b0b0c;color:#f2f1ec;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:2rem}h1{color:#e8ff3a;font-size:1.4rem}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
