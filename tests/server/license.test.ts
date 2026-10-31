import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { GRACE_DAYS, LICENSE_DAYS, generateKeys, issueLicense, loadKeys, verifyLicense, type LicensePayload } from '../../server/license.js';
import { T0, lastToken, testApp } from './helpers.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const user = { email: 'romain@example.com', password: 'un-mot-de-passe-solide' };

async function connected(t: Awaited<ReturnType<typeof testApp>>) {
  await t.api('/v1/auth/signup', { json: user });
  await t.api('/v1/auth/verify', { json: { token: lastToken(t.mailer, user.email) } });
  return String((await t.api('/v1/auth/login', { json: user })).body.token);
}

test('licence : clé privée PEM lue depuis l’environnement, sauts de ligne échappés compris, autre algorithme refusé', () => {
  const generated = generateKeys();
  // Render ou un copier-coller peuvent livrer le PEM sur une ligne, `\n` littéraux.
  const loaded = loadKeys(generated.privateKeyPem.replace(/\n/g, '\\n'));
  assert.equal(loaded.publicKeyPem, generated.publicKeyPem);
  const account = { id: 'a', email: 'x@example.com', plan: 'free' as const, gifted: false, dailyCapCents: 200 };
  assert.equal(verifyLicense(generated.publicKey, issueLicense(loaded, account, T0).token, T0).status, 'valid');

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  assert.throws(() => loadKeys(rsa), /Ed25519/);
});

test('licence : émise pour la session, vérifiable hors ligne avec la clé publique servie', async () => {
  const t = await testApp();
  try {
    assert.equal((await t.api('/v1/license', { method: 'POST' })).status, 401, 'connexion requise');
    const session = await connected(t);
    const issued = await t.api('/v1/license', { method: 'POST', token: session });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.tier, 'free');
    assert.equal(issued.body.expiresAt, new Date(t.now().getTime() + LICENSE_DAYS * DAY).toISOString());
    assert.equal(issued.body.graceUntil, new Date(t.now().getTime() + (LICENSE_DAYS + GRACE_DAYS) * DAY).toISOString());

    const key = await t.api('/v1/license/key');
    assert.equal(key.body.alg, 'Ed25519');
    const check = verifyLicense(String(key.body.publicKey), String(issued.body.license), t.now());
    assert.equal(check.status, 'valid');
    const payload = (check as { payload: LicensePayload }).payload;
    assert.equal(payload.email, user.email);
    assert.equal(payload.tier, 'free');
    assert.equal(payload.gifted, false);
    assert.equal(payload.cap, 200);

    // Grâce hors ligne après l'expiration, puis expirée.
    assert.equal(verifyLicense(t.keys.publicKey, String(issued.body.license), new Date(payload.exp + HOUR)).status, 'grace');
    assert.equal(verifyLicense(t.keys.publicKey, String(issued.body.license), new Date(payload.grace + HOUR)).status, 'expired');
  } finally {
    await t.close();
  }
});

test('licence : signature ou charge utile altérée refusée, autre clé refusée, compte offert en Pro', async () => {
  const t = await testApp();
  try {
    const session = await connected(t);
    const license = String((await t.api('/v1/license', { method: 'POST', token: session })).body.license);
    const [body, signature] = license.split('.');

    // Charge utile modifiée (palier) avec la signature d'origine.
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), tier: 'pro' })).toString('base64url');
    assert.equal(verifyLicense(t.keys.publicKey, `${forgedBody}.${signature}`, t.now()).status, 'invalid');
    // Signature abîmée.
    const flipped = signature.slice(0, -2) + (signature.endsWith('A') ? 'BB' : 'AA');
    assert.equal(verifyLicense(t.keys.publicKey, `${body}.${flipped}`, t.now()).status, 'invalid');
    // Autre paire de clés.
    assert.equal(verifyLicense(generateKeys().publicKey, license, t.now()).status, 'invalid');
    assert.equal(verifyLicense(t.keys.publicKey, 'n-importe-quoi', t.now()).status, 'invalid');

    // Compte offert (l'associé) : palier effectif Pro dans la licence, indicateur conservé.
    await t.db.query('UPDATE accounts SET gifted = true, daily_cap_cents = 500 WHERE email = $1', [user.email]);
    const gifted = await t.api('/v1/license', { method: 'POST', token: session });
    assert.equal(gifted.body.tier, 'pro');
    const check = verifyLicense(t.keys.publicKey, String(gifted.body.license), t.now());
    assert.equal(check.status, 'valid');
    const payload = (check as { payload: LicensePayload }).payload;
    assert.equal(payload.gifted, true);
    assert.equal(payload.cap, 500);
  } finally {
    await t.close();
  }
});
