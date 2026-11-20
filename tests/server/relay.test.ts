import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RELAY_MODEL, MAX_COMPLETION_TOKENS, MAX_READING, MAX_SPEC_CHARS, PARALLEL_MARGIN_CENTS, RELAY_MODELS } from '../../server/relay.js';
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
    assert.equal(sent.body.max_tokens, 10, 'un plafond de sortie plus bas que celui du serveur passe');
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

test('relais : bienvenue d’une génération puis 402 ; débit ceil(coût × RATE) en centimes d’euro ; Pro puise dans l’inclus puis dans les crédits', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    // Confirmation du mail : 1 centime de bienvenue = une génération, quelle que soit sa taille.
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 1);
    assert.equal((await chat(t, token)).status, 200, 'génération offerte');
    let me = await t.api('/v1/me', { token });
    assert.equal(me.body.creditCents, -2, 'coût 0,4 c$ × 5,5 = 2,2 → 3 centimes d’euro, solde sous zéro');
    assert.equal(me.body.welcome, false, 'bienvenue consommée');
    const refused = await chat(t, token);
    assert.equal(refused.status, 402, 'gratuit sans crédits');
    assert.match(String(refused.body.error), /Solde de crédits à zéro/);
    assert.equal(t.openRouter.calls.length, 1);

    await t.db.query('UPDATE accounts SET credit_cents = 4 WHERE email = $1', [user.email]);
    assert.equal((await chat(t, token)).status, 200);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 1, 'débité de 3');
    assert.equal((await chat(t, token)).status, 200, 'un solde positif suffit à lancer l’appel');
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, -2, 'le dernier appel peut passer sous zéro');
    assert.equal((await chat(t, token)).status, 402, 'puis refus');
    const { rows } = await events(t);
    assert.deepEqual(rows.map((r) => [r.charged_to, r.charged_cents]), [['credits', 3], ['credits', 3], ['credits', 3]]);

    // Pro : 5 centimes inclus ; l'appel qui dépasse reste inclus (3, 6), puis crédits.
    await t.db.query("UPDATE accounts SET plan = 'pro', monthly_included_cents = 5, credit_cents = 0 WHERE email = $1", [user.email]);
    for (let i = 0; i < 2; i++) assert.equal((await chat(t, token)).status, 200, `Pro, appel inclus ${i + 1}`);
    me = await t.api('/v1/me', { token });
    assert.equal((me.body.usage as { includedLeftCents: number }).includedLeftCents, 0, 'inclus consommé');
    assert.equal(me.body.creditCents, 0, 'crédits non touchés tant que l’inclus couvre');
    const exhausted = await chat(t, token);
    assert.equal(exhausted.status, 402);
    assert.match(String(exhausted.body.error), /inclus du mois épuisé/);
    await t.db.query('UPDATE accounts SET credit_cents = 5 WHERE email = $1', [user.email]);
    assert.equal((await chat(t, token)).status, 200, 'Pro au-delà de l’inclus : crédits');
    assert.deepEqual((await events(t)).rows.slice(3).map((r) => [r.charged_to, r.charged_cents]), [['pro', 3], ['pro', 3], ['credits', 3]]);
    assert.equal((await t.api('/v1/me', { token })).body.creditCents, 2, 'crédits débités');
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

// Maintien (2026-11-04) : réponse 200 tout de suite, espaces d'attente, puis
// la réponse OpenRouter ou `{ error, status }` ; client parti → appel fini et compté.
test('relais avec maintien : attente envoyée avant la réponse, échec dans le corps, client parti compté quand même', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);
    const post = (signal?: AbortSignal) =>
      t.app.request('http://server.test/v1/relay/chat', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ds-keepalive': '1', 'x-ds-origin': 'wall' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Trois DA' }] }),
        signal,
      });
    const later = () => {
      let resolve!: (r: Response) => void;
      const promise = new Promise<Response>((r) => (resolve = r));
      return { promise, resolve };
    };

    // Réponse lente : l'en-tête et la première espace partent avant la réponse.
    const slow = later();
    t.openRouter.state.reply = () => slow.promise;
    const res = await post();
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ' ', 'attente envoyée sans attendre OpenRouter');
    slow.resolve(completion());
    let text = ' ';
    for (let r = await reader.read(); !r.done; r = await reader.read()) text += new TextDecoder().decode(r.value);
    const parsed = JSON.parse(text) as { choices: { message: { content: string } }[] };
    assert.equal(parsed.choices[0].message.content, 'Réponse simulée.');
    assert.equal((await events(t)).rows.length, 1, 'réponse comptée une fois');

    // OpenRouter en refus : 200 déjà parti, échec et statut dans le corps, rien compté.
    t.openRouter.state.reply = () => Response.json({ error: { message: 'Rate limited upstream' } }, { status: 429 });
    const failed = JSON.parse(await (await post()).text()) as { error: string; status: number };
    assert.equal(failed.status, 502);
    assert.match(failed.error, /OpenRouter a refusé la requête \(429\)/);
    // 200 vide (fournisseur tombé en cours d'appel) : échec, plus d'événement à 0.
    t.openRouter.state.reply = () => Response.json({});
    assert.equal((JSON.parse(await (await post()).text()) as { status: number }).status, 502);
    assert.equal((await events(t)).rows.length, 1, 'échecs non comptés');

    // Client parti avant la réponse : l'appel va à son terme et il est compté
    // (OpenRouter le facture ; l'arrêter rendait une génération gratuite).
    const hang = later();
    t.openRouter.state.reply = () => hang.promise;
    const gone = await post();
    const goneReader = gone.body!.getReader();
    await goneReader.read();
    await goneReader.cancel();
    hang.resolve(completion());
    for (let i = 0; i < 500 && (await events(t)).rows.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await events(t)).rows.length, 2, 'génération abandonnée par le client comptée');

    // Sans l'en-tête (app rc.9 et avant) : réponse simple, statuts inchangés.
    t.openRouter.state.reply = () => Response.json({ error: { message: 'down' } }, { status: 500 });
    assert.equal((await chat(t, token)).status, 502);
  } finally {
    await t.close();
  }
});

// Revue du 2026-11-13, n° 1 : le solde est lu avant l'appel et débité après ;
// des appels lancés ensemble ne passent plus tous sur le même solde.
test('relais : appels lancés ensemble → un seul sans marge, deux avec, place rendue à chaque fin', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    // Attend un fait, pas une durée ; échoue au bout de 5 s.
    const until = async (ready: () => boolean | Promise<boolean>, what = 'condition') => {
      for (let i = 0; i < 500; i++) {
        if (await ready()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`délai dépassé : ${what}`);
    };
    // Rafale de `n` appels dont `pass` doivent partir : OpenRouter ne répond
    // qu'une fois les `n - pass` refus tombés (les appels partis attendent).
    const burst = async (n: number, pass: number) => {
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      t.openRouter.state.reply = async () => {
        await gate;
        return completion();
      };
      let settled = 0;
      const pending = Array.from({ length: n }, () => chat(t, token).finally(() => settled++));
      await until(() => settled >= n - pass);
      open();
      const done = await Promise.all(pending);
      t.openRouter.state.reply = () => completion();
      return done;
    };
    const statuses = (rs: { status: number }[]) => rs.map((r) => r.status).sort();
    const credit = async () => (await t.api('/v1/me', { token })).body.creditCents;

    // 1 c de bienvenue : une génération, pas six.
    const first = await burst(6, 1);
    assert.deepEqual(statuses(first), [200, 429, 429, 429, 429, 429]);
    const refused = first.find((r) => r.status === 429)!;
    assert.match(String(refused.body.error), /déjà en cours/);
    assert.equal('resetAt' in refused.body, false, 'pas le refus du plafond journalier');
    assert.equal((await events(t)).rows.length, 1, 'un seul appel parti et compté');
    assert.equal(await credit(), -2);
    assert.equal((await chat(t, token)).status, 402, 'place rendue : le refus suivant est celui du solde');

    // Solde confortable : le Mur et une question en même temps, pas plus.
    await t.db.query('UPDATE accounts SET credit_cents = 500 WHERE email = $1', [user.email]);
    assert.deepEqual(statuses(await burst(4, 2)), [200, 200, 429, 429]);
    assert.equal(await credit(), 494, 'deux appels débités de 3');
    // Sous la marge : un seul à la fois.
    await t.db.query('UPDATE accounts SET credit_cents = $2 WHERE email = $1', [user.email, PARALLEL_MARGIN_CENTS - 1]);
    assert.deepEqual(statuses(await burst(3, 1)), [200, 429, 429]);

    // Pro : la marge est celle de l'inclus, seule source débitée ; les crédits n'y comptent pas.
    await t.db.query("UPDATE accounts SET plan = 'pro', monthly_included_cents = 300, included_since = $2, credit_cents = 0 WHERE email = $1", [user.email, t.now()]);
    assert.deepEqual(statuses(await burst(3, 2)), [200, 200, 429]);
    await t.db.query('UPDATE accounts SET monthly_included_cents = 50, credit_cents = 500 WHERE email = $1', [user.email]);
    assert.deepEqual(statuses(await burst(3, 1)), [200, 429, 429], 'inclus presque épuisé : un seul, même avec des crédits');
    // Compte offert : jamais débité, donc jamais deux à la fois (seul le plafond journalier le borne).
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);
    assert.deepEqual(statuses(await burst(3, 1)), [200, 429, 429]);
    // Retour en gratuit sous la marge pour la suite : un seul appel à la fois.
    await t.db.query("UPDATE accounts SET gifted = false, plan = 'free', credit_cents = 50 WHERE email = $1", [user.email]);

    // Un appel en échec ou refusé avant de partir rend sa place.
    t.openRouter.state.reply = () => Response.json({ error: { message: 'down' } }, { status: 500 });
    assert.equal((await chat(t, token)).status, 502);
    assert.equal((await chat(t, token, { messages: [] })).status, 400);
    t.openRouter.state.reply = () => completion();
    assert.equal((await chat(t, token)).status, 200);

    // Maintien : la place est tenue tant que le flux dure (la requête, elle,
    // a déjà répondu 200), puis rendue à sa fin ou quand le client part.
    const keepalive = () =>
      t.app.request('http://server.test/v1/relay/chat', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ds-keepalive': '1' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Trois DA' }] }),
      });
    const free = async () => (await chat(t, token)).status !== 429;
    let answer!: (r: Response) => void;
    t.openRouter.state.reply = () => new Promise<Response>((r) => (answer = r));
    const held = (await keepalive()).body!.getReader();
    await held.read();
    await until(() => typeof answer === 'function');
    const slow = answer;
    t.openRouter.state.reply = () => completion();
    assert.equal((await chat(t, token)).status, 429, 'place tenue pendant le flux');
    slow(completion());
    for (let r = await held.read(); !r.done; r = await held.read());
    assert.equal(await free(), true, 'place rendue à la fin du flux');

    // Client parti : l'appel continue et garde la place jusqu'à sa fin, puis
    // il est compté (sinon on enchaînerait des générations gratuites).
    let finish: ((r: Response) => void) | undefined;
    t.openRouter.state.reply = () => new Promise<Response>((r) => (finish = r));
    const gone = (await keepalive()).body!.getReader();
    await gone.read();
    await until(() => finish !== undefined, 'appel abandonné parti chez OpenRouter');
    const late = finish!;
    t.openRouter.state.reply = () => completion();
    const before = (await events(t)).rows.length;
    await gone.cancel();
    assert.equal((await chat(t, token)).status, 429, 'place tenue après le départ du client, tant que l’appel court');
    late(completion());
    await until(free, 'place rendue à la fin de l’appel abandonné');
    assert.equal((await events(t)).rows.length, before + 2, 'appel abandonné compté, puis la sonde');
  } finally {
    await t.close();
  }
});

// Revue du 2026-11-13, n° 2 : seuls les champs que l'app envoie partent chez
// OpenRouter, et la sortie d'un appel est plafonnée par le serveur.
test('relais : champs hors liste retirés, max_tokens plafonné, routage réduit à zdr, outils « function » seulement', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [user.email]);
    const messages = [{ role: 'user', content: 'Bonjour' }];
    const tools = [{ type: 'function', function: { name: 'propose_changes', parameters: { type: 'object' } } }];
    const res = await chat(t, token, {
      messages,
      max_tokens: 1_000_000,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      tools,
      tool_choice: 'auto',
      provider: { zdr: true, order: ['cher'], allow_fallbacks: true },
      // Tout ce qui suit coûterait ou contournerait le modèle imposé.
      models: ['anthropic/claude-inconnu'],
      plugins: [{ id: 'web', max_results: 50 }],
      transforms: ['middle-out'],
      route: 'fallback',
      stream: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(t.openRouter.calls[0].body, {
      model: DEFAULT_RELAY_MODEL,
      stream: false,
      messages,
      max_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      tools,
      tool_choice: 'auto',
      provider: { zdr: true },
    });

    // Sans `max_tokens` : le plafond du serveur ; `provider` sans zdr : rien.
    assert.equal((await chat(t, token, { messages, provider: { order: ['cher'] } })).status, 200);
    assert.deepEqual(t.openRouter.calls[1].body, { model: DEFAULT_RELAY_MODEL, stream: false, messages, max_tokens: MAX_COMPLETION_TOKENS });

    // Un outil qu'OpenRouter exécuterait lui-même, ou sans nom : refusé, rien ne part.
    assert.equal((await chat(t, token, { messages, tools: [{ type: 'openrouter:web_search' }] })).status, 400);
    assert.equal((await chat(t, token, { messages, tools: [{ type: 'function' }] })).status, 400);
    // Outils ou schéma de réponse de plusieurs Mo : refusés.
    const huge = 'x'.repeat(MAX_SPEC_CHARS);
    assert.equal((await chat(t, token, { messages, tools: [{ type: 'function', function: { name: 'f', description: huge } }] })).status, 400);
    assert.equal((await chat(t, token, { messages, response_format: { type: 'json_schema', json_schema: { name: huge } } })).status, 400);
    // Parties de message : texte et image en `data:` seulement (ce que le Mur envoie).
    const wall = [{ role: 'user', content: [{ type: 'text', text: 'DA' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
    assert.equal((await chat(t, token, { messages: wall })).status, 200);
    for (const part of [
      { type: 'image_url', image_url: { url: 'https://exemple.test/a.png' } },
      { type: 'file', file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AAAA' } },
      { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
    ])
      assert.equal((await chat(t, token, { messages: [{ role: 'user', content: [part] }] })).status, 400, part.type);
    assert.equal(t.openRouter.calls.length, 3);
  } finally {
    await t.close();
  }
});

// Audit du 2026-11-18, n° 1 et n° 6 : taille des corps du relais. Valeurs
// écrites en clair (et non importées) : sans le correctif, ces tests tournent
// et échouent sur leurs assertions.
const MB = 1024 * 1024;
const CAP = 12 * MB;
const CAP_UNPAID = 8 * MB;
const LARGE = 2 * MB;
const MAX_LARGE = 3;
/** Corps JSON valide d'exactement `bytes` octets (texte ASCII). */
const sized = (bytes: number) => {
  const overhead = JSON.stringify({ messages: [{ role: 'user', content: '' }] }).length;
  return JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(bytes - overhead) }] });
};
/** Corps servi en flux à la demande (rien n'est lu d'avance) ; `read()` dit combien d'octets ont été tirés. */
const lazy = (total: number, chunk = 256 * 1024) => {
  const head = new TextEncoder().encode('{"messages":[{"role":"user","content":"');
  const tail = new TextEncoder().encode('"}]}');
  const fill = new Uint8Array(chunk).fill(0x78);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(out) {
        if (sent === 0) {
          sent += head.length;
          return out.enqueue(head);
        }
        if (sent >= total) return out.close();
        const n = Math.min(chunk, total - tail.length - sent);
        if (n <= 0) {
          sent += tail.length;
          return out.enqueue(tail);
        }
        sent += n;
        out.enqueue(fill.subarray(0, n));
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, read: () => sent };
};
const raw = (t: TestApp, token: string, body: BodyInit, headers: Record<string, string> = {}) =>
  t.app.request('http://server.test/v1/relay/chat', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit);

test('relais : corps plafonné à 12 Mo, 8 Mo pour un compte sans achat (choix de Romain du 2026-11-19) ; Content-Length vérifié avant lecture, corps sans longueur borné en flux', async () => {
  const t = await testApp();
  try {
    const token = await connect(t, user);
    const id = (await t.db.query<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [user.email])).rows[0].id;
    await t.db.query('UPDATE accounts SET credit_cents = 500 WHERE id = $1', [id]);
    const nine = sized(9 * MB);

    // Compte gratuit sans achat : 8 Mo, rien ne part chez OpenRouter au-delà.
    assert.equal((await chat(t, token, JSON.parse(sized(CAP_UNPAID)))).status, 200, '8 Mo tout juste : accepté');
    const unpaid = await t.api('/v1/relay/chat', { token, method: 'POST', headers: { 'content-type': 'application/json' }, body: nine });
    assert.equal(unpaid.status, 413, 'gratuit sans achat : 9 Mo refusés');
    assert.match(String(unpaid.body.error), /trop lourde \(plus de 8 Mo\) pour un compte sans achat/);
    assert.doesNotMatch(String(unpaid.body.error), /\btu\b|\bretire\b|\brecharge\b/i, 'jamais de « tu » ni d’impératif');
    const calls = t.openRouter.calls.length;

    // Content-Length trop grand : 413 sans tirer un octet du corps.
    const untouched = lazy(9 * MB);
    const declared = await raw(t, token, untouched.stream, { 'content-length': String(9 * MB) });
    assert.equal(declared.status, 413);
    assert.equal(untouched.read(), 0, 'corps jamais lu');
    // Content-Length mensonger (annonce 100 octets) : lecture arrêtée au plafond.
    const liar = lazy(64 * MB);
    assert.equal((await raw(t, token, liar.stream, { 'content-length': '100' })).status, 413);
    assert.ok(liar.read() <= CAP_UNPAID + 256 * 1024, `lecture arrêtée au plafond (${liar.read()} octets tirés)`);
    assert.equal(t.openRouter.calls.length, calls, 'aucun appel parti');

    // Achat non rétracté, crédit posé par l'admin, Pro, compte offert : 12 Mo.
    await t.db.query("INSERT INTO purchases (account_id, kind, ref, amount_cents, purchased_at) VALUES ($1, 'credits', 'checkout:cs_test', 500, $2)", [id, t.now()]);
    assert.equal((await raw(t, token, nine)).status, 200, 'avec un achat : 9 Mo acceptés');
    await t.db.query('UPDATE purchases SET withdrawn_at = $2 WHERE account_id = $1', [id, t.now()]);
    assert.equal((await raw(t, token, nine)).status, 413, 'achat rétracté : de nouveau 8 Mo');
    await t.db.query("INSERT INTO credit_events (account_id, delta_cents, reason, ref, created_at) VALUES ($1, 200, 'admin', 'admin:test', $2)", [id, t.now()]);
    assert.equal((await raw(t, token, nine)).status, 200, 'crédit posé par l’admin : 12 Mo');
    await t.db.query("DELETE FROM credit_events WHERE reason = 'admin'");
    await t.db.query("UPDATE accounts SET plan = 'pro', monthly_included_cents = 1100 WHERE id = $1", [id]);
    assert.equal((await raw(t, token, nine)).status, 200, 'Pro : 12 Mo');
    await t.db.query("UPDATE accounts SET plan = 'free', gifted = true WHERE id = $1", [id]);
    assert.equal((await raw(t, token, nine)).status, 200, 'offert : 12 Mo');

    // Au-delà de 12 Mo : refusé pour tous, par Content-Length comme en flux.
    assert.equal((await raw(t, token, sized(CAP))).status, 200, '12 Mo tout juste : accepté');
    const over = await t.api('/v1/relay/chat', { token, method: 'POST', headers: { 'content-type': 'application/json' }, body: sized(CAP + 1) });
    assert.equal(over.status, 413);
    assert.match(String(over.body.error), /trop lourde \(plus de 12 Mo\)/);
    const big = lazy(13 * MB);
    assert.equal((await raw(t, token, big.stream, { 'content-length': String(13 * MB) })).status, 413);
    assert.equal(big.read(), 0, 'Content-Length au-delà de 12 Mo : corps jamais lu');
    const endless = lazy(64 * MB);
    assert.equal((await raw(t, token, endless.stream)).status, 413, 'sans Content-Length : 413');
    assert.ok(endless.read() <= CAP + 256 * 1024, `sans Content-Length : lecture arrêtée au plafond (${endless.read()} octets tirés)`);
  } finally {
    await t.close();
  }
});

test('relais : au plus 3 corps de plus de 2 Mo traités à la fois, tous comptes confondus ; place rendue en succès, en erreur et à la fin du maintien', { timeout: 60_000 }, async () => {
  const t = await testApp();
  try {
    const until = async (ready: () => boolean, what: string) => {
      for (let i = 0; i < 500; i++) {
        if (ready()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`délai dépassé : ${what}`);
    };
    // Cinq comptes offerts (12 Mo, un appel chacun) : la garde est commune à tous.
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = { email: `lourd${i}@example.com`, password: user.password };
      tokens.push(await connect(t, u));
      await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [u.email]);
    }
    const heavy = sized(LARGE + MB);
    let open!: () => void;
    // OpenRouter retient les appels lourds jusqu'à `open()` ; les petits répondent tout de suite.
    const hold = () => {
      const gate = new Promise<void>((r) => (open = r));
      t.openRouter.state.reply = async (call) => {
        if (JSON.stringify(call.body).length > LARGE) await gate;
        return completion();
      };
    };
    // Réponse, ou « en attente » au bout de 2 s (sans le correctif, la requête attendrait OpenRouter).
    const soon = async <T,>(p: T | Promise<T>) =>
      Promise.race<T | { status: string }>([p, new Promise<{ status: string }>((r) => setTimeout(() => r({ status: 'en attente' }), 2000))]);

    // Trois corps lourds en cours (lus en flux, dont un annoncé par Content-Length).
    hold();
    let base = t.openRouter.calls.length;
    const running = [
      raw(t, tokens[0], heavy),
      raw(t, tokens[1], heavy),
      raw(t, tokens[2], heavy, { 'content-length': String(heavy.length) }),
    ];
    await until(() => t.openRouter.calls.length === base + MAX_LARGE, 'trois appels lourds partis');
    const fourth = await soon(t.api('/v1/relay/chat', { token: tokens[3], method: 'POST', headers: { 'content-type': 'application/json' }, body: heavy }));
    assert.equal(fourth.status, 429, 'quatrième corps lourd refusé');
    assert.match(String('body' in fourth ? fourth.body.error : ''), /plusieurs requêtes lourdes/);
    assert.doesNotMatch(String('body' in fourth ? fourth.body.error : ''), /\btu\b|\bréessaie\b|\battends\b/i);
    const declared = await soon(raw(t, tokens[3], heavy, { 'content-length': String(heavy.length) }));
    assert.equal(declared.status, 429, 'annoncé par Content-Length : refusé aussi');
    assert.equal((await chat(t, tokens[4])).status, 200, 'un petit corps passe pendant ce temps');
    open();
    for (const r of await Promise.all(running)) assert.equal(r.status, 200);
    t.openRouter.state.reply = () => completion();
    assert.equal((await raw(t, tokens[3], heavy)).status, 200, 'places rendues : le quatrième passe');

    // Échecs : 502 d'OpenRouter, 400 du schéma, 413 en flux après 2 Mo ; chaque place est rendue.
    t.openRouter.state.reply = () => Response.json({ error: { message: 'down' } }, { status: 500 });
    for (let i = 0; i < MAX_LARGE + 1; i++) assert.equal((await raw(t, tokens[i], heavy)).status, 502);
    t.openRouter.state.reply = () => completion();
    const invalid = JSON.stringify({ messages: [], pad: 'x'.repeat(LARGE + MB) });
    for (let i = 0; i < MAX_LARGE + 1; i++) assert.equal((await raw(t, tokens[i], invalid)).status, 400);
    for (let i = 0; i < MAX_LARGE + 1; i++) assert.equal((await raw(t, tokens[i], lazy(CAP + MB).stream)).status, 413);
    hold();
    base = t.openRouter.calls.length;
    const again = [0, 1, 2].map((i) => raw(t, tokens[i], heavy));
    await until(() => t.openRouter.calls.length === base + MAX_LARGE, 'trois appels lourds repartis');
    open();
    for (const r of await Promise.all(again)) assert.equal(r.status, 200, 'aucune place perdue dans les échecs');

    // Maintien : la place est tenue tant que l'appel court (réponse 200 déjà partie), puis rendue.
    hold();
    base = t.openRouter.calls.length;
    const streams = await Promise.all([0, 1, 2].map((i) => raw(t, tokens[i], heavy, { 'x-ds-keepalive': '1' })));
    for (const s of streams) assert.equal(s.status, 200);
    await until(() => t.openRouter.calls.length === base + MAX_LARGE, 'appels du maintien partis');
    assert.equal((await soon(raw(t, tokens[3], heavy))).status, 429, 'places tenues pendant le maintien');
    open();
    for (const s of streams) await s.text();
    t.openRouter.state.reply = () => completion();
    assert.equal((await raw(t, tokens[3], heavy)).status, 200, 'places rendues à la fin du maintien');
  } finally {
    await t.close();
  }
});

// Relecture du 2026-11-19 : la place d'un corps lourd n'est prise qu'au
// passage réel des 2 Mo, jamais sur la seule annonce ; une lecture qui
// traîne est abandonnée (408) ; au plus MAX_READING corps en lecture.
// Délais larges et relances plutôt qu'attentes fixes : stable sur une CI lente.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Début d'un corps JSON, puis `bytes` octets, puis plus rien. */
const stalled = (bytes = 0) =>
  new ReadableStream<Uint8Array>({
    start(out) {
      out.enqueue(new TextEncoder().encode('{"messages":[{"role":"user","content":"'));
      if (bytes) out.enqueue(new Uint8Array(bytes).fill(0x78));
    },
  });
/** Relance `call` jusqu'au statut voulu (5 s au plus) ; rend le dernier statut obtenu. */
const retryUntil = async (status: number, call: () => Response | Promise<Response>) => {
  let last = 0;
  for (let i = 0; i < 100 && last !== status; i++) {
    last = (await call()).status;
    if (last !== status) await sleep(50);
  }
  return last;
};
async function mutedAccounts(t: TestApp, prefix: string, n: number) {
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = { email: `${prefix}${i}@example.com`, password: user.password };
    tokens.push(await connect(t, u));
    await t.db.query('UPDATE accounts SET gifted = true WHERE email = $1', [u.email]);
  }
  return tokens;
}

test('relais : place lourde prise sur les octets reçus, pas sur l’annonce ; lecture muette abandonnée en 408', { timeout: 60_000 }, async () => {
  const t = await testApp({ relayReadMs: 3000 });
  try {
    const tokens = await mutedAccounts(t, 'muet', 4);
    const heavy = sized(LARGE + MB);

    // Trois clients annoncent 9 Mo et n'envoient presque rien. 500 ms suffisent
    // à l'ancien code pour prendre les trois places sur l'annonce (quelques
    // requêtes en base) ; le Mur d'un quatrième passe quand même.
    const mute = [0, 1, 2].map((i) => raw(t, tokens[i], stalled(10), { 'content-length': String(9 * MB) }));
    await sleep(500);
    assert.equal((await raw(t, tokens[3], heavy)).status, 200, 'annonce seule : aucune place prise');
    for (const r of await Promise.all(mute)) {
      assert.equal(r.status, 408);
      assert.match(String((await r.json()).error), /trop lente/);
    }

    // Trois clients passent 2 Mo puis se taisent : places prises, rendues au délai.
    const slow = [0, 1, 2].map((i) => raw(t, tokens[i], stalled(LARGE + MB)));
    assert.equal(await retryUntil(429, () => raw(t, tokens[3], heavy)), 429, 'places prises au passage des 2 Mo');
    for (const r of await Promise.all(slow)) assert.equal(r.status, 408);
    assert.equal((await raw(t, tokens[3], heavy)).status, 200, 'places rendues après le 408');
  } finally {
    await t.close();
  }
});

test('relais : envoi au compte-gouttes coupé au délai total (4 × délai sans octet)', { timeout: 60_000 }, async () => {
  const idle = 300;
  const t = await testApp({ relayReadMs: idle });
  try {
    const [token] = await mutedAccounts(t, 'goutte', 1);
    // Un octet toutes les idle/3 : jamais muet assez longtemps, coupé à 4 × idle.
    let timer: ReturnType<typeof setInterval> | undefined;
    const trickle = new ReadableStream<Uint8Array>({
      start(out) {
        out.enqueue(new TextEncoder().encode('{"messages":[{"role":"user","content":"'));
        timer = setInterval(() => out.enqueue(new Uint8Array([0x78])), idle / 3);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    const started = Date.now();
    const cut = await raw(t, token, trickle);
    clearInterval(timer);
    const took = Date.now() - started;
    assert.equal(cut.status, 408);
    // Borne haute large : elle compte aussi le compte, le plafond et l'usage lus avant la lecture.
    assert.ok(took >= 4 * idle - 50 && took < 12 * idle, `coupé au délai total (${took} ms)`);
  } finally {
    await t.close();
  }
});

test('relais : au plus 20 corps en lecture à la fois, tous comptes confondus', { timeout: 60_000 }, async () => {
  const t = await testApp({ relayReadMs: 3000 });
  try {
    const tokens = await mutedAccounts(t, 'lecteur', MAX_READING + 1);
    const small = () => raw(t, tokens[MAX_READING], JSON.stringify({ messages: [{ role: 'user', content: 'bonjour' }] }));
    const waiting = tokens.slice(0, MAX_READING).map((tok) => raw(t, tok, stalled()));
    assert.equal(await retryUntil(429, small), 429, 'vingt lectures en cours : la suivante refusée');
    const refused = await small();
    assert.equal(refused.status, 429);
    assert.match(String((await refused.json()).error), /beaucoup de requêtes/);
    for (const r of await Promise.all(waiting)) assert.equal(r.status, 408);
    assert.equal((await small()).status, 200, 'places de lecture rendues');
  } finally {
    await t.close();
  }
});
