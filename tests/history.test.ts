import assert from 'node:assert/strict';
import test from 'node:test';
import { changeSummary, restoreBlocked } from '../app/client/History.js';
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

test('historique : « Revenir à cette version » grisé seulement sur la version enregistrée, raison dite en clair', () => {
  assert.equal(restoreBlocked(3, 5, false), null);
  assert.equal(restoreBlocked(3, 5, true), null);
  assert.equal(restoreBlocked(5, 5, false), 'Version enregistrée en cours : rien à rétablir.');
  assert.match(restoreBlocked(5, 5, true)!, /brouillon se défait par « Abandonner »/);
  // Ton des textes : ni « tu » ni impératif.
  for (const text of [restoreBlocked(5, 5, false), restoreBlocked(5, 5, true)]) assert.doesNotMatch(text!, /tu|ton|ta/i);
});
