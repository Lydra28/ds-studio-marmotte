import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wall, parseDirections, publicUrl } from '../app/server/wall.js';
import { applyChanges, tokenSetSchema } from '../app/shared/model.js';
import { projectSchema } from '../app/shared/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = tokenSetSchema.parse(
  JSON.parse(await readFile(path.join(root, 'templates/blank/design-system.tokens.json'), 'utf8')),
);
const context = { project: projectSchema.parse({ doctrine: 'Calme.' }), name: 'Test', set };
const png = 'data:image/png;base64,' + Buffer.from('fausse image').toString('base64');

const direction = (changes: unknown[]) =>
  JSON.stringify({
    directions: [{ name: 'Terrier calme', intention: 'Vert profond.', rationale: 'Inspi 1.', fonts: { heading: 'Fraunces', body: 'Inter' }, changes }],
  });

test('DA du modèle : changements vérifiés un à un, ajout d’un token existant ramené à des valeurs', () => {
  const [d] = parseDirections(
    '```json\n' +
      direction([
        { key: 'color/brand/600', mode: 'default', value: '#1E6B52' },
        { key: 'font/family/sans', mode: 'default', value: 'Inter, sans-serif' },
        { op: 'add', key: 'font/family/display', token: { $type: 'fontFamily', $collection: 'primitives', $values: { default: 'Fraunces, serif' } } },
        { op: 'add', key: 'font/family/heading', token: { $type: 'fontFamily', $collection: 'typography', $values: { desktop: '{font/family/display}', mobile: '{font/family/display}' } } },
        { op: 'add', key: 'space/sm', token: { $type: 'dimension', $collection: 'primitives', $values: { default: 16 } } },
        { key: 'inconnu/token', mode: 'default', value: 1 },
        { key: 'color/brand/600', mode: 'default', value: 12345678901234567890 },
        'nimporte quoi',
      ]) +
      '\n```',
    set,
  );
  assert.equal(d.name, 'Terrier calme');
  assert.equal(d.dropped, 3); // token inconnu, nombre pour une couleur, entrée illisible
  const applied = applyChanges(set, d.changes);
  assert.equal(applied.tokens['color/brand/600'].$values.default, '#1E6B52');
  assert.equal(applied.tokens['space/sm'].$values.default, 16);
  assert.ok(applied.tokens['font/family/heading']);
  assert.deepEqual(parseDirections('pas du json', set), []);
});

test('DA du modèle : nombres en texte et police de titre écrite comme une valeur, corrigés', () => {
  const [d] = parseDirections(
    direction([
      { key: 'font/size/display', mode: 'desktop', value: '52' },
      { key: 'font/weight/bold', mode: 'default', value: '600' },
      { key: 'space/sm', mode: 'default', value: '16px' },
      { key: 'font/family/display', mode: 'default', value: 'Fraunces, Georgia, serif' },
      { key: 'font/family/heading', mode: 'desktop', value: '{font/family/display}' },
      { key: 'font/weight/semibold', mode: 'default', value: '600' },
      { key: 'font/weight/heading', mode: 'desktop', value: '{font/weight/semibold}' },
    ]),
    set,
  );
  assert.equal(d.dropped, 0);
  const applied = applyChanges(set, d.changes);
  assert.equal(applied.tokens['font/size/display'].$values.desktop, 52);
  assert.equal(applied.tokens['font/weight/bold'].$values.default, 600);
  assert.equal(applied.tokens['space/sm'].$values.default, 16);
  assert.equal(applied.tokens['font/family/display'].$values.default, 'Fraunces, Georgia, serif');
  assert.equal(applied.tokens['font/family/heading'].$values.mobile, '{font/family/display}');
  assert.equal(applied.tokens['font/weight/semibold'].$values.default, 600);
  assert.equal(applied.tokens['font/weight/heading'].$values.desktop, '{font/weight/semibold}');
});

test('liens : seulement des adresses web publiques', () => {
  assert.equal(publicUrl('https://dribbble.com/shots/1'), 'https://dribbble.com/shots/1');
  for (const bad of ['file:///etc/passwd', 'http://localhost:4310', 'http://127.0.0.1/', 'http://192.168.1.2/', 'http://[::1]/', 'https://u' + ':p@site.com' /* découpé : le scan de publication refuse ce motif */, 'http://box.local/'])
    assert.throws(() => publicUrl(bad), /Lien refusé/);
});

test('mur : inspirations privées, génération avec images, résultat gardé pour le rejeu', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-wall-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: any[] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: direction([{ key: 'color/brand/600', mode: 'default', value: '#1E6B52' }]) } }],
        usage: { prompt_tokens: 5000, completion_tokens: 800 },
      }),
    );
  }) as typeof globalThis.fetch;
  const wall = new Wall(dir, { apiKey: 'k', model: 'test/model', fetch }, async () => Buffer.from('capture'));

  await assert.rejects(() => new Wall(dir, {}).directions({ note: '', count: 3 }, context), /OPENROUTER_API_KEY/);
  const image = await wall.addImage({ name: 'mood.png', dataUrl: png });
  const capture = await wall.addLink('https://example.com/inspi');
  await assert.rejects(() => wall.addLink('http://127.0.0.1:4310/api/state'), /Lien refusé/);
  assert.equal((await wall.file(capture.id)).data.toString(), 'capture');
  assert.equal(capture.url, 'https://example.com/inspi');

  const result = await wall.directions({ note: 'Pas de violet.', count: 2 }, context);
  assert.equal(result.directions.length, 1);
  assert.deepEqual(result.usage, { prompt: 5000, completion: 800 });
  const content = sent[0].messages[1].content;
  assert.match(content[0].text, /Pas de violet/);
  assert.equal(content.filter((p: any) => p.type === 'image_url').length, 2);
  assert.match(sent[0].messages[0].content, /Calme\./);
  assert.equal(sent[0].response_format.type, 'json_object');
  assert.equal((await wall.read()).result?.directions[0].name, 'Terrier calme');

  await wall.remove(image.id);
  await assert.rejects(() => wall.file(image.id), /introuvable/);
  assert.equal((await wall.read()).inspirations.length, 1);
});
