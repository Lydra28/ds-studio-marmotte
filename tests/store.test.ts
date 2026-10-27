import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  readdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../app/server/store.js';
import {
  applyChanges,
  contrast,
  migrateV1Tokens,
  tokenSetSchema,
  type Change,
  type TokenSet,
} from '../app/shared/model.js';
import { checkComponentName, checkNames, runRules } from '../app/shared/rules.js';
import { acceptVersion, listVersions, readVersion, versionHash } from '../app/server/versions.js';
import { componentsSchema } from '../app/shared/components.js';

const v1Seed = JSON.parse(
  await readFile(
    new URL('../workspace/design-system.tokens.json', import.meta.url),
    'utf8',
  ),
);
const seed = migrateV1Tokens(v1Seed);
const marmotte = tokenSetSchema.parse(
  JSON.parse(
    await readFile(
      new URL('../projects/marmotte/design-system.tokens.json', import.meta.url),
      'utf8',
    ),
  ),
);
const brand = (value: string): Change => ({ key: 'bg/brand', mode: 'light', value });
const space = (value: number | string): Change => ({
  key: 'space/md',
  mode: 'default',
  value,
});
const brandOf = (set: TokenSet) => set.tokens['bg/brand'].$values.light;

async function fixture(t: { after: (fn: () => Promise<void>) => void }, s = seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir, s);
  await store.init();
  return { dir, store };
}

test('proposition sans écriture, commit, redémarrage réel du store et annulation sélective', async (t) => {
  const { dir, store } = await fixture(t);
  const before = await readFile(store.file, 'utf8');
  const p = store.propose(0, [brand('#AA2255')]);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await store.commit(p.id);
  await store.commit(store.propose(1, [space(24)]).id);
  const reopened = new Store(dir, seed);
  await reopened.init();
  assert.equal(brandOf(reopened.snapshot().set), '#AA2255');
  await reopened.commit(reopened.proposeUndo(2, p.id).id);
  assert.equal(brandOf(reopened.snapshot().set), brandOf(seed));
  assert.equal(reopened.snapshot().set.tokens['space/md'].$values.default, 24);
  assert.equal(reopened.snapshot().history.length, 3);
});

test('concurrence : une seule proposition de la même révision peut être acceptée', async (t) => {
  const { store } = await fixture(t);
  const a = store.propose(0, [brand('#112233')]);
  const b = store.propose(0, [space(8)]);
  const results = await Promise.allSettled([store.commit(a.id), store.commit(b.id)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(store.snapshot().revision, 1);
  await assert.rejects(() => store.commit(a.id), /inconnue/);
  assert.throws(() => store.propose(0, [space(4)]), /changé/);
});

test('annulation refuse de perdre un changement plus récent du même token', async (t) => {
  const { store } = await fixture(t);
  const p = store.propose(0, [brand('#112233')]);
  await store.commit(p.id);
  await store.commit(store.propose(1, [brand('#445566')]).id);
  assert.throws(() => store.proposeUndo(2, p.id), /Conflit/);
});

test('entrées, alias, imports et types invalides sont rejetés sans effet disque', async (t) => {
  const { store } = await fixture(t, marmotte);
  const raw = await readFile(store.file, 'utf8');
  for (const value of ['red', 'url(https://invalid.test)', 12, '#FFF', '{color/nope}'])
    assert.throws(() => store.propose(0, [{ key: 'bg/brand', mode: 'light', value }]));
  for (const value of [-1, 2001, '18', '{color/neutral/0}'])
    assert.throws(() => store.propose(0, [space(value)]));
  assert.throws(() => store.propose(0, [space(12), space(16)]), /deux fois/);
  assert.throws(() => store.propose(0, [{ key: 'bg/brand', mode: 'dark', value: '#000000' }]), /Mode inconnu/);
  assert.throws(() => store.propose(0, [{ key: 'nope/x', mode: 'light', value: '#000000' }]), /inconnu/);
  assert.throws(() =>
    store.propose(0, [{ key: 'font/family/sans', mode: 'default', value: 'url(evil);' }]),
  );
  // Alias circulaire refusé.
  const cyclic = structuredClone(marmotte);
  cyclic.tokens['bg/canvas'].$values.light = '{bg/surface}';
  cyclic.tokens['bg/surface'].$values.light = '{bg/canvas}';
  assert.throws(() => store.proposeImport(0, cyclic));
  assert.throws(() => store.proposeImport(0, {}));
  assert.throws(() => store.proposeImport(0, { ...marmotte, secret: 'no' }));
  assert.equal(await readFile(store.file, 'utf8'), raw);
});

test('import local (v2 ou ancien format v1) passe par le même diff et la validation', async (t) => {
  const { store } = await fixture(t);
  const next = applyChanges(seed, [brand('#774422'), space(20)]);
  const p = store.proposeImport(0, next);
  assert.equal(p.source, 'import');
  assert.equal(p.patches.length, 2);
  assert.equal(store.snapshot().revision, 0);
  await store.commit(p.id);
  assert.deepEqual(store.snapshot().set, next);
  const legacy = structuredClone(v1Seed);
  legacy['color.brand'].$value = '#123456';
  const q = store.proposeImport(1, legacy);
  await store.commit(q.id);
  assert.equal(brandOf(store.snapshot().set), '#123456');
  assert.throws(
    () => store.proposeImport(2, { ...marmotte, modes: { ...marmotte.modes, tokens: ['dark'] } }),
  );
});

test('état v1 migré sans perte : original archivé, historique converti et annulable', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const changed = structuredClone(v1Seed);
  changed['color.brand'].$value = '#8A3B20';
  const v1 = {
    version: 1,
    revision: 1,
    tokens: changed,
    history: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        date: '2026-10-27T10:00:00.000Z',
        source: 'manual',
        patches: [{ key: 'color.brand', before: v1Seed['color.brand'].$value, after: '#8A3B20' }],
      },
    ],
  };
  const raw = JSON.stringify(v1, null, 2);
  await writeFile(path.join(dir, 'state.json'), raw);
  const store = new Store(dir, seed);
  await store.init();
  assert.equal(store.snapshot().version, 2);
  assert.equal(brandOf(store.snapshot().set), '#8A3B20');
  const archived = (await readdir(dir)).find((f) => f.startsWith('state-v1-preserved-'));
  assert.ok(archived, 'original v1 archivé');
  assert.equal(await readFile(path.join(dir, archived!), 'utf8'), raw);
  await store.commit(store.proposeUndo(1, v1.history[0].id).id);
  assert.equal(brandOf(store.snapshot().set), v1Seed['color.brand'].$value);
});

test('fichier corrompu et historique falsifié préservés sans reset silencieux', async (t) => {
  const { dir, store } = await fixture(t);
  for (const raw of ['{bad', JSON.stringify({ ...store.snapshot(), revision: 42 })]) {
    await writeFile(store.file, raw);
    await assert.rejects(() => new Store(dir, seed).init(), /original préservé/);
    assert.equal(await readFile(store.file, 'utf8'), raw);
  }
});

test('modification extérieure détectée avant écrasement', async (t) => {
  const { store } = await fixture(t);
  const p = store.propose(0, [space(8)]);
  await writeFile(store.file, 'changed externally');
  await assert.rejects(() => store.commit(p.id), /hors application/);
  assert.equal(await readFile(store.file, 'utf8'), 'changed externally');
});

test(
  'symlink vers un dossier externe refusé',
  { skip: process.platform === 'win32' ? 'Droits symlink Windows à qualifier' : false },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ds-links-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, 'target'));
    await symlink(path.join(dir, 'target'), path.join(dir, 'link'));
    await assert.rejects(() => new Store(path.join(dir, 'link'), seed).init(), /symbolique refusé/);
  },
);

test('contraste noir/blanc et identité', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.equal(contrast('#123456', '#123456'), 1);
});

test('copie précédente complète, restauration explicite et original corrompu archivé', async (t) => {
  const { store, dir } = await fixture(t);
  const { restorePrevious } = await import('../app/server/store.js');
  const original = await readFile(store.file, 'utf8');
  await store.commit(store.propose(0, [brand('#445566')]).id);
  assert.equal(await readFile(path.join(dir, 'state.previous.json'), 'utf8'), original);
  await writeFile(store.file, '{interruption');
  const restored = await restorePrevious(dir);
  assert.equal(restored.revision, 0);
  assert.equal(await readFile(path.join(dir, restored.preserved), 'utf8'), '{interruption');
  assert.equal(await readFile(store.file, 'utf8'), original);
  const reopened = new Store(dir, applyChanges(seed, [brand('#000000')]));
  await reopened.init();
  assert.equal(
    brandOf(reopened.snapshot().set),
    brandOf(seed),
    'Une mise à jour du seed ne réinitialise jamais un état existant',
  );
});

test('copie précédente falsifiée : restauration refusée sans toucher l’original', async (t) => {
  const { store, dir } = await fixture(t);
  const { restorePrevious } = await import('../app/server/store.js');
  const original = await readFile(store.file, 'utf8');
  await writeFile(path.join(dir, 'state.previous.json'), '{invalid');
  await assert.rejects(() => restorePrevious(dir));
  assert.equal(await readFile(store.file, 'utf8'), original);
});

test('échec de sauvegarde : commit non appliqué et brouillon encore validable', async (t) => {
  const { store, dir } = await fixture(t);
  const original = await readFile(store.file, 'utf8');
  const backup = path.join(dir, 'state.previous.json');
  await mkdir(backup);
  const p = store.propose(0, [space(24)]);
  await assert.rejects(() => store.commit(p.id));
  assert.equal(store.snapshot().revision, 0);
  assert.equal(await readFile(store.file, 'utf8'), original);
  await rm(backup, { recursive: true });
  await store.commit(p.id);
  assert.equal(store.snapshot().revision, 1);
});

test(
  'lien ajouté après ouverture : commit refusé sans lire ni modifier sa cible',
  { skip: process.platform === 'win32' ? 'Droits symlink non accordés sur Windows' : false },
  async (t) => {
    const { store, dir } = await fixture(t);
    const target = path.join(dir, 'outside.json');
    const original = await readFile(store.file, 'utf8');
    await writeFile(target, original);
    await rm(store.file);
    await symlink(target, store.file);
    const p = store.propose(0, [space(24)]);
    await assert.rejects(() => store.commit(p.id));
    assert.equal(await readFile(target, 'utf8'), original);
  },
);

test('règles : seed Marmotte sans écart, chaque règle signale et propose sans appliquer', () => {
  assert.deepEqual(runRules(marmotte), []);
  const bad = applyChanges(marmotte, [
    { key: 'space/sm', mode: 'default', value: 15 },
    { key: 'space/3xs', mode: 'default', value: 2 },
    { key: 'color/neutral/600', mode: 'default', value: '#B4BAC4' },
    { key: 'font/size/body', mode: 'mobile', value: 14 },
    { key: 'font/size/caption', mode: 'desktop', value: 10 },
  ]);
  const findings = runRules(bad);
  const by = (rule: string) => findings.filter((f) => f.rule === rule);
  assert.deepEqual(by('espacement-multiple-4').map((f) => [f.key, f.fix?.value]), [['space/sm', 16]]);
  const c = by('contraste').find((f) => f.key === 'text/muted');
  assert.ok(c?.fix, 'contraste insuffisant signalé avec correction');
  const fixed = applyChanges(bad, [c!.fix!]);
  assert.equal(runRules(fixed).filter((f) => f.rule === 'contraste').length, 0);
  assert.deepEqual(
    by('taille-texte').map((f) => [f.key, f.mode, f.fix?.value]),
    [
      ['font/size/body', 'mobile', 16],
      ['font/size/caption', 'desktop', 12],
    ],
  );
  assert.equal(bad.tokens['space/sm'].$values.default, 15, 'rien n’est appliqué');
});

test('nomenclature : écarts du fichier Devonia signalés, noms conformes acceptés', () => {
  assert.deepEqual(checkComponentName('Button').issues, []);
  assert.deepEqual(checkComponentName('Card/Project · Variant=large, State=hover').issues, []);
  assert.equal(checkComponentName('card projet').suggestion, 'CardProject');
  assert.match(checkComponentName('Property 1=Aucun résultat').issues.join(), /par défaut de Figma/);
  assert.match(checkComponentName('devonia-logo-mono 1').issues.join(), /Suffixe/);
  assert.match(checkComponentName('button · State=Hover').issues.join(), /minuscules/);
  const list = checkNames(['card projet', 'Card projets']);
  assert.match(list[1].issues.join(), /Doublon/);
});

test('version acceptée : empreinte, cible et révision figées, jamais écrasée', async (t) => {
  const { store } = await fixture(t, marmotte);
  const projectDir = await mkdtemp(path.join(tmpdir(), 'ds-project-'));
  t.after(() => rm(projectDir, { recursive: true, force: true }));
  const config = {
    name: 'Test',
    figma: { fileKey: 'N5YMZ1aN6gtSZ0QBjzjdWh', page: 'DS-Studio · Foundations', protectedPages: [] },
  };
  await assert.rejects(() => acceptVersion(projectDir, config, store.snapshot(), 3), /changé/);
  const v = await acceptVersion(projectDir, config, store.snapshot(), 0);
  assert.equal(v.hash, versionHash(marmotte));
  const saved = JSON.parse(await readFile(path.join(projectDir, 'versions', 'v0.json'), 'utf8'));
  assert.equal(saved.target.fileKey, config.figma.fileKey);
  assert.equal(saved.revision, 0);
  assert.equal((await acceptVersion(projectDir, config, store.snapshot(), 0)).hash, v.hash);
  await writeFile(
    path.join(projectDir, 'versions', 'v0.json'),
    JSON.stringify({ ...saved, hash: 'autre' }),
  );
  await assert.rejects(() => acceptVersion(projectDir, config, store.snapshot(), 0), /différente/);
  assert.equal((await listVersions(projectDir)).length, 1);
  // Relue pour comparaison : le jeu figé revient tel quel, une version absente est refusée.
  assert.deepEqual((await readVersion(projectDir, 0)).set, marmotte);
  await assert.rejects(() => readVersion(projectDir, 9), /introuvable/);
});

test('ajout et retrait de tokens : diff puis commit, retrait refusé tant qu’un alias y renvoie', async (t) => {
  const { store } = await fixture(t, marmotte);
  const accent: Change = {
    op: 'add',
    key: 'color/accent/500',
    token: { $type: 'color', $collection: 'primitives', $values: { default: '#FF5500' } },
  };
  const p = store.propose(0, [
    accent,
    { key: 'bg/brand', mode: 'light', value: '{color/accent/500}' },
  ]);
  assert.deepEqual(
    p.patches.map((x) => [x.key, !!x.before, !!x.after]).sort(),
    [['bg/brand', true, true], ['color/accent/500', false, true]],
  );
  await store.commit(p.id);
  assert.equal(store.snapshot().set.tokens['color/accent/500'].$values.default, '#FF5500');
  assert.throws(() => store.propose(1, [accent]), /déjà existant/);
  assert.throws(
    () => store.propose(1, [{ op: 'remove', key: 'color/accent/500' }]),
    /utilisé par bg\/brand/,
  );
  const unused = Object.keys(store.snapshot().set.tokens).find(
    (k) => !Object.values(store.snapshot().set.tokens).some((tk) => Object.values(tk.$values).includes(`{${k}}`)),
  )!;
  const r = store.propose(1, [{ op: 'remove', key: unused }]);
  assert.deepEqual(r.patches.map((x) => [x.key, !!x.after]), [[unused, false]]);
  await store.commit(r.id);
  assert.equal(store.snapshot().set.tokens[unused], undefined);
});

test('fiches de composants : migration annulable, édition et import par diff, figées dans la version', async (t) => {
  const components = componentsSchema.parse(
    JSON.parse(await readFile(new URL('../projects/marmotte/components.json', import.meta.url), 'utf8')),
  );
  // Instance existante sans fiches : elles arrivent par une révision « migration ».
  const { dir } = await fixture(t, marmotte);
  const reopened = new Store(dir, { ...marmotte, components });
  await reopened.init();
  const s1 = reopened.snapshot();
  assert.equal(s1.revision, 1);
  assert.equal(s1.history[0].source, 'migration');
  assert.deepEqual(Object.keys(s1.set.components!).sort(), ['Button', 'Card', 'Input']);
  // Édition : création, modification, retrait, chacun visible dans le diff.
  const tag = { ...components.Card, status: 'fiche' as const, role: 'Étiquette courte.' };
  const p = reopened.propose(1, [
    { op: 'component', name: 'Tag', component: tag },
    { op: 'component', name: 'Card', component: null },
  ]);
  assert.deepEqual(
    p.patches.map((x) => [x.kind, x.key, !!x.before, !!x.after]),
    [['component', 'Card', true, false], ['component', 'Tag', false, true]],
  );
  await reopened.commit(p.id);
  assert.throws(() => reopened.propose(2, [{ op: 'component', name: 'Card', component: null }]), /Composant inconnu/);
  // Annulation de toute la révision : Card revient, Tag repart.
  await reopened.commit(reopened.proposeUndo(2, p.id).id);
  assert.ok(reopened.snapshot().set.components!.Card);
  // Import d'un fichier de fiches préparé par l'agent : ajoute, ne retire rien.
  const imp = reopened.proposeImport(3, {
    format: 'ds-studio-components/1',
    source: 'Figma test',
    components: { 'Card/Project': tag },
  });
  assert.deepEqual(imp.patches.map((x) => x.key), ['Card/Project']);
  // Un jeu de tokens importé sans fiches les conserve.
  assert.throws(() => reopened.proposeImport(3, marmotte), /Aucune modification/);
  // Nom non conforme refusé par le schéma.
  assert.throws(() => reopened.propose(3, [{ op: 'component', name: 'card projet', component: tag }]));
  // Redémarrage : historique mixte tokens + fiches relu sans incohérence.
  const again = new Store(dir, { ...marmotte, components });
  await again.init();
  assert.equal(again.snapshot().revision, 3);
  // Version : les fiches sont dans le jeu figé, donc dans l'empreinte.
  const v = await acceptVersion(dir, { name: 'Test', figma: null }, again.snapshot(), 3);
  const saved = JSON.parse(await readFile(path.join(dir, 'versions', 'v3.json'), 'utf8'));
  assert.equal(v.hash, versionHash(saved.set));
  assert.deepEqual(saved.components.map((c: { name: string }) => c.name).sort(), ['Button', 'Card', 'Input']);
});
