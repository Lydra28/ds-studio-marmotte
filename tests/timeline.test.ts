import assert from 'node:assert/strict';
import test from 'node:test';
import { setsByRevision, type State, type Token } from '../app/shared/model.js';

const space = (value: number): Token => ({ $type: 'dimension', $collection: 'primitives', $values: { default: value } });
const revision = (n: number, patches: State['history'][number]['patches']) => ({
  id: `r${n}`,
  revision: n,
  date: `2026-10-28T10:0${n}:00.000Z`,
  source: 'manual' as const,
  patches,
});

test('évolution : jeu reconstruit à chaque révision, du départ à l’état enregistré', () => {
  // Départ : space/sm 15. r1 le corrige à 16, r2 ajoute space/md, r3 retire space/sm.
  const state: State = {
    version: 2,
    revision: 3,
    set: {
      modes: { primitives: ['default'], tokens: ['light'], typography: ['desktop'] },
      tokens: { 'space/md': space(24) },
      components: {},
    },
    history: [
      revision(1, [{ key: 'space/sm', before: space(15), after: space(16) }]),
      revision(2, [{ key: 'space/md', before: null, after: space(24) }]),
      revision(3, [{ key: 'space/sm', before: space(16), after: null }]),
    ],
  };
  const sets = setsByRevision(state);
  assert.equal(sets.length, 4);
  assert.deepEqual(Object.keys(sets[0].tokens), ['space/sm']);
  assert.equal(sets[0].tokens['space/sm'].$values.default, 15);
  assert.equal(sets[1].tokens['space/sm'].$values.default, 16);
  assert.deepEqual(Object.keys(sets[2].tokens).sort(), ['space/md', 'space/sm']);
  assert.equal(sets[3], state.set); // le dernier cran est l'état enregistré lui-même
  assert.equal(state.set.tokens['space/sm'], undefined); // rien n'est modifié en place
});
