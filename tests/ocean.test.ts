import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOcean, resizeOcean, SCHOOL, sharkPixels, step, SHARK } from '../app/client/ocean-sim.js';

// Hasard reproductible : même océan à chaque essai.
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test('océan : le banc reste dans le cadre et sous la vitesse maximale', () => {
  const rand = seeded(7);
  const o = createOcean(320, 180, rand);
  for (let i = 0; i < 2000; i++) step(o, rand);
  assert.equal(o.fish.length, SCHOOL.count);
  for (const f of o.fish) {
    assert.ok(f.x >= 0 && f.x <= o.w && f.y >= 0 && f.y <= o.h);
    assert.ok(Math.hypot(f.vx, f.vy) <= SCHOOL.maxSpeed + 1e-9);
  }
});

test('océan : un poisson près du requin proche s’en éloigne', () => {
  const rand = seeded(3);
  const o = createOcean(320, 180, rand);
  const shark = o.sharks.find((s) => !s.far)!;
  shark.vx = 0;
  const cx = shark.x + (SHARK[0].length * shark.scale) / 2;
  const cy = shark.y + (SHARK.length * shark.scale) / 2;
  // Un seul poisson, posé juste au-dessus du requin et immobile.
  o.fish = [{ x: cx, y: cy - 14, vx: 0.4, vy: 0 }];
  const before = Math.hypot(o.fish[0].x - cx, o.fish[0].y - cy);
  for (let i = 0; i < 10; i++) step(o, rand);
  const after = Math.hypot(o.fish[0].x - cx, o.fish[0].y - cy);
  assert.ok(after > before, `${after} > ${before}`);
});

test('océan : une fenêtre réduite à 0 px ne casse pas la simulation', () => {
  const rand = seeded(5);
  const o = createOcean(320, 180, rand);
  resizeOcean(o, 0, 0);
  resizeOcean(o, 400, 200);
  step(o, rand);
  for (const p of [...o.sharks, ...o.fish, ...o.bubbles]) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('océan : les requins repartent de l’autre côté et se retournent à gauche', () => {
  const o = createOcean(100, 60, seeded(1));
  const [near] = o.sharks;
  near.x = 120;
  step(o, seeded(2));
  assert.ok(near.x < 0);
  const right = sharkPixels({ ...near, x: 0, y: 0, vx: 1, scale: 1 }, 0);
  const left = sharkPixels({ ...near, x: 0, y: 0, vx: -1, scale: 1 }, 0);
  const eye = (p: [number, number, string][]) => p.find(([, , c]) => c === 'e')![0];
  assert.ok(eye(right) > SHARK[0].length / 2, 'œil à droite quand il nage à droite');
  assert.ok(eye(left) < SHARK[0].length / 2, 'œil à gauche quand il nage à gauche');
});
