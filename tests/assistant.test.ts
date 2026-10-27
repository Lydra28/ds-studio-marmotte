import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assistant } from '../app/server/assistant.js';
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
