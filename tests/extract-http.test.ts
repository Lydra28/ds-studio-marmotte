import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../app/server/registry.js';
import { createStudioServer } from '../app/server/http.js';
import { applyChanges, resolve } from '../app/shared/model.js';

// Lot 5, étape 5.3 : « Nouveau projet depuis un site » côté serveur, lecture
// injectée (aucun Chromium, aucun réseau).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'templates/blank/design-system.tokens.json');
const inventory = JSON.parse(await readFile(path.join(root, 'tests/fixtures/site/inventory.json'), 'utf8'));

test('création depuis un site : origine https en Site en direct, http sans site, adresse privée refusée', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-extract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = Registry.folder(dir, template);
  const config = async (slug: string) => JSON.parse(await readFile(path.join(dir, slug, 'project.config.json'), 'utf8'));

  const a = await registry.create({ name: 'Depuis un site', siteUrl: 'https://atelier-fixture.example/tarifs?x=1' });
  assert.deepEqual((await config(a)).site, { url: 'https://atelier-fixture.example/', pages: ['/'] });
  const b = await registry.create({ name: 'Site en http', siteUrl: 'http://atelier-fixture.example/' });
  assert.equal((await config(b)).site, null);
  const c = await registry.create({ name: 'Sans site' });
  assert.equal((await config(c)).site, null);
  for (const siteUrl of ['http://localhost:5173', 'https://192.168.0.2/', 'pas une adresse'])
    await assert.rejects(
      () => registry.create({ name: 'Refusé', siteUrl }),
      (e: Error & { status?: number }) => e.status === 400 && /Lien refusé|Adresse du site/.test(e.message),
    );
  assert.deepEqual((await registry.list()).map((p) => p.slug).sort(), [a, b, c].sort());
});

test('POST /api/extract : inventaire et proposition sur le jeu enregistré, rien d’écrit ; erreurs expliquées', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-extract-'));
  const registry = Registry.folder(dir, template);
  const slug = await registry.create({ name: 'Extraction', siteUrl: 'https://atelier-fixture.example/' });
  let mode: 'ok' | 'down' | 'empty' = 'ok';
  const read = async (url: string) => {
    assert.equal(url, 'https://atelier-fixture.example/');
    if (mode === 'down') throw new Error('Site trop lent.');
    if (mode === 'empty') return { ...inventory, desktop: { ...inventory.desktop, elements: 0, texts: [] } };
    return inventory;
  };
  const app = await createStudioServer({ root, registry, extract: read });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  const post = (url: string) =>
    fetch(origin + '/api/extract', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-DS-Studio': boot.csrf, 'X-DS-Project': slug },
      body: JSON.stringify({ url }),
    });

  const before = (await registry.get(slug)).store.snapshot();
  const ok = await post('https://atelier-fixture.example/');
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.inventory.desktop.title, 'Atelier Fixture');
  assert.equal(body.report.brand, '#2563EB');
  assert.deepEqual(body.rejected, []);
  const next = applyChanges(before.set, body.changes);
  assert.equal(resolve(next, 'bg/brand', { tokens: 'light' }), '#2563EB');
  // Rien n'est écrit : même révision, même jeu.
  const after = (await registry.get(slug)).store.snapshot();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.set, before.set);

  assert.equal((await post('http://localhost:3000/')).status, 400);
  mode = 'down';
  const down = await post('https://atelier-fixture.example/');
  assert.equal(down.status, 502);
  assert.match((await down.json()).error, /Site trop lent/);
  mode = 'empty';
  const empty = await post('https://atelier-fixture.example/');
  assert.equal(empty.status, 422);
  assert.match((await empty.json()).error, /Aucun style lisible/);
});
