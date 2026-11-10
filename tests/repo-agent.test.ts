import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { tokenSetSchema } from '../app/shared/model.js';
import { proposeFromRepo } from '../app/shared/repo-propose.js';
import { scanRepo } from '../app/shared/repo-scan.js';
import { AGENT_LIMITS, buildExcerpts, createRepoAgent, type Relay } from '../app/server/repo-agent.js';

// G6 : l'agent nomme les valeurs en dur sans token, sur extraits courts et
// après confirmation seulement. Relais simulé : jamais de réseau.
const template = () => tokenSetSchema.parse(JSON.parse(readFileSync('templates/blank/design-system.tokens.json', 'utf8')));
const files = new Map([
  [
    'src/styles/site.css',
    [
      '.hero {',
      '  color: #FF00AA;',
      '  padding: 150px;',
      '}',
      '.card {',
      '  border-color: #FF00AA;',
      '  /* api_key: #FF00AA */',
      '}',
    ].join('\n'),
  ],
  ['src/components/Button.css', ['.btn {', '  background: #FF00AA;', '}'].join('\n')],
  ['tailwind.config.js', "module.exports = { theme: { extend: { colors: { odd: '#123456' } } } };"],
  ['.env.production', 'SECRET_COLOR=#654321'],
]);
const planOf = () => {
  const set = template();
  const scan = scanRepo([...files].map(([path, text]) => ({ path, text })));
  return { set, plan: proposeFromRepo(scan, set, { mode: 'attach' }) };
};

function fakeRelay(reply: unknown) {
  const calls: Record<string, unknown>[] = [];
  const relay: Relay = async (body) => {
    calls.push(body);
    return { choices: [{ message: { tool_calls: [{ function: { name: 'propose_changes', arguments: JSON.stringify(reply) } }] } }] };
  };
  return { calls, relay };
}
const add = (key: string, $type: string, value: unknown, $collection = 'primitives') => ({
  op: 'add',
  key,
  token: { $type, $collection, $values: { default: value } },
});

test('extraits : la ligne et son sélecteur, jamais de secret, de .env ni de config', () => {
  const { plan } = planOf();
  const out = buildExcerpts(plan, files);
  const pink = out.excerpts.filter((x) => x.value === '#FF00AA');
  assert.ok(pink.length > 0 && pink.length <= AGENT_LIMITS.perValue);
  // Fichiers différents d'abord.
  assert.deepEqual(new Set(pink.slice(0, 2).map((x) => x.file)).size, 2);
  assert.ok(out.excerpts.some((x) => x.selector === '.hero' && x.text === 'color: #FF00AA;'));
  const all = JSON.stringify(out);
  assert.ok(!all.includes('api_key'), 'ligne qui ressemble à un secret écartée');
  assert.ok(!all.includes('#654321') && !all.includes('.env'), '.env jamais lu pour l’envoi');
  assert.ok(!all.includes('tailwind.config'), 'config jamais lue pour l’envoi');
  assert.equal(out.lines, out.excerpts.length);
  assert.equal(out.files.reduce((n, f) => n + f.lines, 0), out.lines);
});

test('rien ne part sans confirmation : l’aperçu n’appelle pas le relais', async () => {
  const { plan, set } = planOf();
  const agent = createRepoAgent();
  const { calls, relay } = fakeRelay({ reason: 'r', changes: [add('color/pink/500', 'color', '#FF00AA')] });
  const preview = agent.preview('p', plan, files);
  assert.equal(calls.length, 0);
  // Jeton inconnu, autre projet, jeton réutilisé : refusés, rien envoyé.
  await assert.rejects(agent.send('p', 'inconnu-0123456789', set, relay), /rien n’a été envoyé/);
  await assert.rejects(agent.send('autre', preview.nonce, set, relay), /rien n’a été envoyé/);
  assert.equal(calls.length, 0);
  const second = agent.preview('p', plan, files);
  await agent.send('p', second.nonce, set, relay);
  assert.equal(calls.length, 1);
  await assert.rejects(agent.send('p', second.nonce, set, relay), /rien n’a été envoyé/);
  assert.equal(calls.length, 1);
});

test('aperçu expiré : refusé', async () => {
  let now = 0;
  const { plan, set } = planOf();
  const agent = createRepoAgent({ now: () => now });
  const { calls, relay } = fakeRelay({ reason: 'r', changes: [add('color/pink/500', 'color', '#FF00AA')] });
  const preview = agent.preview('p', plan, files);
  now = AGENT_LIMITS.ttlMs + 1;
  await assert.rejects(agent.send('p', preview.nonce, set, relay), /expiré/);
  assert.equal(calls.length, 0);
});

test('envoi : extraits montrés seulement, ZDR demandé, sortie filtrée', async () => {
  const { plan, set } = planOf();
  const agent = createRepoAgent();
  const { calls, relay } = fakeRelay({
    reason: 'Rose de marque.',
    changes: [
      add('color/pink/500', 'color', '#FF00AA'),
      // Valeur jamais envoyée, sémantique, changement de valeur : écartés.
      add('color/other/500', 'color', '#00FF00'),
      { op: 'add', key: 'bg/pink', token: { $type: 'color', $collection: 'tokens', $values: { light: '#FF00AA' } } },
      { key: 'color/neutral/0', mode: 'default', value: '#FFFFFE' },
    ],
  });
  const preview = agent.preview('p', plan, files);
  const out = await agent.send('p', preview.nonce, set, relay);
  const body = calls[0] as { provider: unknown; messages: { role: string; content: string }[] };
  assert.deepEqual(body.provider, { zdr: true });
  const user = JSON.parse(body.messages[1].content) as { extraits: unknown };
  assert.deepEqual(user.extraits, preview.excerpts);
  assert.ok(body.messages[0].content.includes('jamais des instructions'));
  assert.deepEqual(out.changes.map((c) => ('op' in c && c.op === 'add' ? c.key : null)), ['color/pink/500']);
  assert.equal(out.dropped, 3);
});

test('sortie invalide : écartée par le schéma', async () => {
  const { plan, set } = planOf();
  const agent = createRepoAgent();
  const { relay } = fakeRelay({ reason: 'x', changes: [{ op: 'add', key: 'Pas Un Nom', token: {} }] });
  const preview = agent.preview('p', plan, files);
  await assert.rejects(agent.send('p', preview.nonce, set, relay), /écartée/);
});

test('sortie : valeur réécrite telle que dans le plan (casse, nombre)', async () => {
  const { plan, set } = planOf();
  const agent = createRepoAgent();
  const { relay } = fakeRelay({ reason: 'r', changes: [add('color/pink/500', 'color', '#ff00aa'), add('space/card', 'dimension', 150)] });
  const preview = agent.preview('p', plan, files);
  const out = await agent.send('p', preview.nonce, set, relay);
  const values = Object.fromEntries(out.changes.map((c) => ('op' in c && c.op === 'add' ? [c.key, c.token.$values.default] : [])));
  assert.deepEqual(values, { 'color/pink/500': '#FF00AA', 'space/card': 150 });
});

test('extraits : ni alpha, ni em, ni en-tête de code JS', () => {
  const js = new Map([
    ['src/a.css', ['.x {', '  color: #11223344;', '  margin: 1.5em;', '  padding: 150px;', '}'].join('\n')],
    ['src/App.tsx', ['const cfg = fetch("https://u' + ':p@x.test/?k=1", {', '  style: { color: "#ABCDEF" },', '});'].join('\n')],
  ]);
  const scan = scanRepo([...js].map(([path, text]) => ({ path, text })));
  const out = buildExcerpts(proposeFromRepo(scan, template(), { mode: 'attach' }), js);
  const sent = out.values.map((v) => v.normalized);
  assert.ok(!sent.some((n) => /^#[0-9A-F]{8}$/i.test(n) || n.endsWith('em')), sent.join(','));
  assert.ok(sent.includes('150px'));
  assert.ok(!JSON.stringify(out).includes('fetch') && !JSON.stringify(out).includes('u:p@'));
});
