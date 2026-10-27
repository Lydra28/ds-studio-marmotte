import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('conversion Figma → fiches : noms corrigés, propriétés ramenées, existants et doublons écartés', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-figma-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const raw = path.join(dir, 'brut.json');
  await writeFile(
    raw,
    JSON.stringify({
      source: 'test',
      components: [
        { name: 'card projet', props: { 'Property 1': ['Aucun résultat', 'Résultat'] }, variables: ['bg/surface', 'Depth/800'] },
        { name: 'Card projets', props: {} },
        { name: "mur d'outils", description: 'Grille des outils.', props: { taille: ['Grand'] } },
        { name: 'tag thèmes', props: { 'Has icon': ['true'] } },
        { name: 'button', props: { State: ['Full'] } },
      ],
    }),
  );
  const { stdout, stderr } = await run(
    process.execPath,
    ['--import', 'tsx', 'scripts/components-from-figma.ts', raw, '--project=projects/marmotte'],
    { cwd: path.resolve(import.meta.dirname, '..') },
  );
  const out = JSON.parse(stdout);
  assert.equal(out.format, 'ds-studio-components/1');
  assert.deepEqual(Object.keys(out.components), ['CardProject', 'WallTool', 'TagThemes']);
  assert.deepEqual(out.components.CardProject.props, { Variant: ['aucun-resultat', 'resultat'] });
  assert.deepEqual(out.components.CardProject.tokens, ['bg/surface']);
  assert.deepEqual(out.components.WallTool.props, { Size: ['grand'] });
  assert.equal(out.components.WallTool.role, 'Grille des outils.');
  assert.match(stderr, /doublon : « Card projets »/);
  assert.match(stderr, /déjà dans l'atelier : Button/);
  assert.match(stderr, /propriété non reprise : TagThemes « Has icon »/);
});
