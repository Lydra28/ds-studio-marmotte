import { z } from 'zod';

// Jeu de tokens v2 : trois collections calquées sur Figma (Primitives, Tokens,
// Typography), des modes par collection et des alias `{chemin}` vers une autre
// valeur. Sous-ensemble local inspiré de DTCG, pas un importeur universel.
export const collections = ['primitives', 'tokens', 'typography'] as const;
export type Collection = (typeof collections)[number];
export const tokenTypes = [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'number',
] as const;
export type TokenType = (typeof tokenTypes)[number];
export type TokenValue = string | number;
export type ModeSelection = Partial<Record<Collection, string>>;

const pathPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
export const isTokenKey = (key: string) => key.length <= 80 && pathPattern.test(key);
const aliasPattern = /^\{([a-z0-9/-]+)\}$/;
export const isAlias = (v: TokenValue): v is string =>
  typeof v === 'string' && aliasPattern.test(v);
export const aliasTarget = (v: string) => v.slice(1, -1);
export const defaultModes: Record<Collection, string[]> = {
  primitives: ['default'],
  tokens: ['light'],
  typography: ['desktop', 'mobile'],
};

const valueSchema = z.union([z.string().max(100), z.number().finite()]);
const modeName = z.string().regex(/^[a-z]+$/).max(20);
const tokenSchema = z
  .object({
    $type: z.enum(tokenTypes),
    $collection: z.enum(collections),
    $description: z.string().max(300).optional(),
    $values: z.record(modeName, valueSchema),
  })
  .strict();
export type Token = z.infer<typeof tokenSchema>;
const modesSchema = z
  .object({
    primitives: z.array(modeName).min(1).max(4),
    tokens: z.array(modeName).min(1).max(4),
    typography: z.array(modeName).min(1).max(4),
  })
  .strict();
export const tokenSetSchema = z
  .object({
    modes: modesSchema,
    tokens: z.record(z.string().max(80).regex(pathPattern), tokenSchema),
  })
  .strict()
  .superRefine((set, ctx) => {
    for (const message of validateSet(set))
      ctx.addIssue({ code: 'custom', message });
  });
export type TokenSet = z.infer<typeof tokenSetSchema>;

function checkRaw(type: TokenType, value: TokenValue): string | null {
  switch (type) {
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
        ? null
        : 'couleur #RRGGBB attendue';
    case 'dimension':
      return typeof value === 'number' && value >= 0 && value <= 2000
        ? null
        : 'nombre de 0 à 2000 (px) attendu';
    case 'fontFamily':
      return typeof value === 'string' &&
        value.trim().length > 0 &&
        !/[;{}<>]/.test(value)
        ? null
        : 'nom de police attendu';
    case 'fontWeight':
      return typeof value === 'number' &&
        value >= 100 &&
        value <= 900 &&
        value % 100 === 0
        ? null
        : 'graisse de 100 à 900 attendue';
    case 'number':
      return typeof value === 'number' && value >= 0 && value <= 1000
        ? null
        : 'nombre de 0 à 1000 attendu';
  }
}

export function validateSet(set: {
  modes: Record<Collection, string[]>;
  tokens: Record<string, Token>;
}): string[] {
  const issues: string[] = [];
  const entries = Object.entries(set.tokens);
  if (entries.length > 500) issues.push('500 tokens au maximum.');
  for (const [key, token] of entries) {
    const expected = [...set.modes[token.$collection]].sort().join(',');
    if (Object.keys(token.$values).sort().join(',') !== expected)
      issues.push(`${key} : modes attendus ${expected}.`);
    for (const [mode, value] of Object.entries(token.$values)) {
      if (!isAlias(value)) {
        const problem = checkRaw(token.$type, value);
        if (problem) issues.push(`${key} (${mode}) : ${problem}.`);
        continue;
      }
      if (token.$collection === 'primitives')
        issues.push(`${key} : une primitive porte une valeur brute, pas un alias.`);
      const target = set.tokens[aliasTarget(value)];
      if (!target) issues.push(`${key} (${mode}) : alias ${value} introuvable.`);
      else if (target.$type !== token.$type)
        issues.push(`${key} (${mode}) : alias ${value} d'un autre type.`);
    }
  }
  if (!issues.length)
    for (const key of Object.keys(set.tokens))
      try {
        resolve(set as TokenSet, key);
      } catch (e) {
        issues.push((e as Error).message);
      }
  return issues;
}

export function resolve(
  set: TokenSet,
  key: string,
  selection: ModeSelection = {},
  seen: string[] = [],
): TokenValue {
  if (seen.includes(key))
    throw new Error(`Alias circulaire : ${[...seen, key].join(' → ')}.`);
  const token = set.tokens[key];
  if (!token) throw new Error(`Token inconnu : ${key}.`);
  const modes = set.modes[token.$collection];
  const mode = modes.includes(selection[token.$collection] ?? '')
    ? selection[token.$collection]!
    : modes[0];
  const value = token.$values[mode];
  return isAlias(value)
    ? resolve(set, aliasTarget(value), selection, [...seen, key])
    : value;
}

export const cssName = (key: string) => `--${key.replaceAll('/', '-')}`;
export function cssValue(type: TokenType, value: TokenValue) {
  if (type === 'dimension') return `${value}px`;
  if (type === 'number') return `${value}%`;
  if (type === 'fontFamily') return `${value}, system-ui, sans-serif`;
  return String(value);
}
export function tokenCss(
  set: TokenSet,
  selection: ModeSelection = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(set.tokens).map(([key, token]) => [
      cssName(key),
      cssValue(token.$type, resolve(set, key, selection)),
    ]),
  );
}

// Trois opérations de brouillon : changer une valeur, ajouter un token, en
// retirer un. Toutes passent ensuite par diff puis validation humaine.
const keySchema = z.string().max(80).regex(pathPattern);
export const valueChangeSchema = z
  .object({ key: keySchema, mode: modeName, value: valueSchema })
  .strict();
export type ValueChange = z.infer<typeof valueChangeSchema>;
export const changeSchema = z.union([
  valueChangeSchema,
  z.object({ op: z.literal('add'), key: keySchema, token: tokenSchema }).strict(),
  z.object({ op: z.literal('remove'), key: keySchema }).strict(),
]);
export type Change = z.infer<typeof changeSchema>;
export const proposeSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    changes: z.array(changeSchema).min(1).max(50),
  })
  .strict();

// Tokens dont une valeur est un alias vers `key`.
export const referrers = (set: TokenSet, key: string) =>
  Object.entries(set.tokens)
    .filter(([, t]) => Object.values(t.$values).includes(`{${key}}`))
    .map(([k]) => k);

export function applyChanges(set: TokenSet, changes: Change[]): TokenSet {
  const ids = changes.map((c) => ('op' in c ? `${c.op}:${c.key}` : `${c.key}@${c.mode}`));
  if (new Set(ids).size !== ids.length)
    throw new Error('Un token ne peut apparaître deux fois dans le même mode.');
  const next = structuredClone(set);
  const removed: string[] = [];
  for (const change of changes) {
    if ('op' in change && change.op === 'add') {
      if (next.tokens[change.key])
        throw new Error(`Token déjà existant : ${change.key}.`);
      next.tokens[change.key] = structuredClone(change.token);
      continue;
    }
    const token = next.tokens[change.key];
    if (!token) throw new Error(`Token inconnu : ${change.key}.`);
    if ('op' in change) {
      delete next.tokens[change.key];
      removed.push(change.key);
      continue;
    }
    if (!(change.mode in token.$values))
      throw new Error(`Mode inconnu pour ${change.key} : ${change.mode}.`);
    token.$values[change.mode] = change.value;
  }
  for (const key of removed) {
    const users = referrers(next, key);
    if (users.length)
      throw new Error(`Token utilisé par ${users.join(', ')} : changer ces alias avant de retirer ${key}.`);
  }
  return tokenSetSchema.parse(next);
}

// Un patch remplace un token entier : null = absent (ajout ou retrait par import).
export interface Patch {
  key: string;
  before: Token | null;
  after: Token | null;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export const sameToken = (a: Token | null | undefined, b: Token | null | undefined) =>
  canonical(a ?? null) === canonical(b ?? null);
export function diff(before: TokenSet, after: TokenSet): Patch[] {
  const keys = [
    ...new Set([...Object.keys(before.tokens), ...Object.keys(after.tokens)]),
  ].sort();
  return keys
    .filter((key) => !sameToken(before.tokens[key], after.tokens[key]))
    .map((key) => ({
      key,
      before: before.tokens[key] ?? null,
      after: after.tokens[key] ?? null,
    }));
}
export function applyPatches(
  set: TokenSet,
  patches: Patch[],
  side: 'before' | 'after' = 'after',
): TokenSet {
  const next = structuredClone(set);
  for (const patch of patches) {
    const token = patch[side];
    if (token) next.tokens[patch.key] = structuredClone(token);
    else delete next.tokens[patch.key];
  }
  return tokenSetSchema.parse(next);
}

export const sources = [
  'manual',
  'import',
  'undo',
  'correction',
  'migration',
  'codex',
] as const;
export interface Revision {
  id: string;
  revision: number;
  date: string;
  source: (typeof sources)[number];
  patches: Patch[];
}
export interface State {
  version: 2;
  revision: number;
  set: TokenSet;
  history: Revision[];
}
export interface Proposal {
  id: string;
  revision: number;
  source: Revision['source'];
  patches: Patch[];
}
const patchSchema = z
  .object({
    key: z.string(),
    before: tokenSchema.nullable(),
    after: tokenSchema.nullable(),
  })
  .strict();
export const stateSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    set: tokenSetSchema,
    history: z.array(
      z
        .object({
          id: z.string().uuid(),
          revision: z.number().int().positive(),
          date: z.string().datetime(),
          source: z.enum(sources),
          patches: z.array(patchSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();

// --- Migration v1 → v2 : les 18 tokens plats du starter deviennent des tokens
// rangés dans les collections ; l'historique est converti, pas effacé.
const v1Map: Record<string, { key: string; collection: Collection }> = {
  'color.brand': { key: 'bg/brand', collection: 'tokens' },
  'color.brandHover': { key: 'bg/brand-hover', collection: 'tokens' },
  'color.onBrand': { key: 'text/on-brand', collection: 'tokens' },
  'color.surface': { key: 'bg/surface', collection: 'tokens' },
  'color.canvas': { key: 'bg/canvas', collection: 'tokens' },
  'color.text': { key: 'text/primary', collection: 'tokens' },
  'color.muted': { key: 'text/muted', collection: 'tokens' },
  'color.border': { key: 'border/default', collection: 'tokens' },
  'color.danger': { key: 'text/danger', collection: 'tokens' },
  'color.success': { key: 'text/success', collection: 'tokens' },
  'color.focus': { key: 'border/focus', collection: 'tokens' },
  'font.family': { key: 'font/family/base', collection: 'typography' },
  'font.body': { key: 'font/size/body', collection: 'typography' },
  'font.heading': { key: 'font/size/heading', collection: 'typography' },
  'space.sm': { key: 'space/sm', collection: 'primitives' },
  'space.md': { key: 'space/md', collection: 'primitives' },
  'space.lg': { key: 'space/lg', collection: 'primitives' },
  'radius.control': { key: 'radius/control', collection: 'primitives' },
};
type V1Token = { $type: string; $value: TokenValue };
export const isV1Tokens = (input: unknown): input is Record<string, V1Token> =>
  !!input && typeof input === 'object' && 'color.brand' in input;
function v1Token(key: string, value: TokenValue): [string, Token] {
  const target = v1Map[key];
  if (!target) throw new Error(`Token v1 inconnu : ${key}.`);
  const type: TokenType =
    key === 'font.family' ? 'fontFamily' : key.startsWith('color.') ? 'color' : 'dimension';
  return [
    target.key,
    {
      $type: type,
      $collection: target.collection,
      $values: Object.fromEntries(
        defaultModes[target.collection].map((m) => [m, value]),
      ),
    },
  ];
}
export function migrateV1Tokens(input: Record<string, V1Token>): TokenSet {
  return tokenSetSchema.parse({
    modes: defaultModes,
    tokens: Object.fromEntries(
      Object.entries(input).map(([k, t]) => v1Token(k, t.$value)),
    ),
  });
}
export function migrateV1State(input: {
  revision: number;
  tokens: Record<string, V1Token>;
  history: {
    id: string;
    revision: number;
    date: string;
    source: Revision['source'];
    patches: { key: string; before: TokenValue; after: TokenValue }[];
  }[];
}): State {
  return {
    version: 2,
    revision: input.revision,
    set: migrateV1Tokens(input.tokens),
    history: input.history.map((r) => ({
      ...r,
      patches: r.patches.map((p) => {
        const [key, before] = v1Token(p.key, p.before);
        return { key, before, after: v1Token(p.key, p.after)[1] };
      }),
    })),
  };
}

// --- Couleur : contraste WCAG et outils pour proposer une teinte corrigée.
function channels(hex: string) {
  return hex
    .slice(1)
    .match(/../g)!
    .map((x) => parseInt(x, 16) / 255);
}
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const rgb = channels(hex).map((x) =>
      x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
    );
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2,
    d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
export function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}
