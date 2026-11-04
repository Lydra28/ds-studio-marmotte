// Captures de l'app pour le site vitrine (lot 7) : lance le serveur des tests
// (copie jetable de Marmotte, faux serveur DS-Studio, inventaire de fixture,
// aucun réseau) et photographie trois écrans dans site/public/captures/.
// Relancer après un changement visible de l'interface : node scripts/site-shots.mjs
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = 'http://127.0.0.1:4318';
const out = 'site/public/captures';
await mkdir(out, { recursive: true });

const server = spawn(process.execPath, ['scripts/e2e-server.mjs'], { stdio: ['ignore', 'ignore', 'inherit'] });
const stop = () => server.kill('SIGTERM');
try {
  for (let i = 0; ; i++) {
    if (await fetch(`${base}/api/state`).then((r) => r.ok, () => false)) break;
    if (i > 60) throw new Error('serveur des tests injoignable après 30 s');
    await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

  await page.goto(`${base}/#/p/marmotte`);
  await page.getByRole('heading', { name: 'Couleurs · Primitives' }).waitFor();
  await page.getByRole('button', { name: 'Tout déplier' }).click();
  await shot('planche');

  // Diff d'une correction : écart signalé, correction essayée, diff ouvert.
  await page.getByLabel('space/sm', { exact: true }).fill('15');
  await page.getByRole('button', { name: 'Essayer 16 px' }).click();
  // Planche en haut et fin du saut de joie de la mascotte avant la photo.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  await page.getByRole('dialog').waitFor();
  await shot('versions');

  await page.goto(`${base}/`);
  await page.getByRole('button', { name: /Nouveau projet/ }).click();
  const form = page.getByRole('form', { name: 'Nouveau projet' });
  await form.getByLabel('Nom').fill('Atelier');
  await form.getByLabel('Adresse du site (facultatif)').fill('https://atelier-fixture.example/');
  await form.getByRole('button', { name: 'Créer le projet' }).click();
  await page.getByRole('region', { name: 'Extraction du site' }).getByRole('heading', { name: /Styles lus sur/ }).waitFor();
  await shot('extraction');

  await browser.close();
  console.log(`captures écrites dans ${out}`);
} finally {
  stop();
}
