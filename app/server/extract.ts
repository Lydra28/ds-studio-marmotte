import { siteInventorySchema, VIEWPORTS, type SiteInventory } from '../shared/extract.js';
import { PAGE_SCRIPT } from './extract-page.js';
import { extractInDesktop, inDesktop } from './desktop.js';
import { StudioError } from './store.js';
import { publicUrl } from './wall.js';

// Lecture des styles d'un site public (lot 5), entièrement sur le poste :
// Chromium d'Electron dans l'app (fenêtre cachée, session à part), Playwright
// depuis les sources, comme les captures du Mur des DA. Rien n'est écrit :
// l'inventaire validé part vers la proposition de tokens.
export type ReadSite = (url: string) => Promise<unknown>;

export async function readSite(raw: string, read: ReadSite = inDesktop ? (url) => extractInDesktop(url, PAGE_SCRIPT) : extractWithPlaywright): Promise<SiteInventory> {
  const url = publicUrl(raw);
  let data: unknown;
  try {
    data = await read(url);
  } catch (e) {
    throw new StudioError(`Le site n'a pas pu être lu : ${(e as Error).message || 'erreur inconnue'}.`, 502);
  }
  const parsed = siteInventorySchema.safeParse(data);
  if (!parsed.success) throw new StudioError("Le site n'a pas pu être lu : réponse de la page illisible.", 502);
  const { desktop } = parsed.data;
  if (desktop.elements === 0 || (desktop.texts.length === 0 && desktop.colors.length <= 1))
    throw new StudioError('Aucun style lisible sur cette page (page vide, protégée ou masquée par un bandeau).', 422);
  return parsed.data;
}

async function extractWithPlaywright(url: string): Promise<unknown> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORTS.desktop });
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await page.waitForTimeout(1200);
    const desktop = await page.evaluate(PAGE_SCRIPT);
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.waitForTimeout(800);
    const mobile = await page.evaluate(PAGE_SCRIPT);
    return { desktop, mobile };
  } finally {
    await browser.close();
  }
}
