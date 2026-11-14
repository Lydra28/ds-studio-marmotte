import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  COVER,
  GRID,
  ICON,
  ICON_128,
  LOGO_COLORS,
  SMALL,
  UI,
  decodePng,
  encodePng,
  resample,
  runsOf,
  smallLogo,
  spriteOf,
  spriteSvg,
} from '../scripts/plugin-assets.mjs';
import { LOGO_64, LOGO_64_EYES } from '../app/client/sprites.js';
import { ICON_512, LOGO_SMALL } from '../scripts/logo.mjs';

// Logo (requin marteau) : app/client/sprites.ts, desktop/icon.png et les
// visuels du plugin viennent tous de scripts/logo.mjs. Si le dessin change,
// relancer `node scripts/logo.mjs`, `node scripts/plugin-assets.mjs`, et
// reporter dans ui.html la sortie de `node scripts/plugin-assets.mjs --svg`.

const header = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

test('visuels : desktop/icon.png est le logo de sprites.ts, 64 × 64, encre, lime et ombre sur fond transparent', async () => {
  const grid = spriteOf(decodePng(await readFile(ICON)));
  assert.equal(grid.length, GRID);
  const expected = LOGO_64.map((row) => [...row].map((k) => (k === '.' ? '' : LOGO_COLORS[k as keyof typeof LOGO_COLORS])));
  for (const [x, y, w, h] of LOGO_64_EYES) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) expected[y + j][x + i] = LOGO_COLORS['#'];
  assert.deepEqual(grid, expected, 'icon.png ne correspond plus à sprites.ts : relancer scripts/logo.mjs');
  assert.deepEqual([...new Set(grid.flat())].sort(), ['', '#07080a', '#86b81c', '#bdff2e']);
  // Contour : aucune case colorée ne touche une case transparente sans encre entre les deux.
  grid.forEach((row, y) =>
    row.forEach((c, x) => {
      if (!c || c === '#07080a') return;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) assert.notEqual(grid[y + dy]?.[x + dx] ?? '', '', `case (${x}, ${y}) sans contour`);
    }),
  );
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

test('plugin : le logo de ui.html est la grille 32 × 32 du logo, en 32 px', async () => {
  const grid = await smallLogo();
  const ui = await readFile(UI, 'utf8');
  const match = /<svg class="mascot"[^>]*>([^]*?)<\/svg>/.exec(ui);
  assert.ok(match, 'ui.html doit contenir <svg class="mascot">');
  const opening = match![0].slice(0, match![0].indexOf('>') + 1);
  assert.ok(opening.includes(`viewBox="0 0 ${SMALL} ${SMALL}"`), 'viewBox de la grille attendu');
  assert.ok(opening.includes('width="32"') && opening.includes('height="32"'), '32 px : un pixel par case');
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

test('site : desktop/logo-small.png est la grille 32 × 32 du logo, 2 px par case', async () => {
  const png = decodePng(await readFile(LOGO_SMALL));
  assert.deepEqual([png.width, png.height], [64, 64]);
  const cell = (x: number, y: number) => {
    const i = (y * 2 * 64 + x * 2) * 4;
    return png.pixels[i + 3] === 0 ? '' : '#' + png.pixels.subarray(i, i + 3).toString('hex');
  };
  const grid = await smallLogo();
  grid.forEach((row: string[], y: number) => row.forEach((c: string, x: number) => assert.equal(cell(x, y), c, `case (${x}, ${y})`)));
});

test('paquets : desktop/icon-512.png est le même logo que desktop/icon.png, 8 px par case', async () => {
  assert.deepEqual(header(await readFile(ICON_512)), { width: 512, height: 512 });
  assert.deepEqual(spriteOf(decodePng(await readFile(ICON_512))), spriteOf(decodePng(await readFile(ICON))));
});

// shortcut: aucun test ne repixelise les silhouettes de scripts/logo.mjs
// (il faudrait Chromium dans les tests unitaires) ; un dessin modifié sans
// relancer le script reste vert. À revoir si le dessin change souvent.
