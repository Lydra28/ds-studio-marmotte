import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PAGE_SCRIPT } from '../../app/server/extract-page';
import { pageInventorySchema, VIEWPORTS } from '../../app/shared/extract';

// Lot 5, étape 5.1 : le script de lecture tourne dans un vrai Chromium sur une
// page aux styles connus (aucun réseau : contenu posé par setContent).
const html = readFileSync(new URL('../fixtures/site/index.html', import.meta.url), 'utf8');

test('extraction : styles calculés d’une page connue, en deux largeurs', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS.desktop);
  await page.setContent(html);
  const desktop = pageInventorySchema.parse(await page.evaluate(PAGE_SCRIPT));
  const color = (hex: string) => desktop.colors.find((c) => c.hex === hex);

  expect(desktop.title).toBe('Atelier Fixture');
  expect(desktop.viewport).toEqual({ width: 1280, height: 800 });
  expect(desktop.overlays).toBe(1);
  expect(desktop.unread).toBeGreaterThanOrEqual(1);
  expect(desktop.truncated).toBe(false);

  // Fond de page, texte principal, marque (fond des boutons), cartes, bordure.
  expect(color('#F7F7F5')).toMatchObject({ canvas: true });
  expect(desktop.colors.filter((c) => c.text > 0).sort((a, b) => b.text - a.text)[0].hex).toBe('#1F2937');
  expect(color('#2563EB')!.interactive).toBe(2);
  expect(color('#2563EB')!.text).toBeGreaterThan(0);
  expect(color('#FFFFFF')!.card).toBeGreaterThan(0);
  expect(color('#E5E7EB')!.border).toBe(2);
  expect(color('#6B7280')!.text).toBeGreaterThan(0);
  // Bandeau plein écran et texte caché jamais comptés.
  expect(color('#DC2626')).toBeUndefined();
  expect(color('#111111')).toBeUndefined();
  expect(color('#FF00FF')).toBeUndefined();

  // Typographie : famille de tête de pile, corps dominant, titres.
  const body = [...desktop.texts].sort((a, b) => b.chars - a.chars)[0];
  expect(body).toMatchObject({ size: 16, weight: 400, family: 'Inter', lineHeight: 150 });
  expect(desktop.texts.find((t) => t.size === 40)).toMatchObject({ weight: 700, lineHeight: 120 });
  expect(desktop.texts.find((t) => t.size === 24)).toMatchObject({ weight: 600 });
  expect(desktop.texts.some((t) => t.size === 13)).toBe(true);
  expect(desktop.texts.some((t) => t.size === 30)).toBe(false);

  // Espacements, rayons (999 = pilule), bordures, ombres.
  for (const v of [12, 16, 24, 32]) expect(desktop.spacings.some((s) => s.value === v)).toBe(true);
  expect(desktop.radii.map((r) => r.value).sort((a, b) => a - b)).toEqual([8, 12, 999]);
  expect(desktop.borderWidths).toEqual([{ value: 1, count: 2 }]);
  expect(desktop.shadows).toHaveLength(1);

  // Seconde lecture à 390 px : les titres suivent la media query.
  await page.setViewportSize(VIEWPORTS.mobile);
  const mobile = pageInventorySchema.parse(await page.evaluate(PAGE_SCRIPT));
  expect(mobile.viewport.width).toBe(390);
  expect(mobile.texts.some((t) => t.size === 28 && t.weight === 700)).toBe(true);
  expect(mobile.texts.some((t) => t.size === 40)).toBe(false);
});
