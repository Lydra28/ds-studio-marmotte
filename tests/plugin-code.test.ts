import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Code du plugin (figma-plugin/code.js) exécuté contre un faux Figma réduit à
// ce qu'utilisent le transfert et la remise à zéro (sans composant).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'abcdefghijklmnopqrstuv';
const PAGE = 'DS-Studio · Foundations';

function fakeFigma() {
  let n = 0;
  const data = () => {
    const d = new Map<string, string>();
    return { getPluginData: (k: string) => d.get(k) ?? '', setPluginData: (k: string, v: string) => void d.set(k, v) };
  };
  const collections: any[] = [];
  const variables: any[] = [];
  const pages: any[] = [];
  const page = (name: string) => {
    const p = {
      type: 'PAGE',
      name,
      children: [] as unknown[],
      loadAsync: async () => {},
      findAllWithCriteria: () => [],
      remove: () => void pages.splice(pages.indexOf(p), 1),
      ...data(),
    };
    pages.push(p);
    return p;
  };
  const collection = (name: string) => {
    const c = {
      id: `c${++n}`,
      name,
      modes: [{ modeId: `m${++n}`, name: 'Mode 1' }],
      variableIds: [] as string[],
      hiddenFromPublishing: false,
      renameMode(id: string, to: string) {
        c.modes.find((m) => m.modeId === id)!.name = to;
      },
      addMode(to: string) {
        const modeId = `m${++n}`;
        c.modes.push({ modeId, name: to });
        return modeId;
      },
      remove() {
        collections.splice(collections.indexOf(c), 1);
        for (const id of c.variableIds) variables.splice(variables.findIndex((v) => v.id === id), 1);
      },
      ...data(),
    };
    collections.push(c);
    return c;
  };
  const posted: any[] = [];
  const figma: any = {
    fileKey: KEY,
    root: { name: 'Fichier test', children: pages, ...data() },
    currentPage: null,
    showUI: () => {},
    ui: { postMessage: (m: unknown) => posted.push(m), onmessage: null },
    setCurrentPageAsync: async (p: unknown) => void (figma.currentPage = p),
    createPage: () => page('Page'),
    variables: {
      getLocalVariableCollectionsAsync: async () => [...collections],
      getLocalVariablesAsync: async () => [...variables],
      createVariableCollection: collection,
      createVariable: (name: string, col: any, type: string) => {
        const v = { id: `v${++n}`, name, variableCollectionId: col.id, resolvedType: type, values: {} as Record<string, unknown>, setValueForMode: (m: string, x: unknown) => void (v.values[m] = x) };
        col.variableIds.push(v.id);
        variables.push(v);
        return v;
      },
      createVariableAlias: (v: any) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
    },
  };
  figma.currentPage = page('Mes écrans');
  return { figma, collections, pages, posted, collection, page };
}

async function load() {
  const fake = fakeFigma();
  vm.runInNewContext(await readFile(path.join(root, 'figma-plugin/code.js'), 'utf8'), { figma: fake.figma, __html__: '' });
  const send = async (msg: unknown) => {
    await fake.figma.ui.onmessage(msg);
    return JSON.parse(JSON.stringify(fake.posted.at(-1))); // copie comme postMessage, hors du contexte vm
  };
  return { ...fake, send };
}

const target = { fileKey: KEY, page: PAGE, protectedPages: [] };
const color = (r: number) => ({ r, g: 0, b: 0 });
const payload = {
  project: 'Test',
  target,
  font: null,
  components: [],
  collections: [
    { name: 'Primitives', modes: ['default'], variables: [{ name: 'color/a', type: 'COLOR', scopes: [], hidden: true, description: '', values: { default: color(1) } }] },
    { name: 'Tokens', modes: ['light'], variables: [{ name: 'bg/a', type: 'COLOR', scopes: [], hidden: false, description: '', values: { light: { alias: 'color/a', collection: 'Primitives' } } }] },
    { name: 'Typography', modes: ['desktop', 'mobile'], variables: [] },
  ],
};

test('plugin : transfert refusé sur une collection du même nom que DS-Studio n’a pas créée', async () => {
  const f = await load();
  f.collection('Primitives'); // DS du fichier, écrit à la main
  const names = payload.collections.map((c) => c.name);
  // Annoncé avant le clic : l'interface désactive « Transférer ».
  const check = await f.send({ type: 'check', collections: names, page: PAGE, known: false });
  assert.match(check.foreign, /sa propre collection « Primitives »/);
  assert.equal((await f.send({ type: 'check', collections: names, page: PAGE, known: true })).foreign, null);
  const res = await f.send({ type: 'transfer', payload, known: false });
  assert.equal(res.type, 'error');
  assert.match(res.message, /collection « Primitives »/);
  assert.deepEqual(f.collections.map((c) => c.name), ['Primitives']); // rien d'écrit
  assert.deepEqual(f.pages.map((p) => p.name), ['Mes écrans']);
});

test('plugin : remise à zéro limitée à ce que DS-Studio a écrit', async () => {
  const f = await load();
  f.collection('Color'); // collections et pages de Romain : jamais touchées
  assert.equal((await f.send({ type: 'transfer', payload, known: false })).type, 'transferred');
  assert.deepEqual(f.collections.map((c) => c.name), ['Color', 'Primitives', 'Tokens', 'Typography']);
  await f.figma.setCurrentPageAsync(f.pages.find((p) => p.name === PAGE));

  // Mauvais fichier : refus avant tout inventaire.
  assert.equal((await f.send({ type: 'reset-plan', target: { ...target, fileKey: 'zyxwvutsrqponmlkjihgfe' }, known: false })).type, 'error');
  const { plan } = await f.send({ type: 'reset-plan', target, known: false });
  assert.deepEqual(plan.collections, [
    { name: 'Primitives', variables: 1 },
    { name: 'Tokens', variables: 1 },
    { name: 'Typography', variables: 0 },
  ]);
  assert.equal(plan.page.name, PAGE);
  assert.equal(f.collections.length, 4); // l'inventaire ne supprime rien

  const { removed } = await f.send({ type: 'reset', target, known: false });
  assert.deepEqual(removed, { collections: ['Primitives', 'Tokens', 'Typography'], variables: 2, page: PAGE, components: [] });
  assert.deepEqual(f.collections.map((c) => c.name), ['Color']);
  assert.deepEqual(f.pages.map((p) => p.name), ['Mes écrans']);
  assert.equal(f.figma.currentPage.name, 'Mes écrans'); // quittée avant suppression
});

test('plugin : collections écrites avant la marque reconnues seulement avec un reçu de transfert', async () => {
  const f = await load();
  f.collection('Primitives');
  f.page(PAGE);
  const without = (await f.send({ type: 'reset-plan', target, known: false })).plan;
  assert.deepEqual([without.collections, without.page], [[], null]);
  const withReceipt = (await f.send({ type: 'reset-plan', target, known: true })).plan;
  assert.deepEqual(withReceipt.collections, [{ name: 'Primitives', variables: 0 }]);
  assert.equal(withReceipt.page.name, PAGE);
  // Avec le reçu, le transfert reprend la collection existante et la marque.
  assert.equal((await f.send({ type: 'transfer', payload, known: true })).type, 'transferred');
  assert.equal(f.collections.filter((c) => c.name === 'Primitives').length, 1);
  assert.equal(f.collections[0].getPluginData('dsStudio'), '1');
});
