import assert from 'node:assert/strict';
import test from 'node:test';
import { RESET_HOURS, SESSION_DAYS, VERIFY_HOURS } from '../../server/auth.js';
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
    assert.equal(account.dailyCapCents, 200);
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
