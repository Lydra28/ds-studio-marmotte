import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COVER,
  GRID,
  ICON,
  ICON_128,
  UI,
  decodePng,
  encodePng,
  resample,
  runsOf,
  spriteOf,
  spriteSvg,
} from '../scripts/plugin-assets.mjs';

// Visuels du plugin pour la Community et mascotte de ui.html : tous dérivés
// du logo de l'app (desktop/icon.png). Si l'icône change, relancer
// `node scripts/plugin-assets.mjs` et reporter le SVG dans ui.html.

const header = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test('visuels : le logo est bien un pixel art 16 × 16 à trois couleurs sur fond transparent', async () => {
  const grid = spriteOf(decodePng(await readFile(ICON)));
  assert.equal(grid.length, GRID);
  const colors = new Set(grid.flat());
  assert.ok(colors.has(''), 'coins transparents attendus');
  assert.deepEqual([...colors].filter(Boolean).sort(), ['#0b0b0c', '#e8ff3a', '#f2f1ec']);
  // Le contour fait le tour : première et dernière lignes, coins exclus.
  assert.equal(grid[0].slice(2, 14).join(''), '#0b0b0c'.repeat(12));
  assert.equal(grid[GRID - 1].slice(2, 14).join(''), '#0b0b0c'.repeat(12));
});

test('visuels : icône 128 × 128 identique au logo, case par case', async () => {
  const icon = decodePng(await readFile(ICON));
  const published = decodePng(await readFile(ICON_128));
  assert.deepEqual(header(await readFile(ICON_128)), { width: 128, height: 128 });
  assert.deepEqual(spriteOf(published), spriteOf(icon), 'icon-128.png ne correspond plus à desktop/icon.png');
  // Chaîne PNG : ce qui est encodé se relit à l'identique.
  const again = decodePng(encodePng(resample(icon, 128, 128)));
  assert.ok(again.pixels.equals(published.pixels), 'icon-128.png diffère de la génération courante');
});

test('visuels : vignette 1920 × 1080 présente', async () => {
  assert.deepEqual(header(await readFile(COVER)), { width: 1920, height: 1080 });
});

test('plugin : la mascotte de ui.html est le sprite du logo, en 32 px', async () => {
  const grid = spriteOf(decodePng(await readFile(ICON)));
  const ui = await readFile(UI, 'utf8');
  const match = /<svg class="mascot"[^>]*>([^]*?)<\/svg>/.exec(ui);
  assert.ok(match, 'ui.html doit contenir <svg class="mascot">');
  const opening = match![0].slice(0, match![0].indexOf('>') + 1);
  assert.ok(opening.includes(`viewBox="0 0 ${GRID} ${GRID}"`), 'viewBox de la grille attendu');
  assert.ok(opening.includes('width="32"') && opening.includes('height="32"'), '32 px : deux pixels par case');
  assert.ok(opening.includes('shape-rendering="crispEdges"'), 'rendu net attendu');
  const rect = (attrs: string) => {
    const read = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
    return { x: Number(read('x')), y: Number(read('y')), w: Number(read('width')), h: Number(read('height')), fill: read('fill') };
  };
  const drawn = [...match![1].matchAll(/<rect ([^>]*?)\/>/g)].map((m) => rect(m[1]));
  assert.deepEqual(drawn, runsOf(grid), 'les rectangles de ui.html ne sont plus ceux du logo');
  // Et le générateur produit exactement ce balisage.
  assert.ok(ui.includes(spriteSvg(grid, 32)), 'ui.html doit contenir la sortie de `plugin-assets.mjs --svg`');
});
