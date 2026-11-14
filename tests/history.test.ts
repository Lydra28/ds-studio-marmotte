import assert from 'node:assert/strict';
import test from 'node:test';
import { changeSummary } from '../app/client/History.js';
import type { Patch, Token } from '../app/shared/model.js';

const token = ($type: string): Token => ({ $type, $collection: 'primitives', $values: { default: 1 } }) as Token;

test('historique : ce qui a changé, compté par type, au singulier ou au pluriel', () => {
  const patches: Patch[] = [
    { key: 'color/a', before: token('color'), after: token('color') },
    { key: 'color/b', before: null, after: token('color') },
    { key: 'color/c', before: token('color'), after: null },
    { key: 'space/md', before: token('dimension'), after: token('dimension') },
    { kind: 'component', key: 'Card', before: null, after: null },
  ];
  assert.equal(changeSummary(patches), '3 couleurs, 1 taille, 1 fiche');
  assert.equal(changeSummary([]), 'Aucun changement');
});
