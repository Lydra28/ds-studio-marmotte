import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, openInstance, slugify } from '../app/server/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'templates/blank/design-system.tokens.json');

test('projets : liste, création vierge au nom unique, lien Figma vérifié, instance fixe sans création', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-projects-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json', 'components.json'])
    await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  const registry = Registry.folder(dir, template);
  assert.deepEqual((await registry.list()).map((p) => p.slug), ['marmotte']);

  await assert.rejects(() => registry.create({ name: 'X', figmaUrl: 'https://evil.test/x' }), /Lien Figma/);
  const a = await registry.create({
    name: 'Atelier Céramique',
    doctrine: 'Calme.',
    figmaUrl: 'https://www.figma.com/design/abcdefghijklmnopqrstuv/Ceramique?node-id=1-2',
  });
  const b = await registry.create({ name: 'Atelier céramique' });
  assert.equal(a, 'atelier-ceramique');
  assert.equal(b, 'atelier-ceramique-2');
  const config = JSON.parse(await readFile(path.join(dir, a, 'project.config.json'), 'utf8'));
  assert.equal(config.figma.fileKey, 'abcdefghijklmnopqrstuv');
  const created = await registry.get(a);
  assert.equal(created.store.snapshot().revision, 0);
  assert.equal(created.store.snapshot().set.components, undefined);
  assert.equal((await created.brief.read()).project.doctrine, 'Calme.');
  assert.equal((await registry.get('marmotte')).store.snapshot().set.components?.Button?.status, 'figma');
  await assert.rejects(() => registry.get('../marmotte'), /invalide/);
  await assert.rejects(() => registry.get('absent'), /introuvable/);

  const single = Registry.single(await openInstance('seul', path.join(dir, 'marmotte'), path.join(dir, 'data')));
  assert.equal(single.multi, false);
  await assert.rejects(() => single.create({ name: 'Y' }), /indisponible/);
  await registry.flush();
  assert.equal(slugify('  Été / Hiver !! '), 'ete-hiver');
});
