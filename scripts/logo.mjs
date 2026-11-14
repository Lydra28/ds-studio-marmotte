// Logo et mascotte de DS-Studio : requins marteau en pixel art (choix de
// Romain du 2026-11-14). Seule source : les silhouettes vectorielles
// ci-dessous (coordonnées 0..64), pixelisées par le Chromium de Playwright
// (couverture d'une case ≥ 45 %), contour encre ajouté autour.
// Écrit :
//   app/client/sprites.ts   grilles du logo (64 et 32) et de la mascotte (64)
//   desktop/icon.png        logo 64 × 64, 4 px par case (256 px)
//   desktop/icon-512.png    logo 64 × 64, 8 px par case
//   desktop/logo-small.png  logo 32 × 32, 2 px par case (64 px) : favicon et
//                           en-tête du site, nets à 16 et 32 px
// Puis relancer `node scripts/plugin-assets.mjs` (icône et vignette du
// plugin, SVG de figma-plugin/ui.html à reporter). Le test
// tests/plugin-assets.test.ts vérifie que tout correspond.
// Usage : node scripts/logo.mjs [--print]   (--print : grilles en texte)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng } from './plugin-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPRITES = path.join(root, 'app/client/sprites.ts');
const ICON = path.join(root, 'desktop/icon.png');
export const ICON_512 = path.join(root, 'desktop/icon-512.png');
export const LOGO_SMALL = path.join(root, 'desktop/logo-small.png');

// Couleurs des fichiers image (le logo n'est pas teinté) : encre et lime de
// la DA « Atelier acide » (app/client/da.css), ombre = lime assombri.
export const PALETTE = { '#': '#07080a', Y: '#bdff2e', s: '#86b81c', e: '#07080a' };

// Calques dans l'ordre : body crée la forme ; shade (s) ne recolore que ce
// qui est déjà dans la forme.
const DRAWINGS = {
  // Vu de dessus, il nage vers le haut : marteau, pectorales, queue en croissant.
  logo: {
    // Remonté pour centrer la silhouette dans le carré.
    shift: [0, -6],
    layers: [
      ['body', 'M7,18.4 C14,15.6 22,14.6 32,14.4 C42,14.6 50,15.6 57,18.4 C58.6,19.4 58.8,22 57,23.2 C53,22.6 48,22.2 43,22.6 C39.5,23 37.5,24 36.6,26 L27.4,26 C26.5,24 24.5,23 21,22.6 C16,22.2 11,22.6 7,23.2 C5.2,22 5.4,19.4 7,18.4 Z'],
      // Symétrique autour de x = 32. Nageoires harmonisées (demande de Romain
      // du 2026-11-14) : pectorales réduites, pelviennes de même forme à
      // environ la moitié, queue alignée sur l'axe.
      ['body', 'M27.4,24 C24.6,30 24.6,36 26.4,42 C27.8,47 29.6,51.5 30.6,55.5 L33.4,55.5 C34.4,51.5 36.2,47 37.6,42 C39.4,36 39.4,30 36.6,24 Z'],
      ['body', 'M26.4,31 C21.5,33 17,37 13,42 C16,42.2 19.6,40.8 22.8,38.6 C24.6,37.4 25.8,36.4 26.8,36 Z'],
      ['body', 'M37.6,31 C42.5,33 47,37 51,42 C48,42.2 44.4,40.8 41.2,38.6 C39.4,37.4 38.2,36.4 37.2,36 Z'],
      ['body', 'M27.6,44 C25,45.5 22.6,48 20.6,51 C22.6,51 25,50 27.2,48.6 C28,48.1 28.6,47.8 29,47.6 Z'],
      ['body', 'M36.4,44 C39,45.5 41.4,48 43.4,51 C41.4,51 39,50 36.8,48.6 C36,48.1 35.4,47.8 35,47.6 Z'],
      ['body', 'M30.6,54 C28.4,57.4 25.4,60.2 22,62.2 C26,61.8 29.4,60.4 32,58.6 C34.6,60.4 38,61.8 42,62.2 C38.6,60.2 35.6,57.4 33.4,54 Z'],
      ['shade', 'M33,24 L36.6,24 C39.4,30 39.4,36 37.6,42 C36.2,47 34.4,51.5 33.4,55.5 L32.2,55.5 C32.8,50 33.4,44 33.4,38 Z'],
      ['shade', 'M37.2,36 C40.5,38.2 45,40.6 51,42 C48,42.2 44.4,40.8 41.2,38.6 Z'],
      ['shade', 'M35,47.6 C37.6,48.6 40.4,50 43.4,51 C41.4,51 39,50 36.8,48.6 Z'],
      ['shade', 'M5,21.6 C11,21 16,21 21,21.4 C26,21.8 28,22.8 32,22.8 C36,22.8 38,21.8 43,21.4 C48,21 53,21 59,21.6 L59,24 L5,24 Z'],
      ['shade', 'M32,58.6 C34.6,60.4 38,61.8 42,62.2 C38.6,60.2 35.6,57.4 33.4,54 L32.6,56 Z'],
    ],
    eyes: [[8, 14, 2, 2], [54, 14, 2, 2]],
  },
  // De face, il fonce vers toi : marteau en arc, aileron, pectorales, sans
  // ventre clair ; le visage est dessiné par Mascot.tsx selon l'humeur.
  assistant: {
    layers: [
      ['body', 'M29.6,26 C30.6,16 33,9 37.4,4.6 C36.2,12 35.4,19 36.2,26 Z'],
      ['body', 'M3,27 C12,21 22,19.2 32,19.2 C42,19.2 52,21 61,27 C62.2,28.2 62.2,31 61,32.6 C52,29 42,28.2 32,28.2 C22,28.2 12,29 3,32.6 C1.8,31 1.8,28.2 3,27 Z'],
      ['body', 'M32,24 C42,24 44.4,31 43.6,38 C42.6,46 37.4,51.4 32,51.4 C26.6,51.4 21.4,46 20.4,38 C19.6,31 22,24 32,24 Z'],
      ['body', 'M23,37 C18,42 13,49 8,55.4 C15,52.4 21,47.4 25.4,43 Z'],
      ['body', 'M41,37 C46,42 51,49 56,55.4 C49,52.4 43,47.4 38.6,43 Z'],
      ['shade', 'M2,30.4 C12,27.2 22,26.6 32,26.6 C42,26.6 52,27.2 62,30.4 L61,32.6 C52,29 42,28.2 32,28.2 C22,28.2 12,29 3,32.6 Z'],
      ['shade', 'M34.4,26 C34,18 35.4,10 37.4,4.6 C36.2,12 35.4,19 36.2,26 Z'],
      ['shade', 'M39,27 C42.6,30.6 44,35 43.4,39.4 C42.4,46 37.4,51.4 32,51.4 C36,48.6 39,44 39.8,38.6 C40.4,34.4 40,30.4 39,27 Z'],
      ['shade', 'M38.6,43 C43,47.4 49,52.4 56,55.4 C50.6,51 46,47.4 41.4,40.6 Z'],
    ],
    eyes: [],
  },
};

const KIND = { body: 'Y', shade: 's' };

// Grille n × n de caractères : '.' vide, '#' contour, 'Y', 's'.
async function rasterize(page, drawing, n) {
  const grid = await page.evaluate(
    ({ layers, shift, n }) => {
      const S = 8;
      const c = document.createElement('canvas');
      c.width = c.height = n * S;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const cover = (d) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.setTransform((S * n) / 64, 0, 0, (S * n) / 64, 0, 0);
        ctx.translate(shift[0], shift[1]);
        ctx.fill(new Path2D(d));
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        return (x, y) => {
          let a = 0;
          for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) a += img[((y * S + j) * c.width + x * S + i) * 4 + 3];
          return a / (S * S * 255);
        };
      };
      const grid = Array.from({ length: n }, () => Array(n).fill('.'));
      for (const [kind, d] of layers) {
        const at = cover(d);
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            if (at(x, y) < 0.45) continue;
            if (kind === 'body') grid[y][x] = grid[y][x] === '.' ? 'body' : grid[y][x];
            else if (grid[y][x] !== '.') grid[y][x] = kind;
          }
      }
      return grid;
    },
    { layers: drawing.layers, shift: drawing.shift ?? [0, 0], n },
  );
  const cells = grid.map((row) => row.map((k) => (k === '.' ? '.' : KIND[k])));
  // Contour : case vide touchant (4 voisins) une case pleine.
  const filled = (x, y) => cells[y]?.[x] !== undefined && cells[y][x] !== '.' && cells[y][x] !== '#';
  const out = cells.map((row, y) =>
    row.map((k, x) => (k === '.' && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ? '#' : k)),
  );
  return out.map((row) => row.join(''));
}

// Yeux du logo (64 de côté) ramenés à une grille n.
const eyesAt = (eyes, n) => eyes.map(([x, y, w, h]) => [x, y, w, h].map((v) => Math.max(1, Math.round((v * n) / 64))).map((v, i) => (i < 2 ? Math.floor((([x, y][i]) * n) / 64) : v)));

// Image du logo : chaque case en `scale` × `scale` pixels, yeux compris.
export function logoPng(rows, eyes, scale) {
  const n = rows.length;
  const size = n * scale;
  const pixels = Buffer.alloc(size * size * 4);
  const paint = (x, y, hex) => {
    for (let j = 0; j < scale; j++)
      for (let i = 0; i < scale; i++) {
        const p = ((y * scale + j) * size + x * scale + i) * 4;
        pixels[p] = parseInt(hex.slice(1, 3), 16);
        pixels[p + 1] = parseInt(hex.slice(3, 5), 16);
        pixels[p + 2] = parseInt(hex.slice(5, 7), 16);
        pixels[p + 3] = 255;
      }
  };
  rows.forEach((row, y) => [...row].forEach((k, x) => k !== '.' && paint(x, y, PALETTE[k])));
  for (const [x, y, w, h] of eyes) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) paint(x + i, y + j, PALETTE.e);
  return encodePng({ width: size, height: size, pixels });
}

const list = (rows) => rows.map((r) => `  '${r}',`).join('\n');

async function main() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const logo64 = await rasterize(page, DRAWINGS.logo, 64);
    const logo32 = await rasterize(page, DRAWINGS.logo, 32);
    const assistant = await rasterize(page, DRAWINGS.assistant, 64);
    const eyes64 = DRAWINGS.logo.eyes;
    const eyes32 = eyesAt(DRAWINGS.logo.eyes, 32);
    if (process.argv.includes('--print')) {
      console.log(['logo 64', ...logo64, 'logo 32', ...logo32, 'assistant 64', ...assistant].join('\n'));
      return;
    }
    const ts = `// GÉNÉRÉ par scripts/logo.mjs depuis les silhouettes vectorielles : ne pas
// modifier à la main (changer le dessin dans le script, puis le relancer).
// '.' vide, '#' contour, 'Y' teinte, 's' ombre.
export type Rect = [x: number, y: number, w: number, h: number];

/** Logo (vu de dessus), 64 × 64 : icône, pop-in d'accueil. */
export const LOGO_64 = [
${list(logo64)}
];
export const LOGO_64_EYES: Rect[] = ${JSON.stringify(eyes64)};

/** Logo, 32 × 32 : petites tailles (en-tête du plugin). */
export const LOGO_32 = [
${list(logo32)}
];
export const LOGO_32_EYES: Rect[] = ${JSON.stringify(eyes32)};

/** Mascotte de l'assistant (de face), 64 × 64, sans visage. */
export const ASSISTANT_64 = [
${list(assistant)}
];
`;
    await fs.writeFile(SPRITES, ts);
    await fs.writeFile(ICON, logoPng(logo64, eyes64, 4));
    await fs.writeFile(ICON_512, logoPng(logo64, eyes64, 8));
    await fs.writeFile(LOGO_SMALL, logoPng(logo32, eyes32, 2));
    console.log(`sprites : ${path.relative(root, SPRITES)}\nicônes : desktop/icon.png (256), desktop/icon-512.png (512), desktop/logo-small.png (64)`);
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
