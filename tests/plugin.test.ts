import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../app/server/registry.js';
import { createStudioServer } from '../app/server/http.js';
import { acceptVersion } from '../app/server/versions.js';
import { loadPluginCode } from '../app/server/plugin.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('plugin Figma : appairage, version acceptée calculée, reçu de transfert, fiches en attente de diff', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json', 'components.json'])
    await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'));
  const code = await loadPluginCode(dir);
  assert.equal(await loadPluginCode(dir), code); // stable d'un démarrage à l'autre
  const app = await createStudioServer({ root, registry, pluginCode: code });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/plugin/`;
  // Requêtes telles que Figma les envoie : origine `null`, site tiers.
  const call = (route: string, body?: unknown, key = code) =>
    fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'null',
        'Sec-Fetch-Site': 'cross-site',
        'X-DS-Plugin': key,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const preflight = await fetch(base + 'projects', { method: 'OPTIONS', headers: { Origin: 'null' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.equal((await call('projects', undefined, 'aaaa-bbbb-cccc')).status, 401);
  // Le reste de l'API reste fermé à une origine externe.
  assert.equal((await fetch(base.replace('plugin/', 'state'), { headers: { Origin: 'null' } })).status, 403);

  // Figma impose `localhost` dans le manifeste : accepté pour le plugin, refusé ailleurs.
  const viaLocalhost = (route: string) =>
    new Promise<number>((resolve, reject) =>
      http
        .get(base.replace('/api/plugin/', route), { headers: { Host: `localhost:${new URL(base).port}`, 'X-DS-Plugin': code } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        })
        .on('error', reject),
    );
  assert.equal(await viaLocalhost('/api/plugin/projects'), 200);
  assert.equal(await viaLocalhost('/api/state'), 403);

  const [p] = await (await call('projects')).json();
  assert.equal(p.slug, 'marmotte');
  assert.equal(p.version, null);
  assert.match((await (await call('payload?project=marmotte')).json()).error, /Aucune version acceptée/);

  const { store, dir: projectDir, config } = await registry.get('marmotte');
  await acceptVersion(projectDir, config, store.snapshot(), 0);
  const payload = await (await call('payload?project=marmotte')).json();
  assert.equal(payload.target.fileKey, 'N5YMZ1aN6gtSZ0QBjzjdWh');
  assert.deepEqual(payload.collections.map((c: { name: string }) => c.name), ['Primitives', 'Tokens', 'Typography']);
  const brand = payload.collections[1].variables.find((v: { name: string }) => v.name === 'bg/brand');
  assert.deepEqual(brand.values.light, { alias: 'color/brand/600', collection: 'Primitives' });
  assert.equal(payload.transferred, null);

  const report = { created: 68, updated: 0, extra: [], components: ['Button'], skipped: [] };
  const wrong = await call('transfer?project=marmotte', { revision: 0, hash: payload.hash, fileKey: 'abcdefghijklmnopqrstuv', report });
  assert.equal(wrong.status, 409);
  assert.equal((await call('transfer?project=marmotte', { revision: 0, hash: payload.hash, fileKey: payload.target.fileKey, report })).status, 200);
  const receipt = JSON.parse(await readFile(path.join(projectDir, 'versions', 'v0.transfer.json'), 'utf8'));
  assert.equal(receipt.created, 68);
  assert.equal((await (await call('payload?project=marmotte')).json()).transferred.hash, payload.hash);

  const sent = await call('components?project=marmotte', {
    source: 'Figma Marmotte',
    components: [
      { name: 'Button', props: {}, variables: [] },
      { name: 'tag filtres', props: { State: ['none', 'Selected'] }, variables: ['bg/brand', 'inconnu/token'] },
    ],
  });
  assert.equal((await sent.json()).count, 1); // Button déjà dans l'atelier : conservé
  const inbox = await (await fetch(base.replace('plugin/', 'inbox'), { headers: { 'X-DS-Project': 'marmotte' } })).json();
  assert.deepEqual(inbox.file.components.TagFilter.props.State, ['none', 'selected']);
  assert.deepEqual(inbox.file.components.TagFilter.tokens, ['bg/brand']);
  assert.equal(store.snapshot().set.components?.TagFilter, undefined); // rien d'écrit sans diff
});
