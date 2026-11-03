import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RELAY_MODEL, RELAY_MODELS } from '../../server/relay.js';
import { completion, connect, testApp, type TestApp } from './helpers.js';

const HOUR = 3600_000;
const user = { email: 'relais@example.com', password: 'un-mot-de-passe-solide' };
const near = (a: unknown, b: number, what: string) => assert.ok(Math.abs(Number(a) - b) < 1e-6, `${what} : ${String(a)} ≠ ${b}`);
const chat = (t: TestApp, token: string, body: unknown = { messages: [{ role: 'user', content: 'Bonjour' }] }, headers: Record<string, string> = {}) =>
  t.api('/v1/relay/chat', { json: body, token, headers });
const events = (t: TestApp) =>
  t.db.query<{ origin: string; model: string; cost_cents: string | number; cost_source: string; charged_to: string; generation_id: string | null; charged_cents: number }>(
    'SELECT origin, model, cost_cents, cost_source, charged_to, generation_id, charged_cents FROM usage_events ORDER BY id',
  );

test('relais : modèle imposé, réponse OpenRouter telle quelle, usage compté et lu dans /me', async () => {
  const t = await testApp();
  try {
    assert.equal((await chat(t, '')).status, 401, 'connexion requise');
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);

    const res = await chat(
      t,
      token,
      { model: 'anthropic/claude-inconnu', messages: [{ role: 'user', content: 'Bonjour' }], max_tokens: 10, stream: true, stream_options: { include_usage: true } },
      { 'x-ds-origin': 'wall' },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body.choices as { message: { content: string } }[])[0].message.content, 'Réponse simulée.');
    assert.equal((res.body.usage as { cost: number }).cost, 0.004, 'réponse renvoyée telle quelle, usage compris');

    const sent = t.openRouter.calls[0];
    assert.equal(sent.body.model, DEFAULT_RELAY_MODEL, 'modèle hors liste remplacé');
    assert.equal(sent.body.stream, false, 'non streamé en V0');
    assert.equal(sent.body.max_tokens, 10, 'le reste du corps passe');
    assert.equal('stream_options' in sent.body, false);
    assert.equal(sent.headers.authorization, 'Bearer test-key', 'clé du serveur, jamais celle du client');
    assert.equal(sent.headers['x-title'], 'DS-Studio');

    const second = await chat(t, token, { model: RELAY_MODELS[1], messages: [{ role: 'user', content: 'Re' }] });
    assert.equal(second.status, 200);
    assert.equal(t.openRouter.calls[1].body.model, RELAY_MODELS[1], 'modèle de la liste conservé');

    const { rows } = await events(t);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.origin, r.model, r.cost_source, r.charged_to, r.generation_id]),
      [
        ['wall', DEFAULT_RELAY_MODEL, 'openrouter', 'gift', 'gen-test'],
        ['other', RELAY_MODELS[1], 'openrouter', 'gift', 'gen-test'],
      ],
    );
    near(rows[0].cost_cents, 0.4, 'coût en centimes');
    assert.deepEqual(rows.map((r) => r.charged_cents), [0, 0], 'compte offert : rien débité');

    const me = await t.api('/v1/me', { token });
    const usage = me.body.usage as { todayCents: number; monthCents: number; resetAt: string; includedLeftCents: number };
    near(usage.todayCents, 0.8, 'usage du jour');
    near(usage.monthCents, 0.8, 'usage du mois');
    assert.equal(usage.resetAt, '2026-11-01T00:00:00.000Z');
    assert.equal(me.body.creditCents, 1, 'compte offert : crédits intacts (la bienvenue reste)');
  } finally {
    await t.close();
  }
});

test('relais : plafond journalier → 429 avec l’heure de remise à zéro, levé le lendemain', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true, daily_cap_cents = 1 WHERE email = $1', [user.email]);
    for (let i = 0; i < 3; i++) assert.equal((await chat(t, token)).status, 200, `appel ${i + 1} sous le plafond`);
    const blocked = await chat(t, token);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.resetAt, '2026-11-01T00:00:00.000Z');
    assert.match(String(blocked.body.error), /Plafond journalier atteint \(1 centimes\)/);
    assert.equal(t.openRouter.calls.length, 3, 'rien envoyé à OpenRouter au-delà du plafond');

    t.tick(13 * HOUR); // 1er novembre, 1 h UTC
    assert.equal((await chat(t, token)).status, 200, 'plafond remis à zéro');
    const me = await t.api('/v1/me', { token });
    near((me.body.usage as { todayCents: number }).todayCents, 0.4, 'usage du nouveau jour');
    near((me.body.usage as { monthCents: number }).monthCents, 0.4, 'nouveau mois aussi');
  } finally {
    await t.close();
  }
});

test('relais : bienvenue d’une génération puis 402 ; débit ceil(coût × 3) en centimes d’euro ; Pro puise dans l’inclus puis dans les crédits', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    // Confirmation du mail : 1 centime de bienvenue = une génération, quelle que soit sa taille.
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 1);
    assert.equal((await chat(t, token)).status, 200, 'génération offerte');
    let me = await t.api('/v1/me', { token });
    assert.equal(me.body.creditCents, -1, 'coût 0,4 c$ × 3 = 1,2 → 2 centimes d’euro, solde sous zéro');
    assert.equal(me.body.welcome, false, 'bienvenue consommée');
    const refused = await chat(t, token);
    assert.equal(refused.status, 402, 'gratuit sans crédits');
    assert.match(String(refused.body.error), /Solde de crédits à zéro/);
    assert.equal(t.openRouter.calls.length, 1);

    await t.db.query('UPDATE accounts SET credit_cents = 3 WHERE email = $1', [user.email]);
    assert.equal((await chat(t, token)).status, 200);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 1, 'débité de 2');
    assert.equal((await chat(t, token)).status, 200, 'un solde positif suffit à lancer l’appel');
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, -1, 'le dernier appel peut passer sous zéro');
    assert.equal((await chat(t, token)).status, 402, 'puis refus');
    const { rows } = await events(t);
    assert.deepEqual(rows.map((r) => [r.charged_to, r.charged_cents]), [['credits', 2], ['credits', 2], ['credits', 2]]);

    // Pro : 5 centimes inclus ; l'appel qui dépasse reste inclus (2, 4, 6), puis crédits.
    await t.db.query("UPDATE accounts SET plan = 'pro', monthly_included_cents = 5, credit_cents = 0 WHERE email = $1", [user.email]);
    for (let i = 0; i < 3; i++) assert.equal((await chat(t, token)).status, 200, `Pro, appel inclus ${i + 1}`);
    me = await t.api('/v1/me', { token });
    assert.equal((me.body.usage as { includedLeftCents: number }).includedLeftCents, 0, 'inclus consommé');
    assert.equal(me.body.creditCents, 0, 'crédits non touchés tant que l’inclus couvre');
    const exhausted = await chat(t, token);
    assert.equal(exhausted.status, 402);
    assert.match(String(exhausted.body.error), /inclus du mois épuisé/);
    await t.db.query('UPDATE accounts SET credit_cents = 5 WHERE email = $1', [user.email]);
    assert.equal((await chat(t, token)).status, 200, 'Pro au-delà de l’inclus : crédits');
    assert.deepEqual((await events(t)).rows.slice(3).map((r) => [r.charged_to, r.charged_cents]), [['pro', 2], ['pro', 2], ['pro', 2], ['credits', 2]]);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 3, 'crédits débités');
  } finally {
    await t.close();
  }
});

test('relais : OpenRouter en panne ou en refus → 502 sans rien compter ; corps invalide 400 ; trop lourd 413 ; image de 2 Mo acceptée ; sans clé 503', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);

    t.openRouter.state.reply = () => {
      throw new TypeError('fetch failed');
    };
    const down = await chat(t, token);
    assert.equal(down.status, 502);
    assert.match(String(down.body.error), /OpenRouter injoignable/);
    t.openRouter.state.reply = () => Response.json({ error: { message: 'Rate limited upstream' } }, { status: 429 });
    const refused = await chat(t, token);
    assert.equal(refused.status, 502);
    assert.match(String(refused.body.error), /\(429\) : Rate limited upstream/);
    assert.equal((await events(t)).rows.length, 0, 'aucun événement sur un échec');

    t.openRouter.state.reply = () => completion();
    assert.equal((await chat(t, token, {})).status, 400, 'messages manquants');
    assert.equal((await chat(t, token, { messages: [] })).status, 400, 'messages vides');

    const image = 'data:image/png;base64,' + 'A'.repeat(2_000_000);
    const withImage = await chat(t, token, {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspirations' }, { type: 'image_url', image_url: { url: image } }] }],
    });
    assert.equal(withImage.status, 200, 'image de 2 Mo en data: acceptée');
    const content = (t.openRouter.calls.at(-1)!.body.messages as { content: { image_url?: { url: string } }[] }[])[0].content;
    assert.equal(content[1].image_url?.url.length, image.length, 'image transmise entière');

    const heavy = await chat(t, token, { messages: [{ role: 'user', content: 'x'.repeat(33 * 1024 * 1024) }] });
    assert.equal(heavy.status, 413);
    assert.match(String(heavy.body.error), /trop lourde/);

    const off = await testApp({ db: t.db, openRouter: { apiKey: '' } });
    const disabled = await off.api('/v1/relay/chat', { json: { messages: [{ role: 'user', content: 'x' }] }, token });
    assert.equal(disabled.status, 503);
  } finally {
    await t.close();
  }
});

test('relais : coût absent de la réponse → estimé par les prix publics, sinon inconnu et compté à 0', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);
    t.openRouter.state.reply = () => completion({ prompt_tokens: 1000, completion_tokens: 1000, cost: undefined });
    assert.equal((await chat(t, token)).status, 200);
    const [estimated] = (await events(t)).rows;
    assert.equal(estimated.cost_source, 'estimate');
    near(estimated.cost_cents, (1000 * 0.00000015 + 1000 * 0.0000006) * 100, 'jetons × prix publics, en centimes');

    const t2 = await testApp();
    try {
      const token2 = await connect(t2, user);
      await t2.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);
      t2.openRouter.state.prices = { data: [] };
      t2.openRouter.state.reply = () => completion({ cost: undefined });
      assert.equal((await chat(t2, token2)).status, 200, 'l’appel passe même sans prix');
      const [unknown] = (await events(t2)).rows;
      assert.equal(unknown.cost_source, 'unknown');
      near(unknown.cost_cents, 0, 'compté à zéro');
    } finally {
      await t2.close();
    }
  } finally {
    await t.close();
  }
});
