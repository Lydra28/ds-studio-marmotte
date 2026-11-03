import { z } from 'zod';

// Extraction depuis l'URL d'un site (lot 5) : inventaire des styles calculés
// d'une page, relevé par `PAGE_SCRIPT` (app/server/extract-page.ts) dans le
// Chromium local, puis proposition d'un jeu de tokens (étape 5.2). Ce que la
// page rend n'est pas fiable : schéma strict, bornes partout.
const count = z.number().int().min(0).max(1_000_000_000);
const big = z.number().min(0).max(1e12);
const valued = z.object({ value: z.number().min(0).max(1000), count }).strict();

export const pageInventorySchema = z
  .object({
    url: z.string().max(500),
    title: z.string().max(200),
    viewport: z.object({ width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }).strict(),
    elements: count,
    overlays: count,
    unread: count,
    truncated: z.boolean(),
    colors: z
      .array(
        z
          .object({
            hex: z.string().regex(/^#[0-9A-F]{6}$/),
            text: big,
            area: big,
            card: big,
            border: count,
            interactive: count,
            canvas: z.boolean(),
          })
          .strict(),
      )
      .max(200),
    texts: z
      .array(
        z
          .object({
            size: z.number().int().min(1).max(1000),
            weight: z.number().int().min(1).max(1000),
            family: z.string().max(80),
            lineHeight: z.number().int().min(0).max(1000),
            chars: count,
          })
          .strict(),
      )
      .max(200),
    spacings: z.array(valued).max(100),
    radii: z.array(valued).max(50),
    borderWidths: z.array(valued).max(20),
    shadows: z.array(z.object({ value: z.string().max(200), count }).strict()).max(20),
  })
  .strict();
export type PageInventory = z.infer<typeof pageInventorySchema>;

// Deux lectures de la même page : 1280 px (mode typographique `desktop`) et
// 390 px (`mobile`).
export const siteInventorySchema = z.object({ desktop: pageInventorySchema, mobile: pageInventorySchema }).strict();
export type SiteInventory = z.infer<typeof siteInventorySchema>;

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
