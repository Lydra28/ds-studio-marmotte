import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../app/server/registry.js';
import { createStudioServer } from '../app/server/http.js';
import { acceptVersion } from '../app/server/versions.js';
import { loadPluginCode, PLUGIN_CONTRACT } from '../app/server/plugin.js';

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
        'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': key,
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
        .get(base.replace('/api/plugin/', route), { headers: { Host: `localhost:${new URL(base).port}`, 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': code } }, (r) => {
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

  // Remise à zéro notée : le transfert précédent ne compte plus.
  assert.equal((await (await call('projects')).json())[0].known, true);
  const removed = { collections: ['Primitives', 'Tokens', 'Typography'], variables: 68, page: 'DS-Studio · Foundations', components: ['Button'] };
  assert.equal((await call('reset?project=marmotte', { fileKey: 'abcdefghijklmnopqrstuv', removed })).status, 409);
  assert.equal((await call('reset?project=marmotte', { fileKey: payload.target.fileKey, removed })).status, 200);
  assert.equal((await (await call('payload?project=marmotte')).json()).transferred, null);
  assert.equal((await (await call('projects')).json())[0].known, false);
  assert.equal(JSON.parse(await readFile(path.join(projectDir, 'versions', 'figma-reset.json'), 'utf8')).length, 1);
});

test('plugin Figma : le fichier ouvert devient la cible d’un projet qui n’en a pas', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-target-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json']) await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  await cp(path.join(root, 'projects/marmotte/design-system.tokens.json'), path.join(dir, 'refuge', 'design-system.tokens.json'));
  await writeFile(path.join(dir, 'refuge', 'project.config.json'), JSON.stringify({ name: 'Refuge', figma: null, github: null }));
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'));
  const code = await loadPluginCode(dir);
  const app = await createStudioServer({ root, registry, pluginCode: code });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/plugin/`;
  const target = (project: string, fileKey: string) =>
    fetch(`${base}target?project=${project}`, { method: 'POST', headers: { 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': code, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileKey }) });

  // Version acceptée avant toute cible : elle prendra celle désignée ensuite.
  const refuge = await registry.get('refuge');
  await acceptVersion(refuge.dir, refuge.config, refuge.store.snapshot(), 0);
  const payloadOf = () => fetch(`${base}payload?project=refuge`, { headers: { 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': code } });
  assert.equal((await payloadOf()).status, 409);

  const taken = await target('refuge', 'N5YMZ1aN6gtSZ0QBjzjdWh'); // fichier de Marmotte
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /déjà la cible de Marmotte/);
  assert.equal((await target('marmotte', 'abcdefghijklmnopqrstuv')).status, 409); // cible existante jamais remplacée
  assert.equal((await target('refuge', 'abcdefghijklmnopqrstuv')).status, 200);
  const saved = JSON.parse(await readFile(path.join(dir, 'refuge', 'project.config.json'), 'utf8'));
  assert.deepEqual(saved.figma, { fileKey: 'abcdefghijklmnopqrstuv', page: 'DS-Studio · Foundations', protectedPages: [] });
  assert.equal((await registry.get('refuge')).config.figma?.fileKey, 'abcdefghijklmnopqrstuv');
  assert.equal((await (await payloadOf()).json()).target.fileKey, 'abcdefghijklmnopqrstuv');
  assert.equal((await target('refuge', 'zyxwvutsrqponmlkjihgfe')).status, 409);
});

test('plugin Figma : question à l’assistant, appairage exigé, texte seulement', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-plugin-ask-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json']) await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  const seen: string[] = [];
  // Réponse simulée d'OpenRouter : jamais d'appel réseau dans les tests.
  const fetch_ = (async (_url: string, init: RequestInit) => {
    seen.push(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Gap à 16 px.' } }] }));
  }) as typeof fetch;
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'), 'marmotte', { apiKey: 'k', fetch: fetch_ });
  const code = await loadPluginCode(dir);
  const app = await createStudioServer({ root, registry, pluginCode: code });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/plugin/`;
  const ask = (body: unknown, key = code) =>
    fetch(`${base}ask?project=marmotte`, { method: 'POST', headers: { 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await (await fetch(base + 'projects', { headers: { 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': code } })).json())[0].assistant, true);
  assert.equal((await ask({ message: 'Bonjour' }, 'aaaa-bbbb-cccc')).status, 401);
  assert.equal((await ask({ message: '' })).status, 400);
  const selection = { file: 'Maquettes', nodes: [{ name: 'Carte', type: 'FRAME', depth: 0, gap: { v: 14, var: null } }] };
  const res = await ask({ message: 'Ma carte est-elle bonne ?', selection });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reply, 'Gap à 16 px.');
  assert.deepEqual(body.findings, ['Carte : gap de 14 px, hors grille de 4 (16 px).']);
  assert.match(seen[0], /Marmotte/);
  assert.equal(seen.length, 1); // requête refusée : aucun appel au modèle
});

test('plugin Figma : contrat versionné, manifeste Community', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-plugin-contract-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const f of ['design-system.tokens.json', 'project.config.json', 'components.json'])
    await cp(path.join(root, 'projects/marmotte', f), path.join(dir, 'marmotte', f));
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'));
  const code = await loadPluginCode(dir);
  const app = await createStudioServer({ root, registry, pluginCode: code });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/plugin/`;
  const projects = (contract?: string) =>
    fetch(base + 'projects', { headers: { Origin: 'null', 'X-DS-Plugin': code, ...(contract === undefined ? {} : { 'X-DS-Plugin-Contract': contract }) } });
  // Plugin d'avant le contrat (aucun en-tête) : refusé, et il sait quoi faire.
  const old = await projects();
  assert.equal(old.status, 426);
  assert.match((await old.json()).error, /Plugin DS-Studio trop ancien .*Community/);
  // Plugin plus récent que l'atelier : c'est l'atelier qu'il faut mettre à jour.
  const newer = await projects(String(PLUGIN_CONTRACT + 1));
  assert.equal(newer.status, 426);
  assert.match((await newer.json()).error, /Atelier DS-Studio trop ancien .*Réglages/);
  assert.equal((await projects(String(PLUGIN_CONTRACT))).status, 200);
  // Un mauvais code reste un 401 : le contrat n'est dit qu'aux plugins appairés.
  const stranger = await fetch(base + 'projects', { headers: { Origin: 'null', 'X-DS-Plugin': 'aaaa-bbbb-cccc' } });
  assert.equal(stranger.status, 401);
  // Le plugin porte le même numéro que le serveur (constante CONTRACT de ui.html).
  const ui = await readFile(path.join(root, 'figma-plugin/ui.html'), 'utf8');
  assert.ok(ui.includes(`const CONTRACT = ${PLUGIN_CONTRACT};`), 'CONTRACT de ui.html différent de PLUGIN_CONTRACT');
  assert.ok(ui.includes(`'X-DS-Plugin-Contract': CONTRACT`), 'ui.html doit envoyer le contrat');
  // Atelier d'avant le contrat (rc.4) : sa pré-requête CORS refuse l'en-tête et le navigateur ne lance rien
  // (« Failed to fetch »), aucun 426 possible ; le plugin sonde l'adresse en no-cors pour dire « mets à jour
  // DS-Studio » plutôt qu'« injoignable ». Vu le 2026-10-30 au premier essai réel dans Figma.
  assert.ok(ui.includes(`{ mode: 'no-cors' }`), 'ui.html doit sonder l’adresse en no-cors quand la requête ne part pas');
  assert.ok(ui.includes('antérieure au contrat v${CONTRACT}'), 'ui.html doit expliquer l’atelier trop ancien pour le contrat');
  assert.ok(ui.includes('err instanceof TypeError ? await explainFetchFailure()'), 'seule une requête non partie déclenche la sonde');
  // Manifeste prêt pour la Community : origines locales déclarées avec leur raison, pas d'API privée ni de domaine de développement.
  const manifest = JSON.parse(await readFile(path.join(root, 'figma-plugin/manifest.json'), 'utf8'));
  assert.equal(manifest.enablePrivatePluginApi, undefined);
  assert.equal(manifest.networkAccess.devAllowedDomains, undefined);
  assert.deepEqual(manifest.networkAccess.allowedDomains, ['http://localhost:4310', 'http://localhost:4311', 'http://localhost:4312']);
  assert.ok(manifest.networkAccess.reasoning.length > 40);
  assert.equal(manifest.documentAccess, 'dynamic-page');
  assert.equal(manifest.api, '1.0.0');
});
