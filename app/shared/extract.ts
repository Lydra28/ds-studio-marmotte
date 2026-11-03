import { z } from 'zod';
import { applyChanges, changeSchema, isAlias, type Change, type TokenSet } from './model.js';
import { normalize } from './normalize.js';
import { generateRamp, hexToOklch } from './palette.js';

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

// --- Proposition de tokens (étape 5.2) -----------------------------------
// Déterministe et locale : l'inventaire devient des changements sur le jeu du
// projet (gabarit `templates/blank/` à la création), jamais des écritures.
// Chaque changement passe ensuite par le schéma, `normalize`, un essai à blanc
// cumulatif, puis le brouillon, le diff et la validation humaine.

// Seuils réunis ici pour être revus après la recette (lot 5, étape 5.4).
export const EXTRACT_THRESHOLDS = {
  // Chroma OKLCH sous laquelle une couleur est un gris (gris « slate » ≈ 0,04).
  neutralChroma: 0.045,
  // Teinte claire de la marque (fond de pastille) : écartée des gris.
  tintLightness: 0.85,
  tintHue: 20,
  // Part minimale des poids pour une seconde teinte (accent) ou le danger.
  accentShare: 0.05,
  dangerShare: 0.005,
  // Teinte OKLCH du rouge (danger), en degrés (atan2 : -180 à 180).
  dangerHue: [10, 45] as [number, number],
  // Fenêtre autour d'un cran d'espacement ou de rayon.
  window: 0.25,
  // Taille de texte écartée sous cette part des caractères (bruit).
  sizeShare: 0.005,
};

export interface ExtractReport {
  site: { url: string; title: string };
  brand: string | null;
  danger: string | null;
  accent: string | null;
  family: string | null;
  notes: string[];
}
export interface ExtractProposal {
  changes: Change[];
  report: ExtractReport;
  rejected: string[];
}

type Text = PageInventory['texts'][number];
type Colour = PageInventory['colors'][number] & { L: number; C: number; h: number; score: number };

const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const lab = (hex: string) => {
  const [L, C, h] = hexToOklch(hex);
  return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
};
const distance = (a: string, b: string) => {
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const stepsOf = (set: TokenSet, prefix: string) =>
  Object.keys(set.tokens)
    .filter((k) => k.startsWith(prefix + '/') && /^\d+$/.test(k.slice(prefix.length + 1)))
    .map((k) => Number(k.slice(prefix.length + 1)))
    .sort((a, b) => a - b);
const GENERIC_FAMILIES = new Set([
  '', 'serif', 'sans-serif', 'monospace', 'system-ui', 'ui-sans-serif', 'ui-serif',
  '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial',
]);
const WEIGHT_NAMES: Record<number, string> = {
  100: 'thin', 200: 'extralight', 300: 'light', 400: 'regular', 500: 'medium',
  600: 'semibold', 700: 'bold', 800: 'extrabold', 900: 'black',
};
const SCALE = ['caption', 'label', 'body', 'title', 'heading', 'display'] as const;

// Caractères par valeur d'un champ des textes, du plus lu au moins lu.
function charsBy(texts: Text[], field: (t: Text) => string | number) {
  const m = new Map<string | number, number>();
  for (const t of texts) m.set(field(t), (m.get(field(t)) ?? 0) + t.chars);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function proposeFromInventory(inventory: SiteInventory, set: TokenSet): ExtractProposal {
  const T = EXTRACT_THRESHOLDS;
  const { desktop, mobile } = inventory;
  const notes: string[] = [];
  const wanted: Change[] = [];
  const primitive = set.modes.primitives[0] ?? 'default';
  const semantic = set.modes.tokens[0] ?? 'light';
  const typo = set.modes.typography;
  const typoDesktop = typo[0] ?? 'desktop';
  const typoMobile = typo[1] ?? typoDesktop;
  const raw = (key: string, mode: string) => set.tokens[key]?.$values[mode];
  const put = (key: string, mode: string, value: string | number) => {
    const current = raw(key, mode);
    if (current !== undefined && current !== value) wanted.push({ key, mode, value });
  };

  // --- Couleurs : poids relatifs (caractères, surface, bordures, usages).
  const sum = (f: (c: PageInventory['colors'][number]) => number) => desktop.colors.reduce((n, c) => n + f(c), 0) || 1;
  const totals = {
    text: sum((c) => c.text),
    area: sum((c) => c.area),
    border: sum((c) => c.border),
    interactive: sum((c) => c.interactive),
  };
  const colours: Colour[] = desktop.colors.map((c) => {
    const [L, C, h] = hexToOklch(c.hex);
    const score =
      c.text / totals.text + (0.5 * c.area) / totals.area + (0.5 * c.border) / totals.border + (2 * c.interactive) / totals.interactive;
    return { ...c, L, C, h, score };
  });
  const totalScore = colours.reduce((n, c) => n + c.score, 0) || 1;
  const chromatic = colours.filter((c) => c.C >= T.neutralChroma).sort((a, b) => b.score - a.score);
  const isRed = (c: Colour) => c.h >= T.dangerHue[0] && c.h <= T.dangerHue[1];
  // Marque : teinte la plus pesante ; un rouge ne l'est que s'il sert aux liens ou boutons.
  const brand = chromatic.find((c) => !isRed(c) || c.interactive > 0) ?? null;
  const danger = chromatic.find((c) => c !== brand && isRed(c) && c.score / totalScore >= T.dangerShare) ?? null;
  const accent =
    chromatic.find(
      (c) => c !== brand && c !== danger && (!brand || hueGap(c.h, brand.h) > T.tintHue) && c.score / totalScore >= T.accentShare,
    ) ?? null;
  const tint = (c: Colour) => !!brand && c.L >= T.tintLightness && c.C >= 0.02 && hueGap(c.h, brand.h) <= T.tintHue;
  const neutrals = colours.filter((c) => c.C < T.neutralChroma && !tint(c));

  const ramp = (prefix: string, hex: string, label: string, add: boolean) => {
    let steps = stepsOf(set, prefix);
    if (steps.length === 0) {
      if (!add) return;
      steps = stepsOf(set, 'color/brand');
      if (steps.length === 0) steps = [100, 500, 600, 700];
      const anchor = steps.includes(600) ? 600 : steps[Math.floor(steps.length / 2)];
      for (const s of generateRamp(hex, anchor, steps))
        wanted.push({
          op: 'add',
          key: `${prefix}/${s.step}`,
          token: { $type: 'color', $collection: 'primitives', $values: { [primitive]: s.hex } },
        });
      notes.push(`${label} : ${hex}, gamme ${prefix}/* ajoutée (sans rôle sémantique).`);
      return;
    }
    const anchor = steps.includes(600) ? 600 : steps[Math.floor(steps.length / 2)];
    for (const s of generateRamp(hex, anchor, steps)) put(`${prefix}/${s.step}`, primitive, s.hex);
    notes.push(`${label} : ${hex} au cran ${anchor}, gamme régénérée en OKLCH.`);
  };
  if (brand) ramp('color/brand', brand.hex, 'Marque', false);
  else notes.push('Aucune couleur de marque nette : gamme de marque du gabarit gardée.');
  if (danger) ramp('color/danger', danger.hex, 'Danger', false);
  if (accent) ramp('color/accent', accent.hex, 'Seconde teinte', true);

  // Gris : chaque gris du site va au cran le plus proche en clarté ; à cran
  // disputé, le plus utilisé gagne ; les autres crans gardent le gabarit.
  const neutralSteps = stepsOf(set, 'color/neutral');
  const byStep = new Map<number, Colour>();
  for (const c of neutrals) {
    let best: number | null = null;
    let gap = Infinity;
    for (const s of neutralSteps) {
      const v = raw(`color/neutral/${s}`, primitive);
      if (typeof v !== 'string' || isAlias(v)) continue;
      const d = Math.abs(hexToOklch(v)[0] - c.L);
      if (d < gap) [best, gap] = [s, d];
    }
    const taken = best === null ? undefined : byStep.get(best);
    if (best !== null && (!taken || taken.score < c.score)) byStep.set(best, c);
  }
  for (const [s, c] of byStep) put(`color/neutral/${s}`, primitive, c.hex);
  const grey = [...byStep].filter(([s, c]) => raw(`color/neutral/${s}`, primitive) !== c.hex).length;
  if (grey) notes.push(`Gris : ${grey} cran(s) repris du site sur ${neutralSteps.length}.`);

  // Sémantiques : alias vers la primitive la plus proche dans la gamme obtenue,
  // jamais de valeur brute.
  let preview = set;
  try {
    preview = applyChanges(set, wanted);
  } catch {
    // Rejets comptés au passage final.
  }
  const palette = Object.entries(preview.tokens).filter(
    ([k, t]) =>
      t.$type === 'color' &&
      t.$collection === 'primitives' &&
      /^color\/(neutral|brand)\//.test(k) &&
      typeof t.$values[primitive] === 'string' &&
      !isAlias(t.$values[primitive] as string),
  );
  const nearest = (hex: string) => {
    let best: string | undefined;
    let gap = Infinity;
    for (const [k, t] of palette) {
      const d = distance(hex, t.$values[primitive] as string);
      if (d < gap) [best, gap] = [k, d];
    }
    return best;
  };
  const alias = (key: string, hex: string | undefined) => {
    const target = hex ? nearest(hex) : undefined;
    const current = raw(key, semantic);
    if (target && typeof current === 'string' && isAlias(current)) put(key, semantic, `{${target}}`);
  };
  const top = (list: Colour[], f: (c: Colour) => number) => [...list].filter((c) => f(c) > 0).sort((a, b) => f(b) - f(a))[0];
  const canvas = colours.find((c) => c.canvas);
  const textMain = top(neutrals, (c) => c.text) ?? top(colours, (c) => c.text);
  const surface = top(
    colours.filter((c) => c.C < T.neutralChroma),
    (c) => c.card,
  );
  const muted = textMain ? top(neutrals.filter((c) => c.L > textMain.L + 0.08), (c) => c.text) : undefined;
  const border = top(neutrals, (c) => c.border);
  alias('bg/canvas', canvas?.hex);
  alias('bg/surface', surface?.hex);
  alias('text/primary', textMain?.hex);
  alias('text/muted', muted?.hex);
  alias('border/default', border?.hex);

  // --- Typographie.
  const family = charsBy(desktop.texts, (t) => t.family).find(([f]) => !GENERIC_FAMILIES.has(String(f).toLowerCase()))?.[0] as
    | string
    | undefined;
  if (family && /^[\w\s.-]{1,60}$/.test(family)) {
    put('font/family/sans', primitive, family);
    notes.push(`Police : ${family} (la plus lue). Son chargement reste à prévoir côté site.`);
  } else notes.push('Police du site non lue (famille générique) : police du gabarit gardée.');

  const sizesFor = (page: PageInventory) => {
    const total = page.texts.reduce((n, t) => n + t.chars, 0) || 1;
    const sizes = charsBy(page.texts, (t) => t.size).filter(([, n]) => n / total >= T.sizeShare) as [number, number][];
    if (sizes.length === 0) return null;
    const body = sizes[0][0];
    const out: Partial<Record<(typeof SCALE)[number], number>> = { body };
    // Plus petites : label puis caption ; plus grandes : display, heading, title.
    [out.label, out.caption] = sizes.filter(([s]) => s < body).slice(0, 2).map(([s]) => s).sort((a, b) => b - a);
    [out.display, out.heading, out.title] = sizes.filter(([s]) => s > body).slice(0, 3).map(([s]) => s).sort((a, b) => b - a);
    return { out, body };
  };
  const writeSizes = (page: PageInventory, mode: string) => {
    const found = sizesFor(page);
    if (!found) return undefined;
    const values = SCALE.map((step) => found.out[step] ?? raw(`font/size/${step}`, mode));
    // Crans sans valeur du site : recalés entre leurs voisins pour garder l'ordre.
    SCALE.forEach((step, i) => {
      const v0 = values[i];
      if (found.out[step] !== undefined || typeof v0 !== 'number') return;
      const lo = values.slice(0, i).filter((v): v is number => typeof v === 'number').at(-1);
      const hi = values.slice(i + 1).find((v): v is number => typeof v === 'number');
      let v = v0;
      if (lo !== undefined && v <= lo) v = hi !== undefined && hi - lo >= 2 ? Math.round((lo + hi) / 2) : lo + 2;
      if (hi !== undefined && v >= hi) v = lo !== undefined && hi - lo >= 2 ? Math.round((lo + hi) / 2) : Math.max(8, hi - 2);
      values[i] = v;
    });
    SCALE.forEach((step, i) => {
      const v = values[i];
      if (typeof v === 'number') put(`font/size/${step}`, mode, v);
    });
    return found.body;
  };
  const bodySize = writeSizes(desktop, typoDesktop);
  if (typoMobile !== typoDesktop) writeSizes(mobile, typoMobile);

  if (bodySize !== undefined) {
    const dominant = (keep: (t: Text) => boolean, field: (t: Text) => number) =>
      charsBy(desktop.texts.filter(keep), field).find(([v]) => Number(v) > 0)?.[0] as number | undefined;
    const weight = (key: string, w: number | undefined) => {
      if (!w || !set.tokens[key]) return;
      const value = Math.min(900, Math.max(100, Math.round(w / 100) * 100));
      const existing = Object.entries(set.tokens).find(
        ([k, t]) => k.startsWith('font/weight/') && t.$collection === 'primitives' && t.$values[primitive] === value,
      )?.[0];
      const target = existing ?? `font/weight/${WEIGHT_NAMES[value]}`;
      if (!existing && !wanted.some((c) => 'op' in c && c.op === 'add' && c.key === target))
        wanted.push({ op: 'add', key: target, token: { $type: 'fontWeight', $collection: 'primitives', $values: { [primitive]: value } } });
      for (const mode of typo) put(key, mode, `{${target}}`);
    };
    weight('font/weight/body', dominant((t) => t.size === bodySize, (t) => t.weight));
    weight('font/weight/heading', dominant((t) => t.size > bodySize, (t) => t.weight));
    const lineHeight = (key: string, v: number | undefined) => {
      if (v) for (const mode of typo) put(key, mode, Math.round(v / 5) * 5);
    };
    lineHeight('font/line-height/body', dominant((t) => t.size === bodySize, (t) => t.lineHeight));
    lineHeight('font/line-height/heading', dominant((t) => t.size > bodySize, (t) => t.lineHeight));
  }

  // --- Échelles : chaque valeur du site va au cran le plus proche, dans la
  // fenêtre de ±25 % ; par cran, la valeur la plus fréquente gagne. Jamais de
  // réaffectation par rang (space/md ne devient pas 4 px).
  const fit = (prefix: string, found: { value: number; count: number }[], round: (v: number) => number, keep: (v: number) => boolean) => {
    const crans = Object.entries(set.tokens)
      .filter(([k, t]) => k.startsWith(prefix + '/') && t.$collection === 'primitives' && t.$type === 'dimension')
      .map(([k, t]) => [k, t.$values[primitive]] as const)
      .filter((c): c is readonly [string, number] => typeof c[1] === 'number' && keep(c[1]));
    const best = new Map<string, { value: number; count: number }>();
    for (const f of found) {
      const value = round(f.value);
      if (!keep(value)) continue;
      let cran: readonly [string, number] | undefined;
      for (const c of crans) if (!cran || Math.abs(c[1] - value) < Math.abs(cran[1] - value)) cran = c;
      if (!cran || Math.abs(cran[1] - value) > cran[1] * T.window) continue;
      const prev = best.get(cran[0]);
      if (!prev || prev.count < f.count) best.set(cran[0], { value, count: f.count });
    }
    for (const [k, b] of best) put(k, primitive, b.value);
    return [...best].filter(([k, b]) => raw(k, primitive) !== b.value).length;
  };
  const spaced = fit('space', desktop.spacings, (v) => Math.max(4, Math.round(v / 4) * 4), (v) => v >= 4);
  const rounded = fit('radius', desktop.radii, (v) => Math.round(v), (v) => v > 0 && v < 999);
  fit('border-width', desktop.borderWidths, (v) => Math.round(v), (v) => v > 0);
  notes.push(`Espacements : ${spaced} cran(s) ajusté(s) ; rayons : ${rounded}.`);
  if (desktop.shadows.length)
    notes.push(`Ombres : ${desktop.shadows.length} relevée(s), non tokenisées (le modèle n'a pas de type ombre).`);
  if (desktop.overlays) notes.push(`${desktop.overlays} calque(s) plein écran écarté(s) (bandeau, modale).`);
  if (desktop.unread) notes.push(`${desktop.unread} couleur(s) hors rgb() non lue(s).`);
  if (desktop.truncated) notes.push('Page très longue : 3 000 éléments lus au plus.');

  // --- Passage final : schéma, normalisation, essai à blanc cumulatif.
  const changes: Change[] = [];
  const rejected: string[] = [];
  let current = set;
  for (const candidate of wanted) {
    const parsed = changeSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected.push(`format refusé : ${JSON.stringify(candidate).slice(0, 80)}`);
      continue;
    }
    const expanded = normalize(parsed.data, current);
    try {
      current = applyChanges(current, expanded);
      changes.push(...expanded);
    } catch (e) {
      rejected.push(`${'key' in candidate ? candidate.key : 'changement'} : ${(e as Error).message.slice(0, 120)}`);
    }
  }
  return {
    changes,
    rejected,
    report: {
      site: { url: desktop.url, title: desktop.title },
      brand: brand?.hex ?? null,
      danger: danger?.hex ?? null,
      accent: accent?.hex ?? null,
      family: family ?? null,
      notes,
    },
  };
}
