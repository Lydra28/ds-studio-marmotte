import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../app/client/ocean/world.js';
import { tooSlow } from '../app/client/Ocean.js';

// Simulation d'ascii-sharks (code repris tel quel) : on vérifie seulement
// qu'elle tourne longtemps sans dériver dans la taille de l'accueil.
test('océan : 20 s de simulation, tout reste fini et près du cadre', () => {
  const w = new World();
  w.resize(1280, 800, 10, 15);
  const fish = w.fish.length;
  assert.ok(fish > 0 && w.sharks.length === 4);
  for (let i = 0; i < 60 * 20; i++) w.step(1 / 60);
  assert.equal(w.fish.length, fish);
  for (const f of w.fish) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
  for (const s of w.sharks) {
    assert.ok(Number.isFinite(s.nodes[0]) && Number.isFinite(s.nodes[1]));
    assert.ok(s.nodes[0] > -s.length && s.nodes[0] < 1280 + s.length);
    assert.ok(s.nodes[1] > -s.length && s.nodes[1] < 800 + s.length);
  }
});

test('océan : un redimensionnement garde les créatures dans le nouveau cadre', () => {
  const w = new World();
  w.resize(1280, 800, 10, 15);
  w.resize(400, 300, 8, 12);
  for (const f of w.fish) assert.ok(f.x >= 0 && f.x <= 400 && f.y >= 0 && f.y <= 300);
  w.step(1 / 60);
  for (const f of w.fish) assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
});

test('océan : figé si l’intervalle médian dépasse 1/28 s, pas sur quelques à-coups', () => {
  assert.equal(tooSlow(Array(100).fill(1000 / 30 + 0.5)), false); // écran bridé à 30 Hz
  assert.equal(tooSlow(Array(100).fill(1000 / 60)), false);
  assert.equal(tooSlow(Array(100).fill(4.2)), false); // écran 240 Hz, images sautées
  assert.equal(tooSlow([...Array(60).fill(16.7), ...Array(40).fill(120)]), false);
  assert.equal(tooSlow(Array(50).fill(40)), true); // ×4 : 25 i/s
  assert.equal(tooSlow([]), false);
});
