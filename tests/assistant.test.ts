import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assistant, askSchema, selectionFindings } from '../app/server/assistant.js';
import { tokenSetSchema } from '../app/shared/model.js';
import { projectSchema } from '../app/shared/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = tokenSetSchema.parse(
  JSON.parse(await readFile(path.join(root, 'templates/blank/design-system.tokens.json'), 'utf8')),
);
const project = projectSchema.parse({ doctrine: 'Protéger avant de gagner.' });
const context = { project, name: 'Test', set };

// Réponse simulée d'OpenRouter : jamais d'appel réseau dans les tests.
function fake(message: unknown, seen: { body?: any; auth?: string }[] = []) {
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 900, completion_tokens: 40 } }));
  }) as typeof fetch;
}

test('assistant : désactivé sans clé, contexte du projet envoyé, propositions vérifiées, jamais écrites', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-assistant-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(() => new Assistant(dir, {}).chat('Bonjour', context), /OPENROUTER_API_KEY/);

  const seen: { body?: any; auth?: string }[] = [];
  const valid = new Assistant(dir, {
    apiKey: 'sk-test-secret',
    model: 'test/model',
    fetch: fake(
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
  });
  const [question, reply] = await valid.chat('Corrige mes espacements', context);
  assert.equal(question.role, 'user');
  assert.equal(reply.proposal?.changes.length, 1);
  assert.deepEqual(reply.usage, { prompt: 900, completion: 40 });
  assert.equal(seen[0].auth, 'Bearer sk-test-secret');
  assert.equal(seen[0].body.model, 'test/model');
  assert.match(seen[0].body.messages[0].content, /Protéger avant de gagner/);
  assert.match(seen[0].body.messages[0].content, /space\/sm/);
  // Conversation gardée par projet, sans la clé.
  const stored = await readFile(path.join(dir, 'assistant.json'), 'utf8');
  assert.equal(JSON.parse(stored).length, 2);
  assert.doesNotMatch(stored, /sk-test-secret/);

  const invalid = new Assistant(dir, {
    apiKey: 'k',
    fetch: fake({
      content: '',
      tool_calls: [
        { function: { name: 'propose_changes', arguments: JSON.stringify({ reason: 'x', changes: [{ key: 'inexistant/token', mode: 'default', value: 1 }] }) } },
      ],
    }),
  });
  const [, rejected] = await invalid.chat('Change un token inconnu', context);
  assert.equal(rejected.proposal, undefined);
  assert.match(rejected.content, /Proposition écartée/);
  assert.equal((await invalid.history()).length, 4);
  await invalid.reset();
  assert.equal((await invalid.history()).length, 0);

  const refused = new Assistant(dir, {
    apiKey: 'k',
    fetch: (async () => new Response(JSON.stringify({ error: { message: 'No credits' } }), { status: 402 })) as typeof fetch,
  });
  await assert.rejects(() => refused.chat('?', context), /refusé la requête \(402\) : No credits/);
  assert.equal((await refused.history()).length, 0);
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

  await assert.rejects(() => new Assistant(dir, {}).ask(askSchema.parse({ message: 'Bonjour' }), context), /OPENROUTER_API_KEY/);
  const seen: { body?: any }[] = [];
  const assistant = new Assistant(dir, { apiKey: 'k', fetch: fake({ content: 'Passe le gap à 16 px (space/md).' }, seen) });
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

  const empty = new Assistant(dir, { apiKey: 'k', fetch: fake({ content: '' }) });
  await assert.rejects(() => empty.ask(askSchema.parse({ message: '?' }), context), /Réponse vide/);
});
