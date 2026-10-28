import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../app/server/store.js';
import { migrateV1Tokens } from '../app/shared/model.js';
import { createStudioServer } from '../app/server/http.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = migrateV1Tokens(
  JSON.parse(
    await readFile(
      path.join(root, 'workspace/design-system.tokens.json'),
      'utf8',
    ),
  ),
);
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  dev = false,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ds-http-'));
  const store = new Store(directory, seed);
  await store.init();
  const app = await createStudioServer({
    root,
    store,
    dev,
    projectDir: directory,
    config: { name: 'Test', figma: null, github: null, site: null },
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = (app.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  const post = (
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(origin + '/api/' + route, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-DS-Studio': boot.csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { origin, post, store };
}
test('API manuelle complète sans IA ni Figma, export égal au disque', async (t) => {
  const { origin, post, store } = await fixture(t);
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  assert.equal(boot.figma.connected, false);
  const proposed = await post('proposals', {
    revision: 0,
    changes: [{ key: 'bg/brand', mode: 'light', value: '#112233' }],
  });
  assert.equal(proposed.status, 200);
  const p = await proposed.json();
  assert.equal(store.snapshot().revision, 0);
  const accepted = await post('commit', { id: p.id });
  assert.equal(accepted.status, 200);
  assert.equal(
    (await (await fetch(origin + '/api/export')).json()).tokens['bg/brand']
      .$values.light,
    '#112233',
  );
  const undo = await (await post('undo', { revision: 1, id: p.id })).json();
  assert.equal((await post('commit', { id: undo.id })).status, 200);
  assert.equal(
    store.snapshot().set.tokens['bg/brand'].$values.light,
    seed.tokens['bg/brand'].$values.light,
  );
});
test('CSRF, origine étrangère, rebinding Host et périmètre refusés', async (t) => {
  const { origin, post, store } = await fixture(t);
  const body = {
    revision: 0,
    changes: [{ key: 'bg/brand', mode: 'light', value: '#112233' }],
  };
  assert.equal(
    (await post('proposals', body, { 'X-DS-Studio': '' })).status,
    403,
  );
  assert.equal(
    (await post('proposals', body, { Origin: 'https://evil.invalid' })).status,
    403,
  );
  const hostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      http
        .get(
          origin + '/api/state',
          { headers: { Host: 'evil.invalid' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on('error', reject);
    },
  );
  assert.equal(hostStatus, 403);
  assert.equal(
    (await post('proposals', { ...body, path: '../../outside' })).status,
    400,
  );
  assert.equal(
    (
      await post('proposals', {
        revision: 0,
        changes: [{ key: '../../outside', mode: 'light', value: '#112233' }],
      })
    ).status,
    400,
  );
  assert.equal((await post('figma/write', {})).status, 404);
  assert.equal((await fetch(origin + '/.ds-studio/state.json')).status, 404);
  assert.equal((await fetch(origin + '/workspace/PFE.md')).status, 404);
  assert.equal(store.snapshot().revision, 0);
});
test('requêtes malformées et trop grandes refusées', async (t) => {
  const { origin, post } = await fixture(t);
  assert.equal(
    (await post('import', { revision: 0, tokens: { wrong: true } })).status,
    400,
  );
  assert.equal((await post('proposals', {})).status, 400);
  assert.equal((await post('import', { data: 'x'.repeat(129000) })).status, 413);
  const boot = await (await fetch(origin + '/api/bootstrap')).json();
  assert.equal(
    (
      await fetch(origin + '/api/commit', {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-DS-Studio': boot.csrf,
        },
        body: '{bad',
      })
    ).status,
    400,
  );
});
test('version acceptée : révision vérifiée, fichier figé, liste exposée', async (t) => {
  const { origin, post, store } = await fixture(t);
  assert.equal((await post('accept', { revision: 3 })).status, 409);
  const accepted = await post('accept', { revision: 0 });
  assert.equal(accepted.status, 200);
  const v = await accepted.json();
  assert.equal(v.revision, 0);
  assert.match(v.hash, /^[0-9a-f]{64}$/);
  const list = await (await fetch(origin + '/api/versions')).json();
  assert.equal(list.length, 1);
  assert.equal(store.snapshot().revision, 0, 'accepter n’écrit pas de révision');
});

test('mode dev : frontend servi, workspace et backend non distribués', async (t) => {
  const { origin } = await fixture(t, true);
  for (const route of [
    '/',
    '/app/client/main.tsx',
    '/app/shared/model.ts',
    '/@vite/client',
  ])
    assert.equal((await fetch(origin + route)).status, 200);
  for (const route of [
    '/workspace/PFE.md',
    '/app/server/http.ts',
    '/connectors/figma/contract.ts',
    '/.ds-studio/state.json',
    '/.git/config',
  ])
    assert.equal((await fetch(origin + route)).status, 403);
});

test('brief : API fermée, révision conflictuelle et aucun fichier privé servi', async (t) => {
  const { origin, post, store } = await fixture(t);
  const initial = await (await fetch(origin + '/api/project')).json();
  const body = {
    ...initial,
    project: { ...initial.project, name: 'PFE test' },
  };
  assert.equal(
    (await post('project', body, { 'X-DS-Studio': '' })).status,
    403,
  );
  assert.equal((await post('project', body)).status, 200);
  assert.equal((await post('project', body)).status, 409);
  assert.equal(
    (await post('project', { ...body, path: '../../escape' })).status,
    400,
  );
  assert.equal((await fetch(origin + '/.ds-studio/project.json')).status, 404);
  assert.equal(store.snapshot().revision, 0);
});
