// Régénère tests/fixtures/site/inventory.json : lecture réelle (Chromium de
// Playwright, sans réseau) de tests/fixtures/site/index.html en deux largeurs.
// À relancer après tout changement de PAGE_SCRIPT : `npx tsx scripts/extract-fixture.ts`.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PAGE_SCRIPT } from '../app/server/extract-page.js';
import { siteInventorySchema, VIEWPORTS } from '../app/shared/extract.js';

const html = readFileSync('tests/fixtures/site/index.html', 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
  await page.setContent(html);
  const desktop = await page.evaluate(PAGE_SCRIPT);
  await page.setViewportSize(VIEWPORTS.mobile);
  const mobile = await page.evaluate(PAGE_SCRIPT);
  const inventory = siteInventorySchema.parse({ desktop, mobile });
  for (const v of [inventory.desktop, inventory.mobile]) v.url = 'https://atelier-fixture.example/';
  writeFileSync('tests/fixtures/site/inventory.json', JSON.stringify(inventory, null, 2) + '\n');
  console.log('inventory.json :', inventory.desktop.colors.length, 'couleurs,', inventory.desktop.texts.length, 'textes');
} finally {
  await browser.close();
}
