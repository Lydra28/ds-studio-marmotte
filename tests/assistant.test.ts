import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assistant, DEFAULT_MODEL, askSchema, parseProposal, selectionFindings } from '../app/server/assistant.js';
import { tokenSetSchema } from '../app/shared/model.js';
import { projectSchema } from '../app/shared/project.js';
import { FAKE_TOKEN, fakeAccount, type FakeCall } from './fake-account.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = tokenSetSchema.parse(
  JSON.parse(await readFile(path.join(root, 'templates/blank/design-system.tokens.json'), 'utf8')),
);
const project = projectSchema.parse({ doctrine: 'Protéger avant de gagner.' });
const context = { project, name: 'Test', set };

// Réponse simulée du relais (serveur DS-Studio → OpenRouter) : jamais d'appel réseau dans les tests.
function fake(message: unknown, seen: { body?: any; auth?: string; origin?: string }[] = []) {
  return (call: FakeCall) => {
    seen.push({ body: call.body, auth: call.headers.authorization, origin: call.headers['x-ds-origin'] });
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } }));
  };
}

test('assistant : indisponible sans compte, contexte envoyé par le relais, propositions vérifiées, jamais écrites', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const none = new Assistant(dir, {});
  assert.deepEqual(none.status, { enabled: false, reason: 'account', model: DEFAULT_MODEL });
  await assert.rejects(() => none.chat('Bonjour', context), /connecte-toi/i);

  const seen: { body?: any; auth?: string; origin?: string }[] = [];
  const valid = new Assistant(dir, {
    model: 'test/model',
    account: await fakeAccount(
      fake(
        {
          content: 'Je te propose 16 px.',
          tool_calls: [
            {
              function: {
                name: 'propose_changes',
                arguments: JSON.stringify({ reason: 'Multiple de 4.', changes: [{ key: 'space/sm', mode: 'default', value: 16 }] }),
              },
            },
          ],
        },
        seen,
      ),
      dir,
    ),
  });
  assert.deepEqual(valid.status, { enabled: true, reason: null, model: 'test/model' });
  const [question, reply] = await valid.chat('Corrige mes espacements', context);
  assert.equal(question.role, 'user');
  assert.equal(reply.proposal?.changes.length, 1);
  assert.deepEqual(reply.usage, { prompt: 900, completion: 40 });
  // Le relais reçoit le jeton de session et l'origine, jamais une clé.
  assert.equal(seen[0].auth, `Bearer ${FAKE_TOKEN}`);
  assert.equal(seen[0].origin, 'assistant');
  assert.equal(seen[0].body.model, 'test/model');
  assert.match(seen[0].body.messages[0].content, /Protéger avant de gagner/);
  assert.match(seen[0].body.messages[0].content, /space\/sm/);
  // Conversation gardée par projet, sans le jeton.
  const stored = await readFile(path.join(dir, 'assistant.json'), 'utf8');
  assert.equal(JSON.parse(stored).length, 2);
  assert.doesNotMatch(stored, new RegExp(FAKE_TOKEN));

  const invalid = new Assistant(dir, {
    account: await fakeAccount(
      fake({
        content: '',
        tool_calls: [
          { function: { name: 'propose_changes', arguments: JSON.stringify({ reason: 'x', changes: [{ key: 'inexistant/token', mode: 'default', value: 1 }] }) } },
        ],
      }),
      dir,
    ),
  });
  const [, rejected] = await invalid.chat('Change un token inconnu', context);
  assert.equal(rejected.proposal, undefined);
  assert.match(rejected.content, /Proposition écartée/);
  assert.equal((await invalid.history()).length, 4);
  await invalid.reset();
  assert.equal((await invalid.history()).length, 0);

  // Refus du serveur (solde nul) : son message et son statut, rien d'enregistré.
  const refused = new Assistant(dir, {
    account: await fakeAccount(
      () => new Response(JSON.stringify({ error: 'Solde de crédits à zéro : recharge des crédits pour utiliser l’agent et le Mur.' }), { status: 402 }),
      dir,
    ),
  });
  await assert.rejects(
    () => refused.chat('?', context),
    (e: Error & { status: number }) => e.status === 402 && /Solde de crédits à zéro/.test(e.message),
  );
  assert.equal((await refused.history()).length, 0);
  // Serveur injoignable : message clair, panneau grisé, conversation intacte.
  const offline = new Assistant(dir, {
    account: await fakeAccount(() => {
      throw new TypeError('fetch failed');
    }, dir),
  });
  await assert.rejects(() => offline.chat('?', context), /injoignable/);
  assert.deepEqual(offline.status, { enabled: false, reason: 'offline', model: DEFAULT_MODEL });
  assert.equal((await offline.history()).length, 0);
});

test('assistant : tour vide du modèle relancé une fois', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const replies = [
    { content: null },
    { content: '', tool_calls: [{ function: { name: 'propose_changes', arguments: JSON.stringify({ reason: 'x', changes: [{ key: 'space/sm', mode: 'default', value: 16 }] }) } }] },
  ];
  let calls = 0;
  const retried = new Assistant(dir, {
    account: await fakeAccount(() => new Response(JSON.stringify({ choices: [{ message: replies[calls++] }] })), dir),
  });
  const [, reply] = await retried.chat('Corrige', context);
  assert.equal(calls, 2);
  assert.equal(reply.proposal?.changes.length, 1);
  const silent = new Assistant(dir, { account: await fakeAccount(fake({ content: null }), dir) });
  const [, none] = await silent.chat('Corrige', context);
  assert.match(none.content, /Pas de réponse du modèle, deux fois/);
  // Réponse coupée par la limite de longueur : message clair, pas de balises brutes.
  const cut = new Assistant(dir, {
    account: await fakeAccount(
      () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Je regarde <｜DSML｜ invoke' } }] })),
      dir,
    ),
  });
  const [, truncated] = await cut.chat('Corrige', context);
  assert.match(truncated.content, /Réponse coupée/);
});

test('assistant : nombre écrit en texte corrigé comme au Mur des DA, format illisible expliqué', () => {
  // Cas vu en recette sur Devonia : {"value":"16"} pour une taille → proposition écartée.
  const ok = parseProposal(JSON.stringify({ reason: 'x', changes: [{ key: 'space/sm', mode: 'default', value: '16' }] }), set);
  assert.ok(!('error' in ok));
  assert.deepEqual(ok.changes, [{ key: 'space/sm', mode: 'default', value: 16 }]);
  const px = parseProposal(JSON.stringify({ reason: 'x', changes: [{ key: 'space/sm', mode: 'default', value: '16px' }] }), set);
  assert.ok(!('error' in px));
  assert.deepEqual(px.changes, [{ key: 'space/sm', mode: 'default', value: 16 }]);
  const bad = parseProposal(JSON.stringify({ reason: 'x', changes: [{ key: 'space/sm', valeur: 16 }] }), set);
  assert.match('error' in bad ? String(bad.error) : '', /^format invalide \(/);
});

test('assistant du plugin Figma : texte seulement, sélection envoyée si cochée, écarts relevés, rien d’écrit', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-ask-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nodes = [
    {
      name: 'Carte',
      type: 'FRAME',
      depth: 0,
      gap: { v: 14, var: null },
      padding: [{ v: 16, var: 'space/md' }, { v: 18, var: null }, { v: 2, var: null }, { v: 16, var: null }],
      fills: [{ hex: '#ffffff', var: 'bg/surface' }, { hex: '#ff0000', var: null }],
    },
    { name: 'Titre', type: 'TEXT', depth: 1, text: { size: { v: 11, var: null }, family: 'Inter' } },
    { name: 'bouton principal', type: 'COMPONENT_SET', depth: 0 },
  ];
  const findings = selectionFindings(askSchema.parse({ message: 'x', selection: { file: 'F', nodes } }).selection!.nodes);
  assert.ok(findings.includes('Carte : gap de 14 px, hors grille de 4 (16 px).'));
  assert.ok(findings.includes('Carte : padding droit de 18 px, hors grille de 4 (20 px).'));
  assert.ok(!findings.some((f) => /padding (haut|bas)/.test(f))); // token lié, 2 px admis
  assert.ok(findings.includes('Carte : couleur #ff0000 saisie à la main, sans token.'));
  assert.ok(findings.includes('Titre : texte de 11 px, sous le minimum de 12 px.'));
  assert.ok(findings.some((f) => /^bouton principal : .*Button/.test(f)));
  assert.equal(askSchema.safeParse({ message: 'x', selection: { file: 'F', nodes: [{ ...nodes[0], script: 'x' }] } }).success, false);

  await assert.rejects(() => new Assistant(dir, {}).ask(askSchema.parse({ message: 'Bonjour' }), context), /connecte-toi/i);
  const seen: { body?: any; origin?: string }[] = [];
  const assistant = new Assistant(dir, { account: await fakeAccount(fake({ content: 'Passe le gap à 16 px (space/md).' }, seen), dir) });
  const res = await assistant.ask(
    askSchema.parse({
      message: 'Ma carte respecte-t-elle le DS ?',
      history: [{ role: 'user', content: 'Avant' }, { role: 'assistant', content: 'Réponse' }],
      selection: { file: 'Maquettes', nodes },
    }),
    context,
  );
  assert.equal(res.reply, 'Passe le gap à 16 px (space/md).');
  assert.ok(res.findings.length >= 5);
  const body = seen[0].body;
  assert.equal(seen[0].origin, 'assistant');
  assert.equal(body.tools, undefined); // pas d'outil : aucune proposition possible
  assert.match(body.messages[0].content, /Protéger avant de gagner/);
  assert.match(body.messages[0].content, /« Maquettes »/);
  assert.match(body.messages[0].content, /hors grille de 4/);
  assert.deepEqual(body.messages.slice(1).map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);

  // Envoi décoché : rien du fichier ne part.
  await assistant.ask(askSchema.parse({ message: 'Comment nommer mes variantes ?' }), context);
  assert.match(seen[1].body.messages[0].content, /Aucune sélection envoyée/);
  assert.doesNotMatch(seen[1].body.messages[0].content, /Carte/);
  assert.equal((await assistant.history()).length, 0); // conversation de l'atelier intacte

  const empty = new Assistant(dir, { account: await fakeAccount(fake({ content: '' }), dir) });
  await assert.rejects(() => empty.ask(askSchema.parse({ message: '?' }), context), /Réponse vide/);
});
