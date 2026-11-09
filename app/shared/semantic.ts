import { hexToOklch } from './palette.js';
import { isAlias, isTokenKey, type Change, type TokenSet } from './model.js';

// Couche sémantique proposée (recette du 2026-11-09, option b de Romain) : un
// dépôt structuré mais « à plat » (`--canvas: #0B0B0C`) garde ses noms de rôle,
// qui deviennent des tokens sémantiques renvoyant à une palette de primitives
// (`color/neutral/950`). Proposition seulement : second brouillon, diff,
// validation ; la PR écrit ensuite `--canvas: var(--color-neutral-950)` et
// ajoute la palette. Couleurs seulement (espacements et typo restent tels quels).

export interface SemanticProposal {
  changes: Change[];
  /** Primitives créées (`color/neutral/950`). */
  primitives: string[];
  /** Tokens passés en sémantique, avec leur primitive. */
  moved: { key: string; to: string }[];
  notes: string[];
}

const HUE_WORDS =
  'neutral|gray|grey|slate|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
/** Nom de palette (`color/blue/500`, `gray-100`, `white`) : reste une primitive. */
const paletteLike = (key: string) => /(^|\/)\d+$/.test(key) || new RegExp(`^(color/)?(${HUE_WORDS})(/|$)`).test(key);

// Familles par teinte OKLCH (degrés), gris sous le seuil de l'extraction.
const NEUTRAL_CHROMA = 0.045;
const FAMILIES: [string, number][] = [
  ['red', 25], ['orange', 55], ['yellow', 95], ['green', 145], ['teal', 190], ['blue', 250], ['violet', 295], ['pink', 345],
];
// Clarté OKLCH visée par cran, du plus clair au plus sombre.
const STEPS: [number, number][] = [
  [50, 0.97], [100, 0.93], [200, 0.88], [300, 0.81], [400, 0.71], [500, 0.62],
  [600, 0.53], [700, 0.45], [800, 0.37], [900, 0.29], [950, 0.2],
];

export function familyOf(hex: string) {
  const [L, C, h] = hexToOklch(hex);
  if (C < NEUTRAL_CHROMA) return { family: 'neutral', L };
  const hue = ((h % 360) + 360) % 360;
  const gap = (a: number) => Math.min(Math.abs(hue - a), 360 - Math.abs(hue - a));
  return { family: [...FAMILIES].sort((a, b) => gap(a[1]) - gap(b[1]))[0][0], L };
}

export function proposeSemanticLayer(set: TokenSet): SemanticProposal {
  const notes: string[] = [];
  const primMode = set.modes.primitives;
  const roleModes = set.modes.tokens;
  // Palette déjà là : même couleur exacte, réutilisée telle quelle.
  const palette = new Map<string, string>();
  const candidates: { key: string; hex: string }[] = [];
  for (const [key, t] of Object.entries(set.tokens).sort(([a], [b]) => a.localeCompare(b))) {
    if (t.$type !== 'color' || t.$collection !== 'primitives') continue;
    const values = primMode.map((m) => t.$values[m]);
    const v = values[0];
    if (typeof v !== 'string' || values.some((x) => x !== v)) continue;
    const hex = v.toUpperCase();
    if (isAlias(v)) continue;
    if (paletteLike(key)) {
      if (!palette.has(hex)) palette.set(hex, key);
    } else candidates.push({ key, hex });
  }
  if (!candidates.length) {
    notes.push('Rien à proposer : les couleurs sont déjà rangées en palette (primitives) et en rôles (tokens sémantiques).');
    return { changes: [], primitives: [], moved: [], notes };
  }

  const taken = new Set(Object.keys(set.tokens));
  const created = new Map<string, string>();
  const adds: Change[] = [];
  const moves: Change[] = [];
  const moved: SemanticProposal['moved'] = [];
  let skipped = 0;
  for (const c of candidates) {
    let to = palette.get(c.hex) ?? created.get(c.hex);
    if (!to) {
      const { family, L } = familyOf(c.hex);
      const free = [...STEPS]
        .sort((a, b) => Math.abs(a[1] - L) - Math.abs(b[1] - L))
        .map(([s]) => `color/${family}/${s}`)
        .find((k) => !taken.has(k) && isTokenKey(k));
      if (!free) {
        skipped++;
        continue;
      }
      to = free;
      taken.add(to);
      created.set(c.hex, to);
      adds.push({ op: 'add', key: to, token: { $type: 'color', $collection: 'primitives', $values: Object.fromEntries(primMode.map((m) => [m, c.hex])) } });
    }
    // Même nom, autre collection : retrait puis ajout (les alias qui le visent restent valides).
    moves.push({ op: 'remove', key: c.key });
    moves.push({ op: 'add', key: c.key, token: { $type: 'color', $collection: 'tokens', $values: Object.fromEntries(roleModes.map((m) => [m, `{${to}}`])) } });
    moved.push({ key: c.key, to });
  }
  notes.push(
    `${moved.length} couleur(s) de rôle passée(s) en tokens sémantiques, ${created.size} primitive(s) de palette créée(s)` +
      (palette.size ? `, ${palette.size} primitive(s) déjà là réutilisée(s)` : '') +
      '. Couleurs seulement : espacements et typographie restent tels quels.',
  );
  if (skipped) notes.push(`${skipped} couleur(s) laissée(s) telles quelles : plus de cran libre dans leur famille.`);
  return { changes: [...adds, ...moves], primitives: [...created.values()], moved, notes };
}
