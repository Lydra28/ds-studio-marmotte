import assert from 'node:assert/strict';
import test from 'node:test';
import { APPROVALS_PER_10_MIN, ENDPOINTS, GITHUB_API, GOOGLE_USERINFO, LINK_MINUTES, LINK_RETYPE, STATE_COOKIE } from '../../server/oauth.js';
import { purge } from '../../server/retention.js';
import { createHash } from 'node:crypto';
import { connect, lastToken, testApp, type TestApp } from './helpers.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Connexion avec Google et GitHub (cadrage du 2026-11-16) contre de faux
// fournisseurs : aucun réseau. Le navigateur est simulé à la main (cookies
// recopiés d'une réponse à l'autre).

const SITE = 'http://site.test';

interface FakeUser {
  sub?: string;
  id?: number;
  email?: string;
  verified?: boolean;
  /** GitHub : adresses renvoyées par /user/emails. */
  emails?: { email: string; primary: boolean; verified: boolean }[];
}

function fakeProviders() {
  const state = {
    google: { sub: 'g-1', email: 'pro@example.com', verified: true } as FakeUser,
    github: { id: 42, emails: [{ email: 'dev@example.com', primary: true, verified: true }] } as FakeUser,
    tokenStatus: 200,
  };
  const seen: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, body: init?.body ? String(init.body) : '' });
    if (u === ENDPOINTS.google.token || u === ENDPOINTS.github.token)
      return state.tokenStatus === 200 ? Response.json({ access_token: 'jeton-du-fournisseur' }) : Response.json({ error: 'bad_verification_code' }, { status: state.tokenStatus });
    if (u === GOOGLE_USERINFO) {
      const g = state.google;
      return Response.json({ sub: g.sub, email: g.email, email_verified: g.verified });
    }
    if (u === `${GITHUB_API}/user`) return Response.json({ id: state.github.id, login: 'dev' });
    if (u === `${GITHUB_API}/user/emails`) return Response.json(state.github.emails ?? []);
    return new Response('inconnu', { status: 404 });
  }) as typeof fetch;
  return { state, seen, fetch: fetchImpl };
}

async function setup(report?: (e: unknown) => void) {
  const fake = fakeProviders();
  const t = await testApp({
    report,
    siteUrl: SITE,
    oauth: {
      google: { clientId: 'google-id', clientSecret: 'google-secret' },
      github: { clientId: 'github-id', clientSecret: 'github-secret' },
      fetch: fake.fetch,
    },
  });
  return { t, fake };
}

const cookieOf = (headers: Headers, name: string) => {
  for (const line of headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [k, ...v] = pair.split('=');
    if (k.trim() === name) return v.join('=');
  }
  return undefined;
};

// Aller-retour complet chez le fournisseur ; renvoie la redirection finale et le cookie de session.
async function signIn(t: TestApp, provider: 'google' | 'github', opts: { app?: string; tamper?: boolean; deny?: boolean } = {}) {
  const start = await t.api(`/v1/auth/oauth/${provider}/start${opts.app ? `?app=${opts.app}` : ''}`);
  assert.equal(start.status, 302);
  const to = new URL(String(start.headers.get('location')));
  const stateCookie = cookieOf(start.headers, STATE_COOKIE);
  assert.ok(stateCookie, 'cookie d’état posé');
  const state = to.searchParams.get('state');
  const query = opts.deny ? `error=access_denied&state=${state}` : `code=code-du-fournisseur&state=${opts.tamper ? 'autre' : state}`;
  const back = await t.api(`/v1/auth/oauth/${provider}/callback?${query}`, { headers: { cookie: `${STATE_COOKIE}=${stateCookie}` } });
  assert.equal(back.status, 302);
  return { start: to, location: new URL(String(back.headers.get('location'))), session: cookieOf(back.headers, 'ds_session') };
}

const me = (t: TestApp, session: string) => t.api('/v1/me', { headers: { cookie: `ds_session=${session}` } });

test('oauth : Google crée un compte confirmé, sans mot de passe, crédit de bienvenue, puis le retrouve', async () => {
  const { t, fake } = await setup();
  try {
    const first = await signIn(t, 'google');
    // Départ : client, retour, PKCE, choix du compte Google.
    assert.equal(first.start.origin + first.start.pathname, ENDPOINTS.google.authorize);
    assert.equal(first.start.searchParams.get('client_id'), 'google-id');
    assert.equal(first.start.searchParams.get('redirect_uri'), 'http://server.test/v1/auth/oauth/google/callback');
    assert.equal(first.start.searchParams.get('scope'), 'openid email');
    assert.equal(first.start.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(first.location.toString(), `${SITE}/compte/`);
    assert.ok(first.session, 'session du site posée');
    // Échange du code : secret et vérificateur PKCE envoyés au fournisseur, jamais au navigateur.
    const exchange = fake.seen.find((s) => s.url === ENDPOINTS.google.token);
    assert.match(String(exchange?.body), /client_secret=google-secret/);
    assert.match(String(exchange?.body), /code_verifier=/);

    const account = await me(t, first.session!);
    assert.equal(account.status, 200);
    assert.equal(account.body.email, 'pro@example.com');
    const row = await t.db.query<{ password_hash: string | null; email_verified_at: unknown; welcome_credited_at: unknown }>(
      'SELECT password_hash, email_verified_at, welcome_credited_at FROM accounts WHERE email = $1',
      ['pro@example.com'],
    );
    assert.equal(row.rows[0].password_hash, null);
    assert.ok(row.rows[0].email_verified_at, 'adresse confirmée par Google');
    assert.ok(row.rows[0].welcome_credited_at, 'crédit de bienvenue');

    // Connexion par mot de passe : refus qui dit quoi faire.
    const login = await t.api('/v1/auth/login', { json: { email: 'pro@example.com', password: 'nimporte-quoi-123' } });
    assert.equal(login.status, 401);
    assert.match(String(login.body.error), /Google ou GitHub.*mot de passe oublié/);

    // Même identité, adresse changée chez Google : même compte, aucun doublon.
    fake.state.google.email = 'pro.nouveau@example.com';
    const second = await signIn(t, 'google');
    assert.equal((await me(t, second.session!)).body.email, 'pro@example.com');
    assert.equal((await t.db.query('SELECT id FROM accounts')).rows.length, 1);

    // Mot de passe ajouté par « mot de passe oublié » : les deux marchent.
    await t.api('/v1/auth/forgot', { json: { email: 'pro@example.com' } });
    const reset = await t.api('/v1/auth/reset', { json: { token: lastToken(t.mailer, 'pro@example.com'), password: 'un-mot-de-passe-solide' } });
    assert.equal(reset.status, 200);
    assert.equal((await t.api('/v1/auth/login', { json: { email: 'pro@example.com', password: 'un-mot-de-passe-solide' } })).status, 200);
  } finally {
    await t.close();
  }
});

test('oauth : rattachement à un compte existant de même adresse', async () => {
  const { t, fake } = await setup();
  try {
    const user = { email: 'pro@example.com', password: 'un-mot-de-passe-solide' };
    await connect(t, user);
    const before = await t.db.query<{ id: string }>('SELECT id FROM accounts');
    const { session } = await signIn(t, 'google');
    assert.equal((await me(t, session!)).status, 200);
    const after = await t.db.query<{ id: string }>('SELECT id FROM accounts');
    assert.deepEqual(after.rows, before.rows, 'même compte');
    assert.equal((await t.api('/v1/auth/login', { json: user })).status, 200, 'mot de passe gardé (adresse déjà confirmée)');

    // GitHub à la même adresse : même compte aussi.
    fake.state.github.emails = [{ email: 'pro@example.com', primary: true, verified: true }];
    const gh = await signIn(t, 'github');
    assert.equal((await me(t, gh.session!)).body.email, 'pro@example.com');
    assert.equal((await t.db.query('SELECT id FROM accounts')).rows.length, 1);
  } finally {
    await t.close();
  }
});

test('oauth : compte jamais confirmé à la même adresse → mot de passe et lien de confirmation tombent', async () => {
  const { t } = await setup();
  try {
    // Quelqu'un a inscrit l'adresse du pro avec son propre mot de passe.
    const squatter = { email: 'pro@example.com', password: 'mot-de-passe-du-squatteur' };
    await t.api('/v1/auth/signup', { json: squatter });
    const pending = lastToken(t.mailer, 'pro@example.com');
    const { session } = await signIn(t, 'google');
    assert.equal((await me(t, session!)).status, 200);
    const login = await t.api('/v1/auth/login', { json: squatter });
    assert.equal(login.status, 401, 'mot de passe du squatteur effacé');
    assert.equal((await t.api('/v1/auth/verify', { json: { token: pending } })).status, 400, 'lien de confirmation retiré');
  } finally {
    await t.close();
  }
});

// Relecture du lot serveur : deux retours simultanés (double clic, deux
// onglets) ne créent qu'un compte et finissent tous deux connectés.
test('oauth : deux retours simultanés pour une adresse neuve → un seul compte, deux sessions', async () => {
  const { t } = await setup();
  try {
    const [a, b] = await Promise.all([signIn(t, 'google'), signIn(t, 'google')]);
    assert.equal(a.location.toString(), `${SITE}/compte/`);
    assert.equal(b.location.toString(), `${SITE}/compte/`);
    assert.equal((await me(t, a.session!)).status, 200);
    assert.equal((await me(t, b.session!)).status, 200);
    assert.equal((await t.db.query('SELECT id FROM accounts')).rows.length, 1);
    assert.equal((await t.db.query('SELECT 1 FROM account_identities')).rows.length, 1);
  } finally {
    await t.close();
  }
});

test('oauth : adresse non vérifiée, état faux, refus, fournisseur absent ou en panne', async () => {
  const { t, fake } = await setup();
  try {
    fake.state.google.verified = false;
    assert.equal((await signIn(t, 'google')).location.searchParams.get('oauth'), 'adresse');
    fake.state.github.emails = [
      { email: 'dev@example.com', primary: true, verified: false },
      { email: 'autre@example.com', primary: false, verified: true },
    ];
    assert.equal((await signIn(t, 'github')).location.searchParams.get('oauth'), 'adresse', 'seulement l’adresse principale vérifiée');
    assert.equal((await t.db.query('SELECT id FROM accounts')).rows.length, 0, 'aucun compte créé');

    fake.state.google.verified = true;
    const tampered = await signIn(t, 'google', { tamper: true });
    assert.equal(tampered.location.searchParams.get('oauth'), 'etat');
    assert.equal(tampered.session, undefined);
    // Retour sans le cookie du navigateur qui a lancé la connexion.
    const lone = await t.api('/v1/auth/oauth/google/callback?code=x&state=y');
    assert.equal(new URL(String(lone.headers.get('location'))).searchParams.get('oauth'), 'etat');

    assert.equal((await signIn(t, 'google', { deny: true })).location.searchParams.get('oauth'), 'refus');

    fake.state.tokenStatus = 400;
    assert.equal((await signIn(t, 'google')).location.searchParams.get('oauth'), 'erreur');

    const bare = await testApp({ siteUrl: SITE });
    try {
      const start = await bare.api('/v1/auth/oauth/github/start');
      assert.equal(String(start.headers.get('location')), `${SITE}/compte/?oauth=indisponible`);
    } finally {
      await bare.close();
    }
    assert.equal((await t.api('/v1/auth/oauth/apple/start')).status, 404);
  } finally {
    await t.close();
  }
});

test('oauth : GitHub ne demande aucun accès aux dépôts', async () => {
  const { t } = await setup();
  try {
    const { start, session } = await signIn(t, 'github');
    assert.equal(start.searchParams.get('scope'), 'read:user user:email');
    assert.doesNotMatch(String(start.searchParams.get('scope')), /repo/);
    assert.equal((await me(t, session!)).body.email, 'dev@example.com');
  } finally {
    await t.close();
  }
});

const HOME = '203.0.113.5';
const ELSEWHERE = '198.51.100.7';

test('app : lien venu d’un autre réseau → code à saisir ; chaque liaison prévient par mail', async () => {
  const { t } = await setup();
  try {
    const { session } = await signIn(t, 'google');
    const link = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': ELSEWHERE, 'cf-ipcountry': 'BE' } });
    const { deviceCode, userCode } = link.body as { deviceCode: string; userCode: string };
    const approve = (ip: string | null, typed?: boolean) =>
      t.api('/v1/auth/app-link/approve', {
        json: typed === undefined ? { code: userCode } : { code: userCode, typed },
        headers: { cookie: `ds_session=${session}`, origin: SITE, ...(ip ? { 'cf-connecting-ip': ip } : {}) },
      });

    // Un clic depuis un autre réseau, ou sans réseau connu : refus, code intact.
    const other = await approve(HOME);
    assert.equal(other.status, 409);
    assert.equal(other.body.error, LINK_RETYPE);
    assert.equal((await approve(null)).status, 409, 'réseau inconnu : saisie exigée');
    assert.equal((await approve(HOME, false)).status, 409);
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode } })).status, 202, 'toujours en attente');
    assert.equal(t.mailer.sent.filter((m) => /nouvelle app/.test(m.subject)).length, 0);

    // Code saisi (lu dans l'app) : accepté quel que soit le réseau.
    const typed = await approve(HOME, true);
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode } })).status, 200);
    const [mail] = t.mailer.sent.filter((m) => /nouvelle app connectée/.test(m.subject));
    assert.equal(mail.to, 'pro@example.com');
    assert.match(mail.text, /« BE »/);
    assert.match(mail.text, /mot de passe oublié/);
    assert.doesNotMatch(mail.text, new RegExp(ELSEWHERE.replace(/\./g, '\\.')), 'jamais l’adresse IP dans le mail');

    // Code servi, inventé ou expiré : 410, avant tout contrôle de réseau.
    assert.equal((await approve(HOME)).status, 410, 'code servi');
    const raw = (code: string) =>
      t.api('/v1/auth/app-link/approve', { json: { code }, headers: { cookie: `ds_session=${session}`, origin: SITE, 'cf-connecting-ip': HOME } });
    assert.equal((await raw('BCDF-GHJK')).status, 410, 'code inventé');
    const old = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': ELSEWHERE } });
    await t.db.query('UPDATE app_links SET expires_at = $2 WHERE user_code = $1', [old.body.userCode, new Date(t.now().getTime() - 1000)]);
    assert.equal((await raw(String(old.body.userCode))).status, 410, 'code expiré');

    // Rien n'est gardé de l'adresse IP en clair : empreinte seule ; pays filtré.
    const kept = await t.db.query<{ ip_hash: string; country: string | null }>('SELECT ip_hash, country FROM app_links WHERE user_code = $1', [old.body.userCode]);
    assert.equal(kept.rows[0].ip_hash, sha256(`ip:${ELSEWHERE}`));
    assert.equal(kept.rows[0].country, null, 'sans CF-IPCountry');
    for (const country of ['XX', 'T1', 'fr-x']) {
      const l = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': HOME, 'cf-ipcountry': country } });
      const r = await t.db.query<{ country: string | null }>('SELECT country FROM app_links WHERE user_code = $1', [l.body.userCode]);
      assert.equal(r.rows[0].country, null, country);
    }
  } finally {
    await t.close();
  }
});

test('app : mail d’alerte sans pays connu ; échec d’envoi signalé, liaison gardée', async () => {
  const reported: unknown[] = [];
  const { t } = await setup((e) => void reported.push(e));
  try {
    const { session } = await signIn(t, 'google');
    const first = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': HOME, 'cf-ipcountry': 'XX' } });
    const one = await t.api('/v1/auth/app-link/approve', {
      json: { code: first.body.userCode },
      headers: { cookie: `ds_session=${session}`, origin: SITE, 'cf-connecting-ip': HOME },
    });
    assert.equal(one.status, 200, 'même réseau : un clic suffit');
    const [mail] = t.mailer.sent.filter((m) => /nouvelle app connectée/.test(m.subject));
    assert.doesNotMatch(mail.text, /pays/);

    const next = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': HOME } });
    const send = t.mailer.send;
    t.mailer.send = async () => {
      throw new Error('Resend en panne');
    };
    const ok = await t.api('/v1/auth/app-link/approve', {
      json: { code: next.body.userCode },
      headers: { cookie: `ds_session=${session}`, origin: SITE, 'cf-connecting-ip': HOME },
    });
    t.mailer.send = send;
    assert.equal(ok.status, 200);
    assert.ok(reported.some((e) => /Resend en panne/.test(String(e))));
  } finally {
    await t.close();
  }
});

// Sortie promise par le mail : « mot de passe oublié » coupe aussi une liaison
// approuvée dont l'app n'a pas encore pris la session.
test('app : liaison approuvée puis mot de passe changé → aucune session remise', async () => {
  const { t } = await setup();
  try {
    const { session } = await signIn(t, 'google');
    const link = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': HOME } });
    const ok = await t.api('/v1/auth/app-link/approve', {
      json: { code: link.body.userCode },
      headers: { cookie: `ds_session=${session}`, origin: SITE, 'cf-connecting-ip': HOME },
    });
    assert.equal(ok.status, 200);
    t.tick(61_000);
    assert.equal((await t.api('/v1/auth/forgot', { json: { email: 'pro@example.com' } })).status, 200);
    const reset = await t.api('/v1/auth/reset', { json: { token: lastToken(t.mailer, 'pro@example.com'), password: 'un-nouveau-mot-de-passe' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode: link.body.deviceCode } })).status, 410);
  } finally {
    await t.close();
  }
});

test('app : connexion par le site, en attente, approuvée une fois, expirée', async () => {
  const { t } = await setup();
  try {
    const link = await t.api('/v1/auth/app-link', { method: 'POST', headers: { 'cf-connecting-ip': HOME } });
    assert.equal(link.status, 200);
    const { deviceCode, userCode, url } = link.body as { deviceCode: string; userCode: string; url: string };
    assert.match(userCode, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.equal(url, `${SITE}/compte/app/?code=${userCode}`);
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode } })).status, 202, 'en attente');

    // Google lancé depuis la page de l'app : retour sur cette page.
    const { location, session } = await signIn(t, 'google', { app: userCode });
    assert.equal(location.toString(), `${SITE}/compte/app/?code=${userCode}`);

    // Une session de l'app n'approuve pas : il faut le cookie du site.
    const appToken = await connect(t, { email: 'autre@example.com', password: 'un-mot-de-passe-solide' });
    assert.equal((await t.api('/v1/auth/app-link/approve', { json: { code: userCode }, token: appToken })).status, 401);

    const approve = await t.api('/v1/auth/app-link/approve', {
      json: { code: userCode.toLowerCase().replace('-', '') },
      headers: { cookie: `ds_session=${session}`, origin: SITE, 'cf-connecting-ip': HOME },
    });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(approve.headers.get('access-control-allow-origin'), SITE, 'route admise pour le site');
    const again = await t.api('/v1/auth/app-link/approve', { json: { code: userCode }, headers: { cookie: `ds_session=${session}`, origin: SITE } });
    assert.equal(again.status, 410, 'code déjà servi : même réponse qu’un code inconnu');
    assert.match(String(again.body.error), /inconnu, expiré ou déjà utilisé/);

    const token = await t.api('/v1/auth/app-link/token', { json: { deviceCode } });
    assert.equal(token.status, 200);
    assert.equal((token.body.account as Record<string, unknown>).email, 'pro@example.com');
    assert.equal((await t.api('/v1/me', { token: String(token.body.token) })).status, 200, 'session de l’app');
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode } })).status, 410, 'remise une seule fois');

    // Lien expiré.
    const late = await t.api('/v1/auth/app-link', { method: 'POST' });
    t.tick((LINK_MINUTES + 1) * 60_000);
    assert.equal((await t.api('/v1/auth/app-link/token', { json: { deviceCode: late.body.deviceCode } })).status, 410);
    const expired = await t.api('/v1/auth/app-link/approve', {
      json: { code: late.body.userCode },
      headers: { cookie: `ds_session=${session}`, origin: SITE },
    });
    assert.equal(expired.status, 410, 'code expiré');

    // Codes devinés : essais plafonnés par compte sur 10 min (1 fait depuis le saut d’horloge).
    const guess = () => t.api('/v1/auth/app-link/approve', { json: { code: 'BBBB-BBBB' }, headers: { cookie: `ds_session=${session}`, origin: SITE } });
    for (let i = 1; i < APPROVALS_PER_10_MIN; i++) assert.equal((await guess()).status, 410);
    assert.equal((await guess()).status, 429, 'trop d’essais');

    // Conservation : codes expirés supprimés par la purge quotidienne.
    const report = await purge(t.db, t.mailer, new Date(t.now().getTime() + 86400_000));
    assert.ok(report.appLinks >= 1);
    assert.equal((await t.db.query('SELECT 1 FROM app_links')).rows.length, 0);
  } finally {
    await t.close();
  }
});
