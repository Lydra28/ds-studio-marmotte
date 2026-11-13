import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RATE } from '../server/credits.js';

// La CGV écrit le coefficient en clair (décision de Romain du 2026-11-13) :
// RATE changé sans la CGV (et son préavis de 30 jours) doit casser ce test.
test('CGV : le coefficient de débit écrit est celui du serveur', () => {
  const cgv = readFileSync('site/src/pages/cgv.astro', 'utf8');
  const written = String(RATE).replace('.', ',');
  assert.match(cgv, new RegExp(`multiplié par ${written} `));
  assert.match(cgv, new RegExp(`coefficient de ${written} `));
});
