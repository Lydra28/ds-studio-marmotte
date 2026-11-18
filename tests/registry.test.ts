import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, SITE_HTTP, coverOf, openInstance, siteNotice, siteOrigin, slugify, withSite } from '../app/server/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'templates/blank/design-system.tokens.json');

test('projets : liste, création vierge au nom unique, lien Figma vérifié, instance fixe sans création', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-projects-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json', 'components.json'])
    await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  const registry = Registry.folder(dir, template);
  assert.deepEqual((await registry.list()).map((p) => p.slug), ['marmotte']);
  // Couverture de l'accueil : alias résolus en couleurs, nuancier borné à 8.
  const [{ cover }] = await registry.list();
  assert.match(cover.brand ?? '', /^#[0-9a-f]{6}$/i);
  assert.match(cover.canvas ?? '', /^#[0-9a-f]{6}$/i);
  assert.ok(cover.palette.length > 0 && cover.palette.length <= 8);
  const empty = coverOf({ modes: { primitives: ['default'], tokens: ['light'], typography: ['desktop'] }, tokens: {} } as never);
  assert.deepEqual([empty.brand, empty.palette], [null, []]);

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

test('site en direct : adresse posée ou changée sur un projet existant, http écarté avec un message', async (t) => {
  // Même règle qu'à la création : https, origine seule ; http et adresses privées refusés.
  assert.equal(siteOrigin(' https://devonia.fr/projets?x=1 '), 'https://devonia.fr/');
  assert.throws(() => siteOrigin('http://devonia.fr/'), (e: Error) => e.message === SITE_HTTP);
  assert.throws(() => siteOrigin('devonia'), /Adresse du site attendue/);
  assert.throws(() => siteOrigin('https://localhost:3000/'), /Lien refusé/);
  // Création : l'adresse http reste lue pour les styles, mais le message le dit.
  assert.equal(siteNotice('http://devonia.fr/'), SITE_HTTP);
  assert.equal(siteNotice('https://devonia.fr/'), null);
  assert.equal(siteNotice(''), null);

  const dir = await mkdtemp(path.join(tmpdir(), 'ds-site-url-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = Registry.folder(dir, template);
  const slug = await registry.create({ name: 'Devonia', siteUrl: 'http://devonia.fr/' });
  assert.equal((await registry.get(slug)).config.site, null);
  // Projet existant sans site (cas Devonia) : l'adresse est posée, écrite sur disque.
  await registry.updateConfig(slug, (c) => withSite(c, siteOrigin('https://devonia.fr/accueil')));
  const disk = JSON.parse(await readFile(path.join(dir, slug, 'project.config.json'), 'utf8'));
  assert.deepEqual(disk.site, { url: 'https://devonia.fr/', pages: ['/'] });
  assert.deepEqual((await registry.get(slug)).config.site, disk.site);
  // Même site : pages gardées ; autre site : pages remises à « / ».
  const withPages = withSite({ ...disk, site: { url: 'https://devonia.fr/', pages: ['/', '/a'] } }, 'https://devonia.fr/');
  assert.deepEqual(withPages.site?.pages, ['/', '/a']);
  assert.deepEqual(withSite(withPages, 'https://autre.fr/').site, { url: 'https://autre.fr/', pages: ['/'] });
});
