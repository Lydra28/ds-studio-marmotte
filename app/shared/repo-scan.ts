import { oklchToHex } from './palette.js';

// Lecture d'un dépôt (plan GitHub, G2) : détecteurs purs, texte → occurrences
// avec leur position exacte (fichier, ligne, colonne, longueur) pour que la PR
// (G5) puisse réécrire le code. Lecture statique seulement : aucun fichier du
// dépôt n'est exécuté (config Tailwind comprise, objet littéral lu tel quel).
// Lecture maison bornée, sans AST complet (décision 1 du plan) : on repère des
// valeurs dans des contextes de style, on ne comprend pas le programme.

export type Detector =
  | 'css-var' // --x: … hors @theme
  | 'theme-v4' // --x: … dans @theme (Tailwind v4)
  | 'scss-var' // $x: …
  | 'tailwind-v3' // theme / extend de tailwind.config.*
  | 'js-theme' // objet de thème JS (styled-components, MUI, Chakra…)
  | 'tokens-json' // JSON DTCG ou Style Dictionary
  | 'hardcoded' // valeur en dur dans un contexte de style
  | 'tailwind-class' // classe Tailwind par défaut ou du thème
  | 'var-use'; // var(--x) utilisée hors déclaration

export type Via = 'css' | 'style-attr' | 'jsx-style' | 'css-in-js' | 'class' | 'config' | 'json';
export type ValueKind = 'color' | 'length' | 'font' | 'shadow' | 'alias' | 'other';

export interface Occurrence {
  file: string;
  /** 1-based, comme un éditeur. */
  line: number;
  col: number;
  /** Position dans le texte du fichier (G5 : réécriture). */
  offset: number;
  length: number;
  detector: Detector;
  via: Via;
  kind: ValueKind;
  /** Nom du token déclaré, propriété CSS d'une valeur en dur, ou classe. */
  name: string | null;
  value: string;
  /** `#RRGGBB(AA)`, `16px`, `1.5em`, `var(--x)`, `color:blue-500`… */
  normalized: string;
  /** Ligne de code autour (reste sur le poste : jamais dans la sonde). */
  context: string;
  /** Déclaration CSS/SCSS : blocs englobants (`@media (…) > :root`), `''` au premier niveau. */
  scope?: string;
}

export const DECLARATIONS: Detector[] = ['css-var', 'theme-v4', 'scss-var', 'tailwind-v3', 'js-theme', 'tokens-json'];
export const MAX_OCCURRENCES = 100_000;

// --- Fichiers lus ---------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', 'out', '.nuxt', '.output', '.svelte-kit', '.astro', '.vercel',
  '.netlify', '.turbo', '.cache', '.parcel-cache', 'coverage', 'vendor', 'bower_components', '.git', '.github', 'storybook-static',
]);
const STYLE_EXT = /\.(css|scss|sass|less|pcss|postcss)$/i;
const MARKUP_EXT = /\.(vue|svelte|astro|html?)$/i;
const SCRIPT_EXT = /\.(jsx|tsx|js|ts|mjs|cjs|mts|cts)$/i;
const TAILWIND_CONFIG = /(^|\/)tailwind\.config\.(js|cjs|mjs|ts|cts|mts)$/i;
const JS_THEME_FILE = /(^|\/)(theme|tokens?|colors|palette|design-tokens|variables)\.(js|ts|mjs|cjs|jsx|tsx)$/i;
const TOKENS_JSON = /(token|theme|design|style|color|palette)[^/]*\.json$|(^|\/)tokens?\/.*\.json$/i;

/** Fichier à lire dans l'archive (chemin relatif à la racine du dépôt). */
export function isScannable(path: string): boolean {
  const parts = path.split('/');
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) return false;
  if (/^\.env/i.test(base) || /\.min\.|\.map$|\.d\.[mc]?ts$|\.(test|spec|stories)\.[jt]sx?$/i.test(base)) return false;
  if (base === 'package.json') return true;
  if (/\.json$/i.test(base)) return !/(^|\/)(package-lock|tsconfig|jsconfig|composer|manifest|vercel|netlify)[^/]*\.json$/i.test(path) && TOKENS_JSON.test(path);
  return STYLE_EXT.test(base) || MARKUP_EXT.test(base) || SCRIPT_EXT.test(base);
}

// --- Valeurs --------------------------------------------------------------

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
const withAlpha = (r: number, g: number, b: number, a = 1) => `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const num = (raw: string, scale: number) => (raw.endsWith('%') ? (parseFloat(raw) / 100) * scale : parseFloat(raw));

/** Couleur CSS → `#RRGGBB` (ou `#RRGGBBAA`), `null` si ce n'en est pas une. */
export function parseColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v === 'white') return '#FFFFFF';
  if (v === 'black') return '#000000';
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const out = '#' + h.toUpperCase();
    return out.length === 9 && out.endsWith('FF') ? out.slice(0, 7) : out;
  }
  m = /^(rgba?|hsla?|oklch)\(\s*([^()]*)\)$/.exec(v);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => !/^-?(\d+\.?\d*|\.\d+)(%|deg)?$/.test(p))) return null;
  const alpha = parts[3] !== undefined ? Math.max(0, Math.min(1, num(parts[3], 1))) : 1;
  if (m[1].startsWith('rgb')) return withAlpha(num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), alpha);
  if (m[1].startsWith('hsl')) {
    const [r, g, b] = hslToRgb(((parseFloat(parts[0]) % 360) + 360) % 360, num(parts[1], 1) / (parts[1].endsWith('%') ? 1 : 100), num(parts[2], 1) / (parts[2].endsWith('%') ? 1 : 100));
    return withAlpha(r, g, b, alpha);
  }
  const L = num(parts[0], 1);
  const hex = oklchToHex(L, num(parts[1], 0.4), parseFloat(parts[2]));
  return alpha < 1 ? hex.toUpperCase() + hex2(alpha * 255) : hex.toUpperCase();
}

/** Longueur CSS seule → `16px` (rem à 16 px), `1.5em` ; `null` sinon. */
export function parseLength(raw: string): string | null {
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/i.exec(raw.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return unit === 'em' ? `${round(n)}em` : `${round(unit === 'rem' ? n * 16 : n)}px`;
}

const firstFont = (raw: string) => raw.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();

function kindOf(name: string, value: string): { kind: ValueKind; normalized: string } {
  const v = value.trim();
  if (/^var\(\s*--[\w-]+/.test(v) || /^\{[\w.-]+\}$/.test(v) || /^\$[\w-]+$/.test(v)) return { kind: 'alias', normalized: v.replace(/\s+/g, '') };
  const color = parseColor(v);
  if (color) return { kind: 'color', normalized: color };
  const length = parseLength(v);
  if (length) return { kind: 'length', normalized: length };
  if (/shadow/i.test(name)) return { kind: 'shadow', normalized: v.replace(/\s+/g, ' ').toLowerCase() };
  if (/font(?!-?(size|weight))|family/i.test(name) && /[a-z]/i.test(v)) return { kind: 'font', normalized: firstFont(v) };
  return { kind: 'other', normalized: v.replace(/\s+/g, ' ').toLowerCase() };
}

// --- Positions ------------------------------------------------------------

interface Ctx {
  file: string;
  text: string;
  lines: number[];
  out: Occurrence[];
}

function lineStarts(text: string) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function emit(ctx: Ctx, o: Omit<Occurrence, 'file' | 'line' | 'col' | 'context' | 'scope'> & { scope?: string }) {
  if (ctx.out.length >= MAX_OCCURRENCES) return;
  let lo = 0;
  let hi = ctx.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.lines[mid] <= o.offset) lo = mid;
    else hi = mid - 1;
  }
  const start = ctx.lines[lo];
  const end = ctx.text.indexOf('\n', start);
  const context = ctx.text.slice(start, end === -1 ? undefined : end).trim().slice(0, 160);
  ctx.out.push({ file: ctx.file, line: lo + 1, col: o.offset - start + 1, context, ...o });
}

// Remplace une portion par des espaces (mêmes positions, sauts de ligne gardés).
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

// --- CSS ------------------------------------------------------------------

const LENGTH_PROP = /^(margin|padding)(-[a-z-]+)?$|^(gap|row-gap|column-gap|font-size)$|radius$/;
const HEX = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|oklch)\(\s*[^()]*\)/gi;
const NAMED = /(?<![\w$#.-])(?:white|black)(?![\w-])/gi;
const LENGTH = /(?<![\w$#.-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)(?![\w-])/gi;
const VAR_USE = /var\(\s*(--[A-Za-z0-9_-]+)/g;

// Couleurs en dur d'une valeur (`clean` : url() déjà masquées).
function scanColors(ctx: Ctx, prop: string, clean: string, at: number, via: Via) {
  const colors: [number, string][] = [];
  for (const re of [HEX, COLOR_FN, NAMED]) for (const m of clean.matchAll(re)) colors.push([m.index!, m[0]]);
  for (const [i, raw] of colors) {
    const normalized = parseColor(raw);
    if (normalized) emit(ctx, { offset: at + i, length: raw.length, detector: 'hardcoded', via, kind: 'color', name: prop, value: raw, normalized });
  }
}

// Valeurs en dur d'une valeur de propriété (CSS, attribut style, objet JSX).
function scanValue(ctx: Ctx, prop: string, value: string, at: number, via: Via) {
  const clean = value.replace(/url\([^)]*\)/gi, blank);
  for (const m of clean.matchAll(VAR_USE)) emit(ctx, { offset: at + m.index!, length: m[0].length + 1, detector: 'var-use', via, kind: 'alias', name: prop, value: m[1], normalized: `var(${m[1]})` });
  scanColors(ctx, prop, clean, at, via);
  if (LENGTH_PROP.test(prop))
    for (const m of clean.matchAll(LENGTH)) {
      const normalized = parseLength(m[0]);
      if (normalized && parseFloat(normalized) !== 0) emit(ctx, { offset: at + m.index!, length: m[0].length, detector: 'hardcoded', via, kind: 'length', name: prop, value: m[0], normalized });
    }
  if (prop === 'font-family' && !/var\(|inherit|initial|unset/.test(clean)) {
    const lead = value.length - value.trimStart().length;
    emit(ctx, { offset: at + lead, length: value.trim().length, detector: 'hardcoded', via, kind: 'font', name: prop, value: value.trim(), normalized: firstFont(value) });
  }
}

const DECL = /(?:^|[;{}\s])(--[A-Za-z0-9_-]+|\$[A-Za-z0-9_-]+|[a-zA-Z-]+)\s*:\s*([^;{}]*?)\s*(?=;|\}|$)/dg;

function braceEnd(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** Déclarations d'une portion CSS (`region` a la longueur de l'original, décalée de `base`). */
function scanCss(ctx: Ctx, region: string, base: number, via: Via, scss: boolean) {
  let src = region.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (scss) src = src.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p: string) => p + blank(m.slice(p.length)));
  const themes: [number, number][] = [];
  for (const m of src.matchAll(/@theme\b[^{;]*\{/g)) themes.push([m.index!, braceEnd(src, m.index! + m[0].length - 1)]);
  // Blocs ouverts au fil du texte (balayage unique, déclarations dans l'ordre).
  const stack: string[] = [];
  let cursor = 0;
  let boundary = -1;
  const advance = (to: number) => {
    for (; cursor < to; cursor++) {
      const c = src[cursor];
      if (c === '{') {
        stack.push(src.slice(boundary + 1, cursor).replace(/\s+/g, ' ').trim().slice(0, 120));
        boundary = cursor;
      } else if (c === '}') {
        stack.pop();
        boundary = cursor;
      } else if (c === ';') boundary = cursor;
    }
  };
  for (const m of src.matchAll(DECL)) {
    const prop = m[1];
    const raw = m[2];
    if (!raw) continue;
    const at = base + m.indices![2]![0];
    if (prop.startsWith('--') || (scss && prop.startsWith('$'))) {
      const value = raw.replace(/\s*!(important|default|global)\s*$/i, '');
      const inTheme = themes.some(([a, b]) => m.index! > a && m.index! < b);
      advance(m.indices![1]![0]);
      const kind = kindOf(prop, value);
      emit(ctx, {
        scope: stack.join(' > '),
        offset: at,
        length: value.length,
        detector: prop.startsWith('$') ? 'scss-var' : inTheme ? 'theme-v4' : 'css-var',
        via,
        name: prop,
        value,
        ...kind,
      });
      // Variable composée (dégradé, ombre) : pas de token à elle, mais ses
      // couleurs en dur suivent les tokens comme toute valeur en dur.
      if (kind.kind === 'other' || kind.kind === 'shadow') scanColors(ctx, prop, value.replace(/url\([^)]*\)/gi, blank), at, via);
    } else if (!prop.startsWith('$')) scanValue(ctx, prop.toLowerCase(), raw, at, via);
  }
}

// --- Littéraux JS (config Tailwind, objets de style, JSON) ----------------

type Lit =
  | { t: 'obj'; at: number; end: number; entries: { key: string; value: Lit }[] }
  | { t: 'arr'; at: number; end: number; items: Lit[] }
  | { t: 'str'; at: number; end: number; value: string }
  | { t: 'num'; at: number; end: number; value: number }
  | { t: 'other'; at: number; end: number };

class LitParser {
  private nodes = 0;
  constructor(private readonly s: string) {}

  ws(i: number) {
    const s = this.s;
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith('//', i)) i = s.indexOf('\n', i) === -1 ? s.length : s.indexOf('\n', i);
      else if (s.startsWith('/*', i)) i = s.indexOf('*/', i) === -1 ? s.length : s.indexOf('*/', i) + 2;
      else return i;
    }
  }

  // Chaîne à partir du guillemet : fin (après le guillemet), contenu brut, interpolation.
  str(i: number) {
    const s = this.s;
    const q = s[i];
    let j = i + 1;
    let interp = false;
    let value = '';
    while (j < s.length && s[j] !== q) {
      if (s[j] === '\\') {
        value += s[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (q === '`' && s[j] === '$' && s[j + 1] === '{') {
        interp = true;
        j = this.skip(j + 2, '}') + 1;
        continue;
      }
      if (q !== '`' && s[j] === '\n') break;
      value += s[j++];
    }
    return { end: j + 1, value, interp };
  }

  // Avance jusqu'au séparateur de profondeur 0 (`,` ou fermant), sans le consommer.
  skip(i: number, close?: string) {
    const s = this.s;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'" || c === '`') i = this.str(i).end;
      else if (s.startsWith('//', i) || s.startsWith('/*', i)) i = this.ws(i);
      else if (c === '(' || c === '[' || c === '{') (depth++, i++);
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) return i;
        depth--;
        i++;
      } else if (c === ',' && depth === 0 && !close) return i;
      else i++;
    }
    return i;
  }

  value(i: number, depth = 0): Lit {
    const s = this.s;
    i = this.ws(i);
    if (++this.nodes > 50_000 || depth > 25) return { t: 'other', at: i, end: this.skip(i) };
    const c = s[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      const entries: { key: string; value: Lit }[] = [];
      const items: Lit[] = [];
      let j = this.ws(i + 1);
      while (j < s.length && s[j] !== close) {
        if (c === '[') items.push(this.value(j, depth + 1));
        else {
          let key: string | null = null;
          if (s[j] === '"' || s[j] === "'") {
            const k = this.str(j);
            key = k.value;
            j = k.end;
          } else {
            const m = /^[A-Za-z0-9_$-]+/.exec(s.slice(j, j + 200));
            if (m) {
              key = m[0];
              j += m[0].length;
            }
          }
          j = this.ws(j);
          if (key !== null && s[j] === ':') entries.push({ key, value: this.value(j + 1, depth + 1) });
        }
        const last = c === '[' ? items[items.length - 1] : entries[entries.length - 1]?.value;
        // Fin d'une chaîne : `end` pointe le guillemet fermant (contenu exclu).
        const after = last ? last.end + (last.t === 'str' ? 1 : 0) : j;
        j = this.ws(after > j ? after : j);
        if (s[j] !== ',' && s[j] !== close) j = this.skip(j);
        if (s[j] === ',') j = this.ws(j + 1);
        else if (s[j] !== close) break;
      }
      return c === '{' ? { t: 'obj', at: i, end: j + 1, entries } : { t: 'arr', at: i, end: j + 1, items };
    }
    if (c === '"' || c === "'" || c === '`') {
      const r = this.str(i);
      const after = this.ws(r.end);
      if (!r.interp && (after >= s.length || /[,}\]):]/.test(s[after]))) return { t: 'str', at: i + 1, end: r.end - 1, value: r.value };
      return { t: 'other', at: i, end: this.skip(i) };
    }
    const m = /^-?(\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 40));
    if (m) {
      const after = this.ws(i + m[0].length);
      if (after >= s.length || /[,}\]]/.test(s[after])) return { t: 'num', at: i, end: i + m[0].length, value: parseFloat(m[0]) };
    }
    return { t: 'other', at: i, end: this.skip(i) };
  }
}

// Feuilles chaîne / nombre d'un objet, avec leur chemin.
function* leaves(node: Lit, path: string[] = []): Generator<{ path: string[]; node: Lit & { t: 'str' | 'num' } }> {
  if (node.t === 'str' || node.t === 'num') yield { path, node };
  else if (node.t === 'obj') for (const e of node.entries) yield* leaves(e.value, [...path, e.key]);
  // Index de tableau marqué `#i` (à ne pas confondre avec une clé `500`).
  else if (node.t === 'arr') for (const [i, item] of node.items.entries()) yield* leaves(item, [...path, `#${i}`]);
}

const camelToKebab = (k: string) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// Tailwind v3 : `theme` et `theme.extend` lus statiquement.
const TW_KINDS: Record<string, ValueKind> = { colors: 'color', spacing: 'length', borderRadius: 'length', fontSize: 'length', fontFamily: 'font', boxShadow: 'shadow' };
const TW_COLOR_KEYS = /^(colors|textColor|backgroundColor|borderColor|fill|stroke|ringColor|accentColor)$/;

function scanTailwindConfig(ctx: Ctx) {
  const m = /\btheme\s*:\s*\{/.exec(ctx.text);
  if (!m) return;
  const theme = new LitParser(ctx.text).value(m.index + m[0].length - 1);
  if (theme.t !== 'obj') return;
  const groups = theme.entries.flatMap((e) => (e.key === 'extend' && e.value.t === 'obj' ? e.value.entries : [e]));
  for (const g of groups) {
    const kind = TW_COLOR_KEYS.test(g.key) ? 'color' : TW_KINDS[g.key];
    if (!kind) continue;
    for (const { path, node } of leaves(g.value)) {
      // fontSize: ['1rem', { lineHeight }] et fontFamily: ['Inter', 'sans-serif'] : premier élément seulement.
      if (path.some((p) => p.startsWith('#') && p !== '#0')) continue;
      if (path.some((p) => /^(lineHeight|letterSpacing|fontWeight)$/.test(p))) continue;
      const name = [g.key, ...path.filter((p) => p !== 'DEFAULT' && !p.startsWith('#'))].join('.');
      const value = node.t === 'str' ? node.value : String(node.value);
      const parsed = kindOf(name, value);
      emit(ctx, {
        offset: node.at,
        length: node.end - node.at,
        detector: 'tailwind-v3',
        via: 'config',
        name,
        value,
        kind: parsed.kind === 'alias' ? 'alias' : kind,
        normalized: kind === 'font' ? firstFont(value) : parsed.normalized,
      });
    }
  }
}

// Objet de thème JS (styled-components, MUI, Chakra) : couleurs, polices et
// longueurs en chaîne seulement, dans un fichier de thème ou createTheme().
function scanJsTheme(ctx: Ctx) {
  const parser = new LitParser(ctx.text);
  const starts = [...ctx.text.matchAll(/(?:export\s+default\s+|=\s*|(?:createTheme|extendTheme|createStitches)\(\s*)\{/g)].map((m) => m.index! + m[0].length - 1);
  let covered = -1;
  for (const start of starts) {
    if (start < covered) continue;
    const obj = parser.value(start);
    if (obj.t !== 'obj') continue;
    covered = obj.end;
    for (const { path, node } of leaves(obj)) {
      if (node.t !== 'str') continue;
      const name = path.filter((p) => !p.startsWith('#')).join('.');
      const parsed = kindOf(name, node.value);
      const keep =
        parsed.kind === 'color' ||
        (parsed.kind === 'font' && /font/i.test(name)) ||
        (parsed.kind === 'length' && /spac|radi|size|gap/i.test(name)) ||
        (parsed.kind === 'shadow' && /shadow/i.test(name));
      if (keep) emit(ctx, { offset: node.at, length: node.end - node.at, detector: 'js-theme', via: 'config', name, value: node.value, ...parsed });
    }
  }
}

// JSON DTCG (`$value`, `$type` hérité) ou Style Dictionary (`value`).
function scanTokensJson(ctx: Ctx) {
  const start = ctx.text.indexOf('{');
  if (start === -1) return;
  const root = new LitParser(ctx.text).value(start);
  const dtcg = /"\$value"\s*:/.test(ctx.text);
  const key = dtcg ? '$value' : 'value';
  const walk = (node: Lit, path: string[], type: string | null) => {
    if (node.t !== 'obj') return;
    const own = node.entries.find((e) => e.key === '$type' || e.key === 'type');
    const t = own?.value.t === 'str' ? own.value.value : type;
    const v = node.entries.find((e) => e.key === key);
    if (v) {
      const name = path.join('.');
      let value: string | null = null;
      let at = v.value.at;
      let end = v.value.end;
      if (v.value.t === 'str') value = v.value.value;
      else if (v.value.t === 'num') value = String(v.value.value);
      else if (v.value.t === 'arr' && v.value.items[0]?.t === 'str' && (t === 'fontFamily' || /font/i.test(name))) {
        // Pile de polices : la première, comme ailleurs.
        const first = v.value.items[0];
        ({ value, at, end } = { value: first.value, at: first.at, end: first.end });
      }
      else if (v.value.t === 'obj') {
        // DTCG 2025 : { value, unit } ou { colorSpace, components, hex }.
        const f = (k: string) => (v.value as Lit & { t: 'obj' }).entries.find((e) => e.key === k)?.value;
        const hex = f('hex');
        const amount = f('value');
        const unit = f('unit');
        if (hex?.t === 'str') ({ value, at, end } = { value: hex.value, at: hex.at, end: hex.end });
        else if (amount?.t === 'num' && unit?.t === 'str') value = `${amount.value}${unit.value}`;
      }
      if (value === null) value = ctx.text.slice(at, end).replace(/\s+/g, ' ').slice(0, 200);
      const parsed = kindOf(t ?? name, value);
      const kind: ValueKind = parsed.kind !== 'other' ? parsed.kind : t === 'shadow' ? 'shadow' : t === 'fontFamily' ? 'font' : 'other';
      emit(ctx, { offset: at, length: end - at, detector: 'tokens-json', via: 'json', name, value, kind, normalized: kind === 'font' ? firstFont(value) : parsed.normalized });
      return;
    }
    for (const e of node.entries) if (!e.key.startsWith('$')) walk(e.value, [...path, e.key], t);
  };
  walk(root, [], null);
}

// Objets `style={{ … }}` / `sx={{ … }}` du JSX.
function scanJsxStyles(ctx: Ctx) {
  const parser = new LitParser(ctx.text);
  for (const m of ctx.text.matchAll(/\b(style|sx)\s*=\s*\{\s*\{/g)) {
    const obj = parser.value(m.index! + m[0].length - 1);
    for (const { path, node } of leaves(obj)) {
      const prop = camelToKebab(path[path.length - 1] ?? '');
      if (node.t === 'str') scanValue(ctx, prop, node.value, node.at, 'jsx-style');
      else if (m[1] === 'style' && node.value !== 0 && LENGTH_PROP.test(prop))
        emit(ctx, { offset: node.at, length: node.end - node.at, detector: 'hardcoded', via: 'jsx-style', kind: 'length', name: prop, value: String(node.value), normalized: `${node.value}px` });
    }
  }
}

// Gabarits CSS-in-JS : styled.x`…`, styled(X)`…`, css`…`, createGlobalStyle`…`.
function scanCssInJs(ctx: Ctx) {
  const re = /(?:\bstyled(?:\.[A-Za-z]+|\([^()`]*\))(?:\.attrs\([^`]*?\))?(?:<[^`>]*>)?|\b(?:css|createGlobalStyle|keyframes|injectGlobal))\s*`/g;
  const parser = new LitParser(ctx.text);
  for (const m of ctx.text.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const end = parser.str(open).end - 1;
    let body = ctx.text.slice(open + 1, end);
    // Interpolations ${…} remplacées par des blancs de même longueur.
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '$' && body[i + 1] === '{') {
        const close = parser.skip(open + 1 + i + 2, '}') - (open + 1);
        out += blank(body.slice(i, close + 1));
        i = close;
      } else out += body[i];
    }
    body = out;
    scanCss(ctx, body, open + 1, 'css-in-js', true);
  }
}

// --- Classes Tailwind -----------------------------------------------------

const TW_PALETTE = new Set([
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose', 'white', 'black',
]);
const TW_COLOR_UTIL = /^(bg|text|border(?:-[trblxyse])?|ring|ring-offset|fill|stroke|from|via|to|outline|divide|placeholder|accent|caret|decoration|shadow)-([a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*?)(?:-(\d{2,3}))?(?:\/\d+)?$/;
const TW_SPACE = /^(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.5)?|px)$/;
const TW_RADIUS = /^rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?(?:-(none|xs|sm|md|lg|xl|2xl|3xl|4xl|full))?$/;
const TW_TEXT = /^text-(xs|sm|base|lg|xl|[2-9]xl)$/;
const TW_SHADOW = /^shadow(?:-(2xs|xs|sm|md|lg|xl|2xl|inner|none))?$/;
const TW_ARBITRARY = /^([a-z]+(?:-[a-z]+)*)-\[([^\]]+)\]$/;
const TW_LENGTH_UTIL = /^(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy]|rounded(-[a-z]+)?|text)$/;

function scanClassString(ctx: Ctx, value: string, at: number, themeColors: Set<string>) {
  for (const m of value.matchAll(/[^\s"'`]+/g)) {
    let token = m[0];
    let offset = at + m.index!;
    // Variantes (hover:, md:, dark:…) et important (!) retirés de la position.
    const colon = token.lastIndexOf(':', token.includes('[') ? token.indexOf('[') : undefined);
    if (colon !== -1) {
      offset += colon + 1;
      token = token.slice(colon + 1);
    }
    if (token.startsWith('!')) (offset++, (token = token.slice(1)));
    const base = { offset, length: token.length, via: 'class' as const, name: token, value: token };
    const arb = TW_ARBITRARY.exec(token);
    if (arb) {
      const inner = arb[2].replace(/_/g, ' ');
      const v = /^var\((--[\w-]+)/.exec(inner);
      if (v) {
        emit(ctx, { ...base, detector: 'var-use', kind: 'alias', normalized: `var(${v[1]})` });
        continue;
      }
      const color = parseColor(inner.replace(/^color:/, ''));
      const length = TW_LENGTH_UTIL.test(arb[1]) ? parseLength(inner) : null;
      if (color) emit(ctx, { ...base, detector: 'hardcoded', kind: 'color', normalized: color });
      else if (length) emit(ctx, { ...base, detector: 'hardcoded', kind: 'length', normalized: length });
      else if (arb[1] === 'font' && /[a-z]/i.test(inner)) emit(ctx, { ...base, detector: 'hardcoded', kind: 'font', normalized: firstFont(inner) });
      continue;
    }
    const v4var = /^[a-z-]+-\((--[\w-]+)\)$/.exec(token);
    if (v4var) {
      emit(ctx, { ...base, detector: 'var-use', kind: 'alias', normalized: `var(${v4var[1]})` });
      continue;
    }
    const t = token.replace(/^-/, '');
    let hit: { kind: ValueKind; normalized: string } | null = null;
    const c = TW_COLOR_UTIL.exec(t);
    if (c && (TW_PALETTE.has(c[2]) || themeColors.has(c[2]))) hit = { kind: 'color', normalized: `color:${c[2]}${c[3] ? '-' + c[3] : ''}` };
    else if (TW_SPACE.test(t)) {
      const n = TW_SPACE.exec(t)![2];
      hit = { kind: 'length', normalized: `${n === 'px' ? 1 : parseFloat(n) * 4}px` };
    } else if (TW_RADIUS.test(t)) hit = { kind: 'length', normalized: `radius:${TW_RADIUS.exec(t)![1] ?? 'DEFAULT'}` };
    else if (TW_TEXT.test(t)) hit = { kind: 'length', normalized: `text:${TW_TEXT.exec(t)![1]}` };
    else if (TW_SHADOW.test(t)) hit = { kind: 'shadow', normalized: `shadow:${TW_SHADOW.exec(t)![1] ?? 'DEFAULT'}` };
    if (hit) emit(ctx, { ...base, detector: 'tailwind-class', ...hit });
  }
}

const CLASS_ATTR = /(?:^|[\s<])(?:class|className|class:list)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(["'`])([^"'`$]*)\3\s*\})/dg;
const CLASS_CALL = /\b(?:clsx|cn|cx|classnames|classNames|twMerge|twJoin|cva|tv)\s*\(/g;

function scanClasses(ctx: Ctx, themeColors: Set<string>) {
  for (const m of ctx.text.matchAll(CLASS_ATTR)) {
    const g = m[1] !== undefined ? 1 : m[2] !== undefined ? 2 : 4;
    scanClassString(ctx, m[g], m.indices![g]![0], themeColors);
  }
  const parser = new LitParser(ctx.text);
  for (const m of ctx.text.matchAll(CLASS_CALL)) {
    const end = parser.skip(m.index! + m[0].length, ')');
    for (let i = m.index! + m[0].length; i < end; ) {
      const ch = ctx.text[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const s = parser.str(i);
        if (!s.interp) scanClassString(ctx, ctx.text.slice(i + 1, s.end - 1), i + 1, themeColors);
        i = s.end;
      } else i++;
    }
  }
}

// --- Fichier et dépôt -----------------------------------------------------

export interface ScanContext {
  /** Tailwind repéré dans le dépôt : sinon les classes ne sont pas lues. */
  tailwind: boolean;
  /** Noms de couleurs du thème (config v3 ou @theme v4) pour les classes. */
  themeColors: Set<string>;
}

function scanMarkup(ctx: Ctx) {
  for (const m of ctx.text.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/dgi))
    scanCss(ctx, m[2], m.indices![2]![0], 'css', /lang\s*=\s*["']?(scss|sass)/i.test(m[1]));
  for (const m of ctx.text.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/dg)) {
    const g = m[1] !== undefined ? 1 : 2;
    scanCss(ctx, m[g], m.indices![g]![0], 'style-attr', false);
  }
}

/** Occurrences d'un fichier (sans les classes Tailwind si `context` est absent). */
export function scanFile(file: string, text: string, context?: ScanContext): Occurrence[] {
  const ctx: Ctx = { file, text, lines: lineStarts(text), out: [] };
  const base = file.split('/').pop() ?? file;
  if (base === 'package.json') return [];
  if (/\.json$/i.test(base)) scanTokensJson(ctx);
  else if (STYLE_EXT.test(base)) scanCss(ctx, text, 0, 'css', /\.(scss|sass|less)$/i.test(base));
  else if (MARKUP_EXT.test(base)) scanMarkup(ctx);
  else if (SCRIPT_EXT.test(base)) {
    if (TAILWIND_CONFIG.test(file)) scanTailwindConfig(ctx);
    else {
      if (JS_THEME_FILE.test(file) || /\b(createTheme|extendTheme|createStitches)\(/.test(text)) scanJsTheme(ctx);
      if (/\.[jt]sx$/i.test(base)) {
        scanJsxStyles(ctx);
        scanMarkup(ctx);
      }
      scanCssInJs(ctx);
    }
  }
  if (context?.tailwind && (MARKUP_EXT.test(base) || (SCRIPT_EXT.test(base) && !TAILWIND_CONFIG.test(file)))) scanClasses(ctx, context.themeColors);
  return ctx.out.sort((a, b) => a.offset - b.offset);
}

export interface RepoFile {
  path: string;
  text: string;
}

export interface RepoScan {
  /** Fichiers lus (après filtre et sous-dossier). */
  files: number;
  tailwind: 'v3' | 'v4' | 'inconnu' | null;
  occurrences: Occurrence[];
  /** Plus de `MAX_OCCURRENCES` occurrences : la suite n'est pas relevée. */
  truncated: boolean;
}

export function scanRepo(all: RepoFile[], options: { subdir?: string } = {}): RepoScan {
  const prefix = options.subdir ? options.subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
  const files = all.filter((f) => isScannable(f.path) && f.path.startsWith(prefix));
  const css = files.filter((f) => STYLE_EXT.test(f.path) || MARKUP_EXT.test(f.path));
  const v4 = css.some((f) => /@import\s+["']tailwindcss["']|@theme\b/.test(f.text));
  const v3 = files.some((f) => TAILWIND_CONFIG.test(f.path)) || css.some((f) => /@tailwind\s+(base|components|utilities)/.test(f.text));
  const declared = files.some((f) => f.path.endsWith('package.json') && /"tailwindcss"\s*:/.test(f.text));
  const tailwind = v4 ? 'v4' : v3 ? 'v3' : declared ? 'inconnu' : null;

  const occurrences: Occurrence[] = [];
  for (const f of files) occurrences.push(...scanFile(f.path, f.text));
  const themeColors = new Set<string>();
  for (const o of occurrences) {
    if (o.kind !== 'color' && o.kind !== 'alias') continue;
    // brand, brand-dark (colors.brand.dark ou --color-brand-dark), sans le cran 500.
    const name = o.name ?? '';
    const parts =
      o.detector === 'tailwind-v3' && /^(colors|backgroundColor|textColor|borderColor)\./.test(name)
        ? name.split('.').slice(1)
        : o.detector === 'theme-v4' && name.startsWith('--color-')
          ? name.slice(8).split('-')
          : [];
    const words = parts.filter((p) => !/^\d+$/.test(p)).map((p) => p.toLowerCase());
    for (let i = 1; i <= words.length; i++) themeColors.add(words.slice(0, i).join('-'));
  }
  if (tailwind)
    for (const f of files) {
      if (!(MARKUP_EXT.test(f.path) || SCRIPT_EXT.test(f.path)) || TAILWIND_CONFIG.test(f.path)) continue;
      const ctx: Ctx = { file: f.path, text: f.text, lines: lineStarts(f.text), out: [] };
      scanClasses(ctx, themeColors);
      occurrences.push(...ctx.out);
    }
  const truncated = occurrences.length >= MAX_OCCURRENCES;
  return { files: files.filter((f) => !f.path.endsWith('package.json')).length, tailwind, occurrences: occurrences.slice(0, MAX_OCCURRENCES), truncated };
}

export interface ScanSummary {
  files: number;
  filesWithOccurrences: number;
  tailwind: RepoScan['tailwind'];
  truncated: boolean;
  byDetector: Partial<Record<Detector, { occurrences: number; distinct: number }>>;
  hardcoded: Partial<Record<ValueKind, { occurrences: number; distinct: number }>>;
  byVia: Partial<Record<Via, number>>;
}

/** Chiffres seulement (sonde) : aucun nom de fichier, aucune valeur. */
export function summarizeScan(scan: RepoScan): ScanSummary {
  const byDetector: ScanSummary['byDetector'] = {};
  const hardcoded: ScanSummary['hardcoded'] = {};
  const byVia: ScanSummary['byVia'] = {};
  const distinct = new Map<string, Set<string>>();
  const bump = (key: string, value: string) => {
    if (!distinct.has(key)) distinct.set(key, new Set());
    distinct.get(key)!.add(value);
  };
  for (const o of scan.occurrences) {
    const d = (byDetector[o.detector] ??= { occurrences: 0, distinct: 0 });
    d.occurrences++;
    bump('d:' + o.detector, DECLARATIONS.includes(o.detector) ? `${o.name}=${o.normalized}` : o.normalized);
    if (o.detector === 'hardcoded') {
      const h = (hardcoded[o.kind] ??= { occurrences: 0, distinct: 0 });
      h.occurrences++;
      bump('h:' + o.kind, o.normalized);
    }
    byVia[o.via] = (byVia[o.via] ?? 0) + 1;
  }
  for (const [k, d] of Object.entries(byDetector)) d.distinct = distinct.get('d:' + k)?.size ?? 0;
  for (const [k, h] of Object.entries(hardcoded)) h.distinct = distinct.get('h:' + k)?.size ?? 0;
  return {
    files: scan.files,
    filesWithOccurrences: new Set(scan.occurrences.map((o) => o.file)).size,
    tailwind: scan.tailwind,
    truncated: scan.truncated,
    byDetector,
    hardcoded,
    byVia,
  };
}
