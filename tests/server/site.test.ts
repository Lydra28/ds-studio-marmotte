import assert from 'node:assert/strict';
import test from 'node:test';
import { lastToken, testApp } from './helpers.js';

// Site vitrine (lot 7) : CORS avec cookie pour la seule origine du site,
// écriture par cookie refusée d'ailleurs, jeton jamais rendu au site, lien de
// confirmation et retours Stripe vers les pages du site.
const SITE = 'https://site.test';
const user = { email: 'site@example.test', password: 'mot-de-passe-site' };

async function siteLogin(t: Awaited<ReturnType<typeof testApp>>) {
  await t.api('/v1/auth/signup', { json: user, headers: { origin: SITE } });
  await t.api('/v1/auth/verify', { json: { token: lastToken(t.mailer, user.email) }, headers: { origin: SITE } });
  const login = await t.api('/v1/auth/login', { json: { ...user, client: 'site' }, headers: { origin: SITE } });
  const cookie = String(login.headers.get('set-cookie')).split(';')[0];
  return { login, cookie };
}

test('site : pré-requête et réponses CORS pour la seule origine du site', async () => {
  const t = await testApp({ siteUrl: SITE });
  try {
    const pre = await t.api('/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.match(String(pre.headers.get('access-control-allow-headers')), /content-type/);

    assert.equal((await t.api('/v1/auth/login', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })).status, 403);
    // Routes hors compte (relais, licence) : jamais ouvertes au site.
    assert.equal((await t.api('/v1/relay/chat', { method: 'OPTIONS', headers: { origin: SITE } })).status, 403);

    // Erreur rendue avec les en-têtes CORS : le site peut lire le message.
    const me = await t.api('/v1/me', { headers: { origin: SITE } });
    assert.equal(me.status, 401);
    assert.equal(me.headers.get('access-control-allow-origin'), SITE);
    const other = await t.api('/v1/me', { headers: { origin: 'https://evil.test' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally {
    await t.close();
  }
});

test('site : jeton seulement dans le cookie, écriture par cookie refusée hors du site', async () => {
  const t = await testApp({ siteUrl: SITE, cookieDomain: '.site.test' });
  try {
    const { login, cookie } = await siteLogin(t);
    assert.equal(login.status, 200);
    assert.equal('token' in login.body, false, 'jeton jamais rendu au site');
    assert.match(String(login.headers.get('set-cookie')), /HttpOnly/i);

    const me = await t.api('/v1/me', { headers: { origin: SITE, cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.body.email, user.email);

    // Même cookie, autre origine (ou aucune) : écriture refusée, lecture inchangée.
    const forged = await t.api('/v1/auth/logout', { method: 'POST', headers: { origin: 'https://evil.test', cookie } });
    assert.equal(forged.status, 403);
    assert.equal((await t.api('/v1/auth/logout', { method: 'POST', headers: { cookie } })).status, 403);
    assert.equal((await t.api('/v1/me', { headers: { origin: SITE, cookie } })).status, 200, 'session toujours ouverte');

    // L'app (Bearer, sans origine) n'est pas concernée.
    const app = await t.api('/v1/auth/login', { json: user });
    assert.equal(typeof app.body.token, 'string');
    assert.equal((await t.api('/v1/auth/logout', { method: 'POST', token: String(app.body.token) })).status, 204);

    const out = await t.api('/v1/auth/logout', { method: 'POST', headers: { origin: SITE, cookie } });
    assert.equal(out.status, 204);
    assert.match(String(out.headers.get('set-cookie')), /Domain=\.site\.test/i, 'cookie effacé sur son domaine');
    assert.equal((await t.api('/v1/me', { headers: { origin: SITE, cookie } })).status, 401);
  } finally {
    await t.close();
  }
});

test('site : lien de confirmation vers la page du site, sinon page de l’API', async () => {
  const t = await testApp({ siteUrl: SITE });
  try {
    await t.api('/v1/auth/signup', { json: user });
    assert.match(t.mailer.sent.at(-1)!.text, /https:\/\/site\.test\/compte\/verifier\/\?token=/);
  } finally {
    await t.close();
  }
  const bare = await testApp();
  try {
    await bare.api('/v1/auth/signup', { json: user });
    assert.match(bare.mailer.sent.at(-1)!.text, /http:\/\/server\.test\/v1\/auth\/verify\?token=/);
    // Sans site déclaré : aucune origine admise.
    assert.equal((await bare.api('/v1/me', { method: 'OPTIONS', headers: { origin: SITE } })).status, 403);
  } finally {
    await bare.close();
  }
});
