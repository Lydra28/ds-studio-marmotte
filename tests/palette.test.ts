import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRamp, hexToOklch, oklchToHex, STANDARD_STEPS } from '../app/shared/palette.js';

test('gamme : couleur exacte à son palier, clarté régulière du clair au foncé, couleurs affichables', () => {
  for (const [hex, anchor] of [
    ['#05FA42', 500], // vert Devonia, très lumineux
    ['#2F6BFF', 600],
    ['#7A1F1F', 800],
    ['#F4F4F5', 100],
  ] as const) {
    const ramp = generateRamp(hex, anchor, [...STANDARD_STEPS, 950]);
    assert.deepEqual(ramp.map((r) => r.step), [...STANDARD_STEPS, 950]);
    assert.equal(ramp.find((r) => r.step === anchor)!.hex, hex);
    for (const r of ramp) assert.match(r.hex, /^#[0-9A-F]{6}$/);
    const L = ramp.map((r) => hexToOklch(r.hex)[0]);
    for (let i = 1; i < L.length; i++) assert.ok(L[i] < L[i - 1], `${hex} : palier ${ramp[i].step} plus clair que le précédent`);
    // Teinte gardée sur les paliers saturés.
    const [, , h] = hexToOklch(hex);
    for (const r of ramp) {
      const [, c, rh] = hexToOklch(r.hex);
      if (c > 0.03) assert.ok(Math.abs(((rh - h + 540) % 360) - 180) < 8, `${hex} : teinte de ${r.step} dérive`);
    }
  }
});

test('gamme : contraste blanc et noir calculé par palier', () => {
  const ramp = generateRamp('#2F6BFF', 600, STANDARD_STEPS);
  assert.ok(ramp[0].onBlack > 15 && ramp[0].onWhite < 1.2); // 50 : texte noir
  assert.ok(ramp.at(-1)!.onWhite > 10); // 900 : texte blanc
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i].onWhite > ramp[i - 1].onWhite);
});

test('OKLCH : aller-retour fidèle, couleur hors sRGB ramenée dans le gamut', () => {
  for (const hex of ['#000000', '#FFFFFF', '#05FA42', '#2F6BFF', '#7A1F1F']) assert.equal(oklchToHex(...hexToOklch(hex)), hex);
  assert.match(oklchToHex(0.7, 0.4, 145), /^#[0-9A-F]{6}$/);
});
