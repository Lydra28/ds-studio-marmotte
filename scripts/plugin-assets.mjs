// Visuels du plugin Figma pour la Community (icône 128 × 128, vignette
// 1920 × 1080, dossier figma-plugin/community/) et mascotte en ligne de
// figma-plugin/ui.html, tous dérivés du logo de l'app, desktop/icon.png
// (pixel art, grille 16 × 16, comme desktop/icon-512.png). Aucune
// dépendance : PNG lu et écrit avec zlib ; la vignette, qui porte du texte,
// est rendue par le Chromium de Playwright, déjà installé pour les tests.
// Polices Google chargées à la génération seulement ; hors ligne, repli
// système. Le test tests/plugin-assets.test.ts vérifie que les fichiers
// produits et la mascotte de ui.html correspondent toujours à l'icône.
// Usage : node scripts/plugin-assets.mjs        écrit les deux PNG
//         node scripts/plugin-assets.mjs --svg  affiche la mascotte SVG de ui.html
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GRID = 16;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ICON = path.join(root, 'desktop/icon.png');
export const UI = path.join(root, 'figma-plugin/ui.html');
export const OUT = path.join(root, 'figma-plugin/community');
export const ICON_128 = path.join(OUT, 'icon-128.png');
export const COVER = path.join(OUT, 'cover-1920x1080.png');

// Palette de la DA « Atelier 8-bit » (app/client/pixel.css).
const INK = '#0b0b0c';
const PAPER = '#f2f1ec';
const SOFT = '#c9c7bf';
const ACCENT = '#e8ff3a';
const DOTS = '#1d1d21';

const chunkType = (buf, offset) => buf.toString('ascii', offset + 4, offset + 8);

// PNG 8 bits, RGB ou RGBA, sans entrelacement : retourne des pixels RGBA.
export function decodePng(buf) {
  if (buf.toString('ascii', 1, 4) !== 'PNG') throw new Error('Pas un fichier PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = chunkType(buf, offset);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) {
        throw new Error(`PNG non géré (profondeur ${depth}, type ${color}, entrelacement ${body[12]}) : attendu 8 bits RGB ou RGBA`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4, 255);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[i] = value & 255;
    }
    for (let x = 0; x < width; x++) {
      current.copy(pixels, (y * width + x) * 4, x * channels, x * channels + channels);
    }
    previous = current;
  }
  return { width, height, pixels };
}

const chunk = (type, body) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typed));
  return Buffer.concat([length, typed, crc]);
};

// PNG RGBA 8 bits, filtre « aucun » sur chaque ligne.
export function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Plus proche voisin : chaque pixel de sortie reprend un pixel source, sans mélange.
export function resample(png, width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * png.height) / height);
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * png.width) / width);
      png.pixels.copy(pixels, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4);
    }
  }
  return { width, height, pixels };
}

const hex = (pixels, i) => (pixels[i + 3] === 0 ? '' : '#' + pixels.subarray(i, i + 3).toString('hex'));

// Grille 16 × 16 du sprite : '' pour une case transparente, sinon '#rrggbb'.
// Chaque case doit être unie, sinon l'image n'est pas le pixel art attendu.
export function spriteOf(png) {
  if (png.width !== png.height || png.width % GRID !== 0) {
    throw new Error(`Icône ${png.width} × ${png.height} : attendu un carré multiple de ${GRID}`);
  }
  const cell = png.width / GRID;
  const grid = [];
  for (let gy = 0; gy < GRID; gy++) {
    const row = [];
    for (let gx = 0; gx < GRID; gx++) {
      const first = hex(png.pixels, (gy * cell * png.width + gx * cell) * 4);
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const i = ((gy * cell + y) * png.width + gx * cell + x) * 4;
          if (hex(png.pixels, i) !== first) throw new Error(`Case (${gx}, ${gy}) de l'icône non unie : pas une grille ${GRID} × ${GRID}`);
        }
      }
      row.push(first);
    }
    grid.push(row);
  }
  return grid;
}

// Plages horizontales de même couleur fusionnées en rectangles (comme Mascot.tsx).
export function runsOf(grid) {
  const rects = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < GRID) {
      const fill = row[x];
      let w = 1;
      while (x + w < GRID && row[x + w] === fill) w++;
      if (fill) rects.push({ x, y, w, h: 1, fill });
      x += w;
    }
  });
  return rects;
}

// Mascotte en SVG net (crispEdges) ; `size` en pixels CSS, multiple de 16
// pour que chaque case tombe sur des pixels entiers.
export function spriteSvg(grid, size) {
  const rects = runsOf(grid)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}" />`)
    .join('');
  return `<svg class="mascot" viewBox="0 0 ${GRID} ${GRID}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}

// Vignette 1920 × 1080 : mascotte à gauche, nom et accroche à droite, fond
// de la DA. Rendue par Chromium (texte), capturée à l'échelle 1.
export async function renderCover(grid, out) {
  const { chromium } = await import('@playwright/test');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Pixelify+Sans:wght@700&family=Silkscreen&display=block" />
<style>
  html, body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; }
  body {
    box-sizing: border-box; display: flex; align-items: center; gap: 128px; padding: 0 176px;
    background: ${INK} radial-gradient(${DOTS} 3px, transparent 3px) 16px 16px / 48px 48px;
    color: ${PAPER}; font-family: 'Geist', 'Segoe UI', system-ui, sans-serif;
  }
  .mascot { width: 544px; height: 544px; flex: none; }
  .text { display: flex; flex-direction: column; gap: 32px; }
  .kicker { font-family: 'Silkscreen', 'Geist Mono', ui-monospace, monospace; font-size: 30px; letter-spacing: 0.08em; text-transform: uppercase; color: ${ACCENT}; }
  h1 { font-family: 'Pixelify Sans', 'Silkscreen', 'Geist', sans-serif; font-weight: 700; font-size: 176px; line-height: 0.95; margin: 0; }
  p { font-size: 46px; line-height: 1.3; margin: 0; color: ${SOFT}; max-width: 880px; }
</style></head><body>
${spriteSvg(grid, 544)}
<div class="text">
  <div class="kicker">Plugin Figma · atelier local</div>
  <h1>DS-Studio</h1>
  <p>Écrit la version acceptée de ton design system dans Figma, et renvoie tes composants à l’atelier.</p>
</div>
</body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 }).catch(() => {
      console.warn('vignette : polices Google non chargées (hors ligne ?), polices système');
    });
    await page.evaluate(() => document.fonts.ready).catch(() => {});
    await page.screenshot({ path: out, type: 'png', fullPage: false });
  } finally {
    await browser.close();
  }
}

async function main() {
  const grid = spriteOf(decodePng(await fs.readFile(ICON)));
  if (process.argv.includes('--svg')) {
    process.stdout.write(spriteSvg(grid, 32) + '\n');
    return;
  }
  await fs.mkdir(OUT, { recursive: true });
  const icon = resample(decodePng(await fs.readFile(ICON)), 128, 128);
  await fs.writeFile(ICON_128, encodePng(icon));
  console.log(`icône 128 × 128 : ${path.relative(root, ICON_128)}`);
  await renderCover(grid, COVER);
  console.log(`vignette 1920 × 1080 : ${path.relative(root, COVER)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
