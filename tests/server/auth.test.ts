import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_JSON_BYTES, MAX_WEBHOOK_BYTES } from '../../server/app.js';
import { MAIL_GAP_SECONDS, RESET_HOURS, SESSION_DAYS, SIGNUPS_PER_HOUR, SIGNUPS_PER_IP_PER_HOUR, VERIFY_HOURS } from '../../server/auth.js';
import { memoryMailer } from '../../server/mail.js';
import { lastToken, testApp } from './helpers.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const user = { email: 'Romain@Example.com ', password: 'un-mot-de-passe-solide' };

test('comptes : inscription, mail de confirmation, connexion, /me, déconnexion', async () => {
  const t = await testApp();
  try {
    const signup = await t.api('/v1/auth/signup', { json: user });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, 'romain@example.com', 'adresse normalisée en minuscules, sans espaces');
    assert.match(t.mailer.sent[0].text, /http:\/\/server\.test\/v1\/auth\/verify\?token=/);

    // Pas de connexion avant confirmation.
    const early = await t.api('/v1/auth/login', { json: user });
    assert.equal(early.status, 403);
    assert.match(String(early.body.error), /non confirmée/);

    const token = lastToken(t.mailer, 'romain@example.com');
    const verify = await t.api('/v1/auth/verify', { json: { token } });
    assert.equal(verify.status, 200, JSON.stringify(verify.body));
    // Le lien est à usage unique.
    assert.equal((await t.api('/v1/auth/verify', { json: { token } })).status, 400);

    const login = await t.api('/v1/auth/login', { json: user });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const session = String(login.body.token);
    assert.ok(session.length >= 40);
    const account = login.body.account as Record<string, unknown>;
    assert.equal(account.email, 'romain@example.com');
    assert.equal(account.plan, 'free');
    assert.equal(account.gifted, false);
    assert.equal(account.dailyCapCents, 50, 'plafond par défaut (0007)');
    assert.ok(account.emailVerifiedAt);

    const me = await t.api('/v1/me', { token: session });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, 'romain@example.com');
    assert.equal(me.body.tier, 'free', 'palier effectif, le même que la licence');
    assert.equal((await t.api('/v1/me')).status, 401, 'sans jeton');
    assert.equal((await t.api('/v1/me', { token: 'faux' })).status, 401, 'jeton inconnu');

    // Session glissante : toujours valable après 20 jours d'usage, expirée après 30 jours sans usage.
    t.tick(20 * DAY);
    assert.equal((await t.api('/v1/me', { token: session })).status, 200);
    t.tick(20 * DAY);
    assert.equal((await t.api('/v1/me', { token: session })).status, 200, 'prolongée par l’usage à J+20');
    t.tick((SESSION_DAYS + 1) * DAY);
    assert.equal((await t.api('/v1/me', { token: session })).status, 401, 'expirée sans usage');

    const again = await t.api('/v1/auth/login', { json: user });
    const fresh = String(again.body.token);
    assert.equal((await t.api('/v1/auth/logout', { method: 'POST', token: fresh })).status, 204);
    assert.equal((await t.api('/v1/me', { token: fresh })).status, 401, 'déconnecté');
  } finally {
    await t.close();
  }
});

test('comptes : refus explicites (doublon, mot de passe faux, adresse ou mot de passe invalides, lien expiré)', async () => {
  const t = await testApp();
  try {
    assert.equal((await t.api('/v1/auth/signup', { json: user })).status, 201);
    const dup = await t.api('/v1/auth/signup', { json: { email: 'romain@example.com', password: 'autre-mot-de-passe-1' } });
    assert.equal(dup.status, 409);
    assert.equal((await t.api('/v1/auth/signup', { json: { email: 'pas-une-adresse', password: user.password } })).status, 400);
    const short = await t.api('/v1/auth/signup', { json: { email: 'a@b.fr', password: 'court' } });
    assert.equal(short.status, 400);
    assert.match(String(short.body.error), /10 caractères/);
    assert.equal((await t.api('/v1/auth/signup', { body: 'pas du json', method: 'POST' })).status, 400);

    // Lien de confirmation expiré après 24 h ; un nouveau lien se demande.
    const token = lastToken(t.mailer, 'romain@example.com');
    t.tick((VERIFY_HOURS + 1) * HOUR);
    const late = await t.api('/v1/auth/verify', { json: { token } });
    assert.equal(late.status, 400);
    assert.match(String(late.body.error), /expiré/);
    assert.equal((await t.api('/v1/auth/resend', { json: { email: user.email } })).status, 200);
    assert.equal(t.mailer.sent.length, 2);
    const token2 = lastToken(t.mailer, 'romain@example.com');
    assert.notEqual(token2, token);
    // Le lien ouvert dans un navigateur rend une page, pas du JSON.
    const html = await t.api(`/v1/auth/verify?token=${token2}`);
    assert.equal(html.status, 200);
    assert.match(String(html.body.html), /Adresse confirmée/);

    assert.equal((await t.api('/v1/auth/login', { json: { email: user.email, password: 'mauvais' } })).status, 401);
    assert.equal((await t.api('/v1/auth/login', { json: { email: 'inconnu@example.com', password: user.password } })).status, 401);
    assert.equal((await t.api('/v1/auth/login', { json: user })).status, 200);
  } finally {
    await t.close();
  }
});

test('comptes : mot de passe oublié par code reçu, anciennes sessions fermées', async () => {
  const t = await testApp();
  try {
    await t.api('/v1/auth/signup', { json: user });
    await t.api('/v1/auth/verify', { json: { token: lastToken(t.mailer, 'romain@example.com') } });
    const old = String((await t.api('/v1/auth/login', { json: user })).body.token);

    // Adresse inconnue : même réponse, aucun mail.
    const sentBefore = t.mailer.sent.length;
    assert.equal((await t.api('/v1/auth/forgot', { json: { email: 'inconnu@example.com' } })).status, 200);
    assert.equal(t.mailer.sent.length, sentBefore);

    assert.equal((await t.api('/v1/auth/forgot', { json: { email: user.email } })).status, 200);
    const code = lastToken(t.mailer, 'romain@example.com');
    // Code périmé après une heure.
    t.tick((RESET_HOURS + 1) * HOUR);
    assert.equal((await t.api('/v1/auth/reset', { json: { token: code, password: 'nouveau-mot-de-passe' } })).status, 400);
    await t.api('/v1/auth/forgot', { json: { email: user.email } });
    const code2 = lastToken(t.mailer, 'romain@example.com');
    const reset = await t.api('/v1/auth/reset', { json: { token: code2, password: 'nouveau-mot-de-passe' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    assert.equal((await t.api('/v1/me', { token: old })).status, 401, 'ancienne session fermée');
    assert.equal((await t.api('/v1/auth/login', { json: user })).status, 401, 'ancien mot de passe refusé');
    const fresh = await t.api('/v1/auth/login', { json: { email: user.email, password: 'nouveau-mot-de-passe', client: 'site' } });
    assert.equal(fresh.status, 200);
    assert.match(fresh.headers.get('set-cookie') ?? '', /ds_session=.*HttpOnly/, 'cookie de session pour le site');
  } finally {
    await t.close();
  }
});

// Revue du 2026-11-13, n° 9 : une boucle sur ces routes ne remplit plus une
// boîte, ne vide plus le quota d'envoi et ne sature plus la mémoire.
test('comptes : un mail par minute et par type, inscriptions plafonnées par heure, corps bornés', async () => {
  const reported: unknown[] = [];
  const t = await testApp({ report: (e) => void reported.push(e) });
  try {
    const email = 'romain@example.com';
    const mails = (subject: RegExp) => t.mailer.sent.filter((m) => m.to === email && subject.test(m.subject)).length;
    await t.api('/v1/auth/signup', { json: user });
    assert.equal(mails(/confirmation/), 1);

    // Confirmation redemandée en boucle : même réponse, un seul mail de plus par minute.
    for (let i = 0; i < 5; i++) assert.equal((await t.api('/v1/auth/resend', { json: { email } })).status, 200);
    assert.equal(mails(/confirmation/), 1, 'le mail de l’inscription date de moins d’une minute');
    t.tick((MAIL_GAP_SECONDS + 1) * 1000);
    // En rafale aussi : le compte est verrouillé le temps du contrôle.
    await Promise.all(Array.from({ length: 5 }, () => t.api('/v1/auth/resend', { json: { email } })));
    assert.equal(mails(/confirmation/), 2);

    // Même frein pour le code de mot de passe oublié, compté à part.
    for (let i = 0; i < 5; i++) assert.equal((await t.api('/v1/auth/forgot', { json: { email } })).status, 200);
    assert.equal(mails(/mot de passe/), 1);
    t.tick((MAIL_GAP_SECONDS + 1) * 1000);
    await t.api('/v1/auth/forgot', { json: { email } });
    assert.equal(mails(/mot de passe/), 2);
    assert.equal((await t.api('/v1/auth/reset', { json: { token: lastToken(t.mailer, email), password: 'nouveau-mot-de-passe' } })).status, 200, 'le dernier code sert');

    // Inscriptions par adresse IP (en-tête de Cloudflare) : un poste ne ferme pas la porte aux autres.
    const sign = (name: string, ip: string) =>
      t.api('/v1/auth/signup', { json: { email: `${name}@example.com`, password: user.password }, headers: { 'cf-connecting-ip': ip } });
    for (let n = 0; n < SIGNUPS_PER_IP_PER_HOUR; n++) assert.equal((await sign(`classe${n}`, '203.0.113.7')).status, 201, `inscription ${n + 1}`);
    const tooMany = await sign('de-trop', '203.0.113.7');
    assert.equal(tooMany.status, 429);
    assert.match(String(tooMany.body.error), /depuis cette connexion/);
    assert.equal(t.mailer.sent.filter((m) => m.to === 'de-trop@example.com').length, 0, 'aucun mail pour l’inscription refusée');
    assert.equal((await sign('ailleurs', '198.51.100.9')).status, 201, 'une autre adresse s’inscrit toujours');
    t.tick(HOUR + 1000);
    assert.equal((await sign('plus-tard', '203.0.113.7')).status, 201, 'levé l’heure suivante');

    // Plafond global, filet si l'adresse est falsifiée : refus, un seul signalement par heure.
    await t.db.query(
      `INSERT INTO accounts (email, password_hash, created_at, last_active_at)
       SELECT 'masse' || n || '@example.com', '!', $1, $1 FROM generate_series(1, $2::int) AS n`,
      [t.now(), SIGNUPS_PER_HOUR],
    );
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      const full = await sign(`falsifie-${ip}`, ip);
      assert.equal(full.status, 429);
      assert.match(String(full.body.error), /Trop d’inscriptions en ce moment/);
    }
    assert.equal(reported.length, 1, 'signalé une fois, pas à chaque refus');
    assert.match(String((reported[0] as Error).message), /plafond/);

    // Le relais garde sa propre limite : 200 Ko ne sont pas « trop lourds » pour lui (401 : pas de session).
    assert.equal((await t.api('/v1/relay/chat', { json: { messages: [{ role: 'user', content: 'a'.repeat(200_000) }] } })).status, 401);

    // Corps : 64 Ko hors relais, 1 Mo pour le webhook ; rien n'est lu au-delà.
    const post = (path: string, bytes: number) =>
      t.api(path, { method: 'POST', body: JSON.stringify({ email, pad: 'a'.repeat(bytes) }), headers: { 'content-type': 'application/json' } });
    const heavy = await post('/v1/auth/forgot', MAX_JSON_BYTES);
    assert.equal(heavy.status, 413);
    assert.match(String(heavy.body.error), /trop lourde/);
    assert.equal((await post('/v1/auth/login', MAX_JSON_BYTES)).status, 413);
    assert.equal((await post('/v1/billing/webhook', MAX_JSON_BYTES)).status, 503, 'webhook : passe la limite (Stripe non configuré ici)');
    assert.equal((await post('/v1/billing/webhook', MAX_WEBHOOK_BYTES)).status, 413);
  } finally {
    await t.close();
  }
});

test('comptes : mail redemandé en échec → jeton retiré, la demande suivante n’attend pas la minute', async () => {
  const box = memoryMailer();
  let failing = false;
  const t = await testApp({
    mailer: {
      send: async (mail) => {
        if (failing) throw new Error('Resend a refusé l’envoi (500)');
        await box.send(mail);
      },
    },
    report: () => {},
  });
  try {
    await t.api('/v1/auth/signup', { json: user });
    await t.api('/v1/auth/verify', { json: { token: lastToken(box, 'romain@example.com') } });
    failing = true;
    assert.equal((await t.api('/v1/auth/forgot', { json: { email: user.email } })).status, 500, 'envoi en échec : erreur visible');
    failing = false;
    assert.equal((await t.api('/v1/auth/forgot', { json: { email: user.email } })).status, 200);
    assert.equal(box.sent.filter((m) => /mot de passe/.test(m.subject)).length, 1, 'mail parti au second essai, sans attendre');
    assert.equal(Number((await t.db.query<{ n: string | number }>("SELECT count(*) AS n FROM email_tokens WHERE purpose = 'reset'")).rows[0].n), 1, 'jeton du mail en échec retiré');
  } finally {
    await t.close();
  }
});
