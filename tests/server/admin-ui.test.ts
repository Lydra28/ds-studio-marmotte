import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminApp } from '../../server/admin-ui.js';
import { connect, testApp } from './helpers.js';

// Interface d'administration locale (2026-11-05) : jeton, hôte et origine
// exigés ; liste des comptes avec usage ; offert, plafond, crédits avec motif.
const ORIGIN = 'http://127.0.0.1:4999';
const TOKEN = 'jeton-de-test-admin';

async function setup() {
  const t = await testApp();
  const admin = createAdminApp({ db: t.db, token: TOKEN, origin: ORIGIN, label: 'test', now: t.now });
  const call = async (path: string, init: { body?: unknown; token?: string | null; host?: string; origin?: string | null } = {}) => {
    const headers = new Headers({ host: init.host ?? '127.0.0.1:4999' });
    if (init.token !== null) headers.set('x-admin-token', init.token ?? TOKEN);
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json');
      if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN);
    }
    const res = await admin.request(ORIGIN + path, {
      method: init.body !== undefined ? 'POST' : 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { text };
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { t, call };
}

test('admin ui : page sans jeton, API gardée par jeton, hôte et origine', async () => {
  const { t, call } = await setup();
  try {
    const page = await call('/', { token: null });
    assert.equal(page.status, 200);
    assert.match(String(page.body.text), /DS-Studio · Administration/);
    assert.doesNotMatch(String(page.body.text), new RegExp(TOKEN), 'jeton jamais dans la page');
    assert.match(String(page.headers.get('content-security-policy')), /default-src 'none'/);

    assert.equal((await call('/api/accounts', { token: null })).status, 401);
    assert.equal((await call('/api/accounts', { token: 'autre' })).status, 401);
    assert.equal((await call('/api/accounts', { host: 'evil.test' })).status, 403, 'rebond DNS refusé');
    assert.equal((await call('/api/accounts')).status, 200);
    const id = '00000000-0000-4000-8000-000000000000';
    assert.equal((await call(`/api/accounts/${id}/cap`, { body: { cents: 5 }, origin: 'https://evil.test' })).status, 403);
    assert.equal((await call(`/api/accounts/${id}/cap`, { body: { cents: 5 }, origin: null })).status, 403);
    assert.equal((await call(`/api/accounts/${id}/cap`, { body: { cents: 5 } })).status, 404);
    assert.equal((await call('/api/accounts/pas-un-uuid/cap', { body: { cents: 5 } })).status, 404);
  } finally {
    await t.close();
  }
});

test('admin ui : liste avec usage, offert, plafond, crédits avec motif', async () => {
  const { t, call } = await setup();
  try {
    const token = await connect(t, { email: 'testeur@example.com', password: 'mot-de-passe-solide' });
    // Bienvenue (1 c€) puis un appel débité : 0,4 c$ de coût réel.
    assert.equal((await t.api('/v1/relay/chat', { json: { messages: [{ role: 'user', content: 'x' }] }, token })).status, 200);

    let list = await call('/api/accounts');
    const [a] = list.body.accounts as Record<string, unknown>[];
    assert.equal(a.email, 'testeur@example.com');
    assert.equal(a.verified, true);
    assert.equal(a.gifted, false);
    assert.equal(a.todayCents, 0.4);
    assert.equal(a.monthCents, 0.4);
    assert.equal(a.dailyCapCents, 200);
    assert.equal(typeof a.lastUseAt, 'string');
    assert.equal('password_hash' in a || 'passwordHash' in a, false, 'jamais d’empreinte de mot de passe');

    const id = String(a.id);
    const gift = await call(`/api/accounts/${id}/gift`, { body: { gifted: true } });
    assert.equal(gift.status, 200);
    assert.equal(gift.body.dailyCapCents, 10, 'offert : plafond 10 c$ d’office');
    assert.equal((await t.api('/v1/me', { token })).body.gifted, true);
    assert.equal((await call(`/api/accounts/${id}/gift`, { body: { gifted: 'oui' } })).status, 400);

    assert.equal((await call(`/api/accounts/${id}/cap`, { body: { cents: -1 } })).status, 400);
    assert.equal((await call(`/api/accounts/${id}/cap`, { body: { cents: 25 } })).status, 200);
    assert.equal((await t.api('/v1/me', { token })).body.dailyCapCents, 25);

    const off = await call(`/api/accounts/${id}/gift`, { body: { gifted: false } });
    assert.equal(off.body.dailyCapCents, 200, 'retiré : plafond par défaut rendu');

    assert.equal((await call(`/api/accounts/${id}/credit`, { body: { cents: 250, note: '' } })).status, 400, 'motif obligatoire');
    assert.equal((await call(`/api/accounts/${id}/credit`, { body: { cents: 0, note: 'x' } })).status, 400);
    const before = Number(a.creditCents);
    const plus = await call(`/api/accounts/${id}/credit`, { body: { cents: 250, note: 'Geste : bug du Mur' } });
    assert.equal(plus.status, 200);
    assert.equal(plus.body.creditCents, before + 250);
    const minus = await call(`/api/accounts/${id}/credit`, { body: { cents: -50, note: 'Erreur de saisie' } });
    assert.equal(minus.body.creditCents, before + 200);

    const history = await call(`/api/accounts/${id}/history`);
    const credits = history.body.credits as { deltaCents: number; reason: string; note: string | null }[];
    assert.deepEqual(credits.slice(0, 2).map((c) => [c.deltaCents, c.note]), [
      [-50, 'Erreur de saisie'],
      [250, 'Geste : bug du Mur'],
    ]);
    assert.equal(credits.at(-1)!.reason, 'welcome');
    assert.equal((history.body.usage as unknown[]).length, 1);

    list = await call('/api/accounts');
    assert.equal((list.body.accounts as { creditCents: number }[])[0].creditCents, before + 200);
  } finally {
    await t.close();
  }
});
