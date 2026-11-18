import { colorDistance, finalizeChanges, proposeFromInventory, type PageInventory } from './extract.js';
import { exportName } from './export.js';
import { aliasTarget, cssName, isAlias, isTokenKey, resolve, type Change, type Collection, type TokenSet, type TokenType, type TokenValue } from './model.js';
import { DECLARATIONS, type Detector, type Occurrence, type RepoScan, type Via } from './repo-scan.js';

// Projet depuis un dépôt et « Rattacher un dépôt » (plan GitHub, G3) :
// lecture du dépôt (G2) → changements sur le jeu du projet, plus le plan de
// remplacement (occurrence en dur → token, écart) que la PR de G5 écrira.
// Déterministe et locale : rien n'est écrit, tout passe par brouillon, diff
// et validation, comme l'extraction depuis un site.

// Seuils réunis ici pour être revus après la recette (G7).
export const REPO_THRESHOLDS = {
  // Déclarations convertibles à partir desquelles le dépôt est « structuré » :
  // ses tokens remplacent le gabarit ; en dessous, ses valeurs en dur sont
  // regroupées par la logique de l'extraction (gris, gammes, échelles).
  explicitTokens: 10,
  // Écart OKLab au-delà duquel une couleur en dur n'est rattachée à aucun token.
  colorGap: 0.05,
  // Écart accepté entre une longueur en dur et un cran : 10 % du cran, au
  // moins 2 px (recette du 2026-11-09 : 25 % changeait 80px en 64px), et
  // jamais plus de 25 % de la valeur en dur (2px ne devient pas 4px).
  lengthWindow: 0.1,
  lengthMin: 2,
  lengthOwn: 0.25,
  // `@media (max-width: ≤ 1023px)` = mode mobile de la typographie.
  mobileMaxWidth: 1023,
  maxTokens: 500,
  maxPlanEntries: 20_000,
};

export type RepoMode = 'create' | 'attach';

/** Token du projet et sa déclaration dans le dépôt (G5 : réécrire sa valeur sur place). */
export interface PlanToken {
  key: string;
  code: string;
  detector: Detector;
  file: string;
  line: number;
  col: number;
  offset: number;
  length: number;
  /** Valeur lue à cette position (G5 : vérifiée avant toute réécriture). */
  value: string;
  /** `var(--x)` du dépôt qui visent ce token ; null : usages non mesurés (SCSS, config, JSON). */
  uses: number | null;
}

/** Valeur en dur du dépôt et le token qui la remplacerait (null : aucun assez proche). */
export interface PlanEntry {
  file: string;
  line: number;
  col: number;
  offset: number;
  length: number;
  via: Via;
  kind: 'color' | 'length' | 'font';
  property: string | null;
  value: string;
  normalized: string;
  token: string | null;
  /** Couleur : écart OKLab ; longueur : écart en px ; police : 0. */
  gap: number | null;
}

export interface RepoReport {
  strategy: 'explicit' | 'inventory';
  files: number;
  declared: {
    /** Variables et tokens déclarés (noms distincts). */
    found: number;
    /** Convertis en tokens du projet. */
    kept: number;
    /** Déjà présents dans le projet (même nom de code). */
    matched: number;
    added: number;
    /** Gabarit retiré (création depuis un dépôt structuré). */
    removed: number;
    /** Redéclarations dans un composant ou un sélecteur : ignorées. */
    local: number;
    /** Valeurs d'un mode que le projet n'a pas (sombre, mobile). */
    modeIgnored: number;
  };
  /** Rattachement : même token, valeur différente entre le dépôt et le projet (rien changé). */
  differing: { key: string; project: string; repo: string }[];
  /** Même variable déclarée avec deux valeurs : celle du fichier principal gagne. */
  conflicts: { name: string; values: string[] }[];
  rejected: { name: string; reason: string }[];
  hardcoded: { total: number; mapped: number; exact: number; unmapped: number };
  gaps: { file: string; line: number; value: string; token: string; gap: number }[];
  unmapped: { value: string; count: number }[];
  /** Classes Tailwind par défaut ou du thème (réécrites à G5). */
  classes: number;
  /** Dégradés et ombres déclarés : gardés dans le code, couleurs liées aux tokens. */
  composite?: { name: string; kind: 'gradient' | 'shadow'; value: string; colors: number; bound: number }[];
  notes: string[];
}

export interface RepoProposal {
  changes: Change[];
  rejected: string[];
  report: RepoReport;
  tokens: PlanToken[];
  entries: PlanEntry[];
  /**
   * Clés du jeu proposé absentes du jeu enregistré à la lecture : seulement
   * proposées. Absentes à la publication, elles n'ont jamais été reprises
   * (brouillon pas mis ou pas validé), elles n'ont pas été retirées.
   */
  proposed: string[];
  truncated: boolean;
}

// --- Noms --------------------------------------------------------------

const GROUPS: Record<string, string> = {
  colors: 'color',
  textColor: 'text',
  backgroundColor: 'bg',
  borderColor: 'border',
  spacing: 'space',
  space: 'space',
  borderRadius: 'radius',
  radii: 'radius',
  fontSize: 'font/size',
  fontSizes: 'font/size',
  fontFamily: 'font/family',
  fonts: 'font/family',
  fontWeight: 'font/weight',
  fontWeights: 'font/weight',
};

function clean(path: string) {
  const parts = path
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split('/')
    .map((p) => p.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean);
  return parts.join('/');
}

/** Nom du projet proposé pour une déclaration du dépôt. */
export function keyFor(o: Pick<Occurrence, 'detector' | 'name'>): string {
  const name = o.name ?? '';
  if (o.detector === 'css-var' || o.detector === 'theme-v4') return clean(name.slice(2).replace(/-/g, '/'));
  if (o.detector === 'scss-var') return clean(name.slice(1).replace(/-/g, '/'));
  const [head, ...rest] = name.split('.');
  return clean([GROUPS[head] ?? head, ...rest].join('/'));
}

// Préfixe renommé à l'export, retrouvé à l'envers (« color/bg/ » → « bg/ »).
function unrename(key: string, rename: Record<string, string>) {
  const hit = Object.entries(rename)
    .filter(([, to]) => key.startsWith(to))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return hit ? hit[0] + key.slice(hit[1].length) : key;
}

// --- Contexte d'une déclaration ----------------------------------------

type Context = 'root' | 'dark' | 'mobile' | 'local';

function contextOf(o: Occurrence): Context {
  if (o.detector !== 'css-var' && o.detector !== 'theme-v4' && o.detector !== 'scss-var') return 'root';
  if (o.via === 'style-attr') return 'local';
  const headers = (o.scope ?? '').split(' > ').filter(Boolean);
  const selectors = headers.filter((h) => !h.startsWith('@'));
  if (o.via === 'css-in-js' && selectors.length === 0) return 'local';
  if (headers.some((h) => /prefers-color-scheme\s*:\s*dark|(^|[\s.[="'-])dark\b/i.test(h))) return 'dark';
  const rootish = selectors.every((h) => h.split(',').every((s) => /^(:root|html|:host|body)$/i.test(s.trim())));
  if (!rootish) return 'local';
  const media = headers.filter((h) => /^@media/i.test(h));
  if (media.length === 0) return 'root';
  const max = media.map((h) => /max-width\s*:\s*(\d+(?:\.\d+)?)px/i.exec(h)).find(Boolean);
  if (max && parseFloat(max[1]) <= REPO_THRESHOLDS.mobileMaxWidth && !media.some((h) => /min-width/i.test(h))) return 'mobile';
  return 'local';
}

// --- Valeurs -------------------------------------------------------------

type Converted = { type: TokenType; value: TokenValue; aliasOf?: undefined } | { aliasOf: string; type?: undefined; value?: undefined } | { reason: string };

const GRADIENT = /^\s*(repeating-)?(linear|radial|conic)-gradient\(/i;

const firstFamily = (raw: string) => raw.split(',')[0].trim().replace(/^['"]|['"]$/g, '');

function convert(o: Occurrence): Converted {
  const name = o.name ?? '';
  if (o.kind === 'color') {
    if (/^#[0-9A-F]{6}$/.test(o.normalized)) return { type: 'color', value: o.normalized };
    if (/^#[0-9A-F]{8}$/.test(o.normalized)) return { reason: 'couleur transparente (alpha) non prise en charge' };
    return { reason: 'couleur non lue' };
  }
  if (o.kind === 'length') {
    if (!o.normalized.endsWith('px')) return { reason: 'unité relative (em) non prise en charge : px ou rem attendus' };
    const n = parseFloat(o.normalized);
    if (!(n >= 0 && n <= 2000)) return { reason: 'longueur hors de 0 à 2000 px' };
    return { type: 'dimension', value: n };
  }
  if (o.kind === 'font') {
    const family = firstFamily(o.value);
    if (!family || /[;{}<>]/.test(family)) return { reason: 'police illisible' };
    return { type: 'fontFamily', value: family };
  }
  if (o.kind === 'alias') {
    const v = o.normalized;
    const target = /^var\((--[\w-]+)/.exec(v)?.[1] ?? /^\{([\w.-]+)\}$/.exec(v)?.[1] ?? /^\$[\w-]+$/.exec(v)?.[0];
    return target ? { aliasOf: target } : { reason: 'alias illisible' };
  }
  if (o.kind === 'shadow') return { reason: 'ombre : pas de type ombre dans le modèle' };
  if (GRADIENT.test(o.value)) return { reason: 'dégradé : pas de type dégradé dans le modèle' };
  const v = o.value.trim();
  if (/weight/i.test(name) && /^[1-9]00$/.test(v)) return { type: 'fontWeight', value: Number(v) };
  if (/line-?height|leading/i.test(name) && /^\d+(\.\d+)?%?$/.test(v)) {
    const n = parseFloat(v);
    return { type: 'number', value: v.endsWith('%') ? Math.round(n) : n <= 4 ? Math.round(n * 100) : Math.round(n) };
  }
  return { reason: 'valeur non prise en charge (calcul, mot-clé, ombre…)' };
}


// --- Inventaire de repli (dépôt en désordre) -----------------------------

function inventoryOf(hard: Occurrence[]): { desktop: PageInventory; mobile: PageInventory } {
  const colors = new Map<string, PageInventory['colors'][number]>();
  const count = (m: Map<number, number>, v: number) => m.set(v, (m.get(v) ?? 0) + 1);
  const spacings = new Map<number, number>();
  const radii = new Map<number, number>();
  const sizes = new Map<number, number>();
  const families = new Map<string, number>();
  for (const o of hard) {
    const prop = o.name ?? '';
    if (o.kind === 'color' && /^#[0-9A-F]{6}$/.test(o.normalized)) {
      const c = colors.get(o.normalized) ?? { hex: o.normalized, text: 0, area: 0, card: 0, border: 0, interactive: 0, button: 0, graphic: 0, canvas: false };
      if (/^(color|text)/.test(prop)) c.text += 100;
      else if (/background|^bg/.test(prop)) c.area += 100;
      else if (/border|outline|ring|divide/.test(prop)) c.border += 1;
      else if (/fill|stroke/.test(prop)) c.graphic += 100;
      else c.text += 50;
      colors.set(o.normalized, c);
    } else if (o.kind === 'length' && o.normalized.endsWith('px')) {
      const v = Math.round(parseFloat(o.normalized));
      if (v <= 0 || v > 1000) continue;
      if (/radius|^rounded/.test(prop)) count(radii, v);
      else if (/font-size|^text-/.test(prop)) count(sizes, v);
      else count(spacings, v);
    } else if (o.kind === 'font') {
      const f = firstFamily(o.value);
      families.set(f, (families.get(f) ?? 0) + 1);
    }
  }
  const top = (m: Map<number, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
  const body = [...families].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const page: PageInventory = {
    url: 'https://depot.local/',
    title: 'Dépôt',
    viewport: { width: 1280, height: 800 },
    elements: hard.length,
    overlays: 0,
    unread: 0,
    truncated: false,
    fonts: { body: body.slice(0, 80), heading: '' },
    colors: [...colors.values()].sort((a, b) => b.text + b.area - (a.text + a.area)).slice(0, 200),
    texts: top(sizes, 200).map((s) => ({ size: s.value, weight: 400, family: body.slice(0, 80), lineHeight: 0, chars: s.count * 50 })),
    spacings: top(spacings, 100),
    radii: top(radii, 50),
    borderWidths: [],
    shadows: [],
  };
  return { desktop: page, mobile: page };
}

// --- Proposition ---------------------------------------------------------

interface Decl {
  name: string;
  detector: Detector;
  root: Occurrence;
  dark?: Occurrence;
  mobile?: Occurrence;
  key: string;
  existing: string | null;
}

const show = (v: TokenValue | undefined) => (v === undefined ? '—' : String(v));

export function proposeFromRepo(scan: RepoScan, set: TokenSet, options: { mode: RepoMode; rename?: Record<string, string> }): RepoProposal {
  const T = REPO_THRESHOLDS;
  const rename = options.rename ?? {};
  const notes: string[] = [];
  const rejectedNames: RepoReport['rejected'] = [];
  const conflicts: RepoReport['conflicts'] = [];
  let local = 0;
  let modeIgnored = 0;

  // 1. Déclarations par nom, contexte par contexte. Même variable dans
  // plusieurs fichiers (planches, démos, copies) : celle du fichier qui
  // déclare le plus de variables (le fichier de tokens) gagne, puis la première.
  const weight = new Map<string, number>();
  for (const o of scan.occurrences)
    if (DECLARATIONS.includes(o.detector) && o.name && contextOf(o) === 'root') weight.set(o.file, (weight.get(o.file) ?? 0) + 1);
  const heavier = (a: Occurrence, b: Occurrence) => (weight.get(a.file) ?? 0) > (weight.get(b.file) ?? 0);
  const byName = new Map<string, { detector: Detector; root?: Occurrence; dark?: Occurrence; mobile?: Occurrence; values: Set<string> }>();
  for (const o of scan.occurrences) {
    if (!DECLARATIONS.includes(o.detector) || !o.name) continue;
    const ctx = contextOf(o);
    if (ctx === 'local') {
      local++;
      continue;
    }
    const d = byName.get(o.name) ?? { detector: o.detector, values: new Set<string>() };
    if (ctx === 'root') {
      d.values.add(o.normalized);
      if (!d.root || heavier(o, d.root)) d.root = o;
    } else if (!d[ctx] || heavier(o, d[ctx]!)) d[ctx] = o;
    byName.set(o.name, d);
  }
  for (const [name, d] of byName) if (d.values.size > 1) conflicts.push({ name, values: [...d.values].slice(0, 4) });

  // 2. Correspondance avec les tokens du projet : même nom dans le code.
  const byCode = new Map<string, string>();
  for (const key of Object.keys(set.tokens)) byCode.set(cssName(exportName(key, rename)), key);
  const decls: Decl[] = [];
  const takenKeys = new Map<string, string>();
  for (const [name, d] of byName) {
    if (!d.root) {
      modeIgnored++;
      continue;
    }
    const css = d.detector === 'css-var' || d.detector === 'theme-v4';
    const proposed = keyFor({ detector: d.detector, name });
    const existing = (css ? byCode.get(name) : undefined) ?? (set.tokens[proposed] ? proposed : null);
    const key = existing ?? unrename(proposed, rename);
    if (!isTokenKey(key)) {
      rejectedNames.push({ name, reason: 'nom impossible à reprendre dans le projet' });
      continue;
    }
    if (takenKeys.has(key)) {
      rejectedNames.push({ name, reason: `même nom de projet que ${takenKeys.get(key)} (${key})` });
      continue;
    }
    takenKeys.set(key, name);
    decls.push({ name, detector: d.detector, root: d.root, dark: d.dark, mobile: d.mobile, key, existing });
  }

  // 3. Valeurs : brutes d'abord, puis alias résolus vers un token retenu.
  const nameToKey = new Map(decls.map((d) => [d.name, d.key]));
  const typeOf = new Map<string, TokenType>();
  const values = new Map<string, { root: TokenValue; dark?: TokenValue; mobile?: TokenValue }>();
  const pending = new Map<string, Decl>();
  const valueOf = (o: Occurrence, d: Decl): { type: TokenType; value: TokenValue } | { reason: string } | null => {
    const c = convert(o);
    if ('reason' in c) return c;
    if (c.aliasOf === undefined) return c;
    const target = nameToKey.get(c.aliasOf);
    if (!target) return { reason: `alias vers ${c.aliasOf}, non repris` };
    const t = typeOf.get(target);
    return t ? { type: t, value: `{${target}}` } : null;
  };
  for (const d of decls) pending.set(d.key, d);
  for (let round = 0; round < 12 && pending.size; round++) {
    let progressed = false;
    for (const [key, d] of [...pending]) {
      const v = valueOf(d.root, d);
      if (v === null) continue;
      pending.delete(key);
      progressed = true;
      if ('reason' in v) {
        rejectedNames.push({ name: d.name, reason: v.reason });
        nameToKey.delete(d.name);
        continue;
      }
      typeOf.set(key, v.type);
      const entry: { root: TokenValue; dark?: TokenValue; mobile?: TokenValue } = { root: v.value };
      for (const ctx of ['dark', 'mobile'] as const) {
        const o = d[ctx];
        if (!o) continue;
        const w = valueOf(o, d);
        if (w && !('reason' in w) && w.type === v.type) entry[ctx] = w.value;
      }
      values.set(key, entry);
    }
    if (!progressed) break;
  }
  for (const d of pending.values()) rejectedNames.push({ name: d.name, reason: 'alias circulaire ou vers une valeur refusée' });
  const kept = decls.filter((d) => values.has(d.key));

  // 4. Stratégie : dépôt structuré (ses tokens) ou en désordre (inventaire).
  const hard = scan.occurrences.filter((o) => o.detector === 'hardcoded');
  const strategy: RepoReport['strategy'] = options.mode === 'create' && kept.length < T.explicitTokens ? 'inventory' : 'explicit';
  const wanted: Change[] = [];
  const differing: RepoReport['differing'] = [];
  const collectionFor = (key: string, type: TokenType, alias: boolean): Collection =>
    /^font\/(size|line-height)\//.test(key) || (alias && key.startsWith('font/')) ? 'typography' : alias ? 'tokens' : 'primitives';
  const modeValues = (collection: Collection, v: { root: TokenValue; dark?: TokenValue; mobile?: TokenValue }) => {
    const modes = set.modes[collection];
    const out: Record<string, TokenValue> = {};
    modes.forEach((m, i) => {
      if (collection === 'tokens' && m === 'dark' && v.dark !== undefined) out[m] = v.dark;
      else if (collection === 'typography' && i === 1 && v.mobile !== undefined) out[m] = v.mobile;
      else out[m] = v.root;
    });
    if (v.dark !== undefined && !(collection === 'tokens' && modes.includes('dark'))) modeIgnored++;
    if (v.mobile !== undefined && !(collection === 'typography' && modes.length > 1)) modeIgnored++;
    return out;
  };

  // Ajouts dans l'ordre des dépendances (cible d'un alias avant l'alias).
  const added: string[] = [];
  const ordered: Decl[] = [];
  const placed = new Set<string>();
  const place = (d: Decl, depth = 0) => {
    if (placed.has(d.key) || depth > 20) return;
    const v = values.get(d.key)!;
    for (const x of [v.root, v.dark, v.mobile]) {
      if (x === undefined || !isAlias(x)) continue;
      const dep = kept.find((k) => k.key === aliasTarget(x));
      if (dep) place(dep, depth + 1);
    }
    placed.add(d.key);
    ordered.push(d);
  };
  kept.forEach((d) => place(d));
  // Limite du modèle : les plus utilisés d'abord.
  const uses = new Map<string, number>();
  for (const o of scan.occurrences) if (o.detector === 'var-use') uses.set(o.value, (uses.get(o.value) ?? 0) + 1);
  const room = T.maxTokens - Object.keys(set.tokens).length;
  const newcomers = ordered.filter((d) => !d.existing);
  const allowed = new Set(
    [...newcomers]
      .sort((a, b) => (uses.get(b.name) ?? 0) - (uses.get(a.name) ?? 0))
      .slice(0, Math.max(0, strategy === 'explicit' && options.mode === 'create' ? T.maxTokens : room))
      .map((d) => d.key),
  );

  if (strategy === 'inventory') {
    const inv = proposeFromInventory(inventoryOf(hard), set);
    wanted.push(...inv.changes);
    notes.push(
      `Dépôt peu structuré (${kept.length} token(s) déclaré(s)) : valeurs en dur regroupées sur le gabarit, comme depuis un site.`,
      ...inv.report.notes.filter((n) => !/calque|hors rgb|Page très longue/.test(n)),
    );
  }
  for (const d of ordered) {
    const v = values.get(d.key)!;
    const type = typeOf.get(d.key)!;
    if (d.existing) {
      const token = set.tokens[d.existing];
      if (token.$type !== type) {
        rejectedNames.push({ name: d.name, reason: `type ${type} dans le dépôt, ${token.$type} dans le projet` });
        continue;
      }
      const target = modeValues(token.$collection, v);
      for (const [mode, value] of Object.entries(target)) {
        // Dépôt peu structuré : le regroupement des valeurs en dur a pu viser
        // ce token du gabarit. La valeur déclarée dans le code l'emporte (la
        // PR la laisse alors telle quelle) ; jamais deux changements clé@mode,
        // que le client refuse en bloc (recette du 2026-11-17).
        if (options.mode === 'create')
          for (let i = wanted.length - 1; i >= 0; i--) {
            const w = wanted[i];
            if (!('op' in w) && w.key === d.existing && w.mode === mode) wanted.splice(i, 1);
          }
        const current = token.$values[mode];
        if (current === value) continue;
        if (options.mode === 'attach') {
          let project: TokenValue = current;
          try {
            project = resolve(set, d.existing, { [token.$collection]: mode });
          } catch {
            /* valeur brute montrée */
          }
          if (!differing.some((x) => x.key === d.existing)) differing.push({ key: d.existing, project: show(project), repo: show(value) });
        } else wanted.push({ key: d.existing, mode, value });
      }
      continue;
    }
    if (!allowed.has(d.key)) {
      rejectedNames.push({ name: d.name, reason: `limite de ${T.maxTokens} tokens du projet` });
      continue;
    }
    const alias = isAlias(v.root);
    const collection = collectionFor(d.key, type, alias);
    wanted.push({ op: 'add', key: d.key, token: { $type: type, $collection: collection, $values: modeValues(collection, v) } });
    added.push(d.key);
  }

  // Création depuis un dépôt structuré : le gabarit laisse la place, sauf ce
  // qu'un token gardé vise encore par alias.
  let removed = 0;
  if (strategy === 'explicit' && options.mode === 'create') {
    const keep = new Set(kept.map((d) => d.existing).filter((k): k is string => !!k));
    const drop = new Set(Object.keys(set.tokens).filter((k) => !keep.has(k)));
    for (let changed = true; changed; ) {
      changed = false;
      for (const k of Object.keys(set.tokens)) {
        if (drop.has(k)) continue;
        const after = Object.entries(set.tokens[k].$values).map(([m, val]) => {
          const c = wanted.find((w) => !('op' in w) && w.key === k && w.mode === m) as { value: TokenValue } | undefined;
          return c ? c.value : val;
        });
        for (const val of after)
          if (isAlias(val) && drop.has(aliasTarget(val))) {
            drop.delete(aliasTarget(val));
            changed = true;
          }
      }
    }
    const order = (k: string) => (set.tokens[k].$collection === 'primitives' ? 1 : 0);
    for (const k of [...drop].sort((a, b) => order(a) - order(b))) wanted.push({ op: 'remove', key: k });
    removed = drop.size;
    if (removed) notes.push(`Gabarit remplacé : ${removed} token(s) de départ retiré(s) au profit de ceux du dépôt.`);
  }
  const final = finalizeChanges(set, wanted);
  // Filet : `normalize` peut encore produire deux valeurs clé@mode (ajout d'un
  // token déjà ajouté). Appliqués dans l'ordre, le dernier gagne : seul gardé.
  const lastAt = new Map<string, number>();
  final.changes.forEach((c, i) => {
    if (!('op' in c)) lastAt.set(`${c.key}@${c.mode}`, i);
  });
  final.changes = final.changes.filter((c, i) => 'op' in c || lastAt.get(`${c.key}@${c.mode}`) === i);
  if (final.rejected.length) notes.push(`${final.rejected.length} changement(s) refusé(s) à l'essai à blanc.`);
  const next = final.set;

  // 5. Plan de remplacement : chaque valeur en dur vers le token le plus juste du jeu obtenu.
  const colorTokens: { key: string; hex: string; semantic: boolean }[] = [];
  // Longueur : valeur de chaque mode (taille de texte mobile comprise), l'écart
  // retenu est le pire : une valeur en dur fixe ne change pas sur mobile.
  const dims: { key: string; px: number; all: number[] }[] = [];
  const fonts: { key: string; family: string }[] = [];
  for (const [key, t] of Object.entries(next.tokens)) {
    let v: TokenValue;
    try {
      v = resolve(next, key);
    } catch {
      continue;
    }
    if (t.$type === 'color' && typeof v === 'string') colorTokens.push({ key, hex: v.toUpperCase(), semantic: t.$collection !== 'primitives' });
    else if (t.$type === 'dimension' && typeof v === 'number') {
      const all = next.modes[t.$collection]
        .map((m) => {
          try {
            return resolve(next, key, { [t.$collection]: m });
          } catch {
            return v;
          }
        })
        .filter((x): x is number => typeof x === 'number');
      dims.push({ key, px: v, all });
    }
    else if (t.$type === 'fontFamily') fonts.push({ key, family: String(v).toLowerCase() });
  }
  const role = (prop: string) =>
    /background|^bg/.test(prop) ? /(^|\/)(bg|background|surface|canvas)(\/|-|$)/ : /border|outline|ring|divide/.test(prop) ? /border|outline|stroke/ : /^(color|text)/.test(prop) ? /(^|\/)(text|fg|foreground|content)(\/|-|$)/ : null;
  const pickColor = (hex: string, prop: string): { token: string | null; gap: number | null } => {
    const exact = colorTokens.filter((c) => c.hex === hex);
    const r = role(prop);
    if (exact.length) {
      const best = (r && exact.find((c) => c.semantic && r.test(c.key))) ?? exact.find((c) => c.semantic) ?? exact[0];
      return { token: best.key, gap: 0 };
    }
    let best: { key: string; d: number } | null = null;
    for (const c of colorTokens) {
      const d = colorDistance(hex, c.hex);
      if (!best || d < best.d) best = { key: c.key, d };
    }
    if (!best) return { token: null, gap: null };
    const gap = Math.round(best.d * 1000) / 1000;
    return { token: gap <= T.colorGap ? best.key : null, gap };
  };
  const scaleOf = (prop: string) =>
    /radius|^rounded/.test(prop) ? /radius|rounded/ : /font-size|^text-/.test(prop) ? /font\/size|(^|\/)text\/|font-size/ : /(^|\/)(space|spacing|gap|gutter)(\/|$)/;
  const pickLength = (px: number, prop: string): { token: string | null; gap: number | null } => {
    const re = scaleOf(prop);
    const gapOf = (d: (typeof dims)[number]) => Math.max(...d.all.map((x) => Math.abs(x - px)), Math.abs(d.px - px));
    let best: (typeof dims)[number] | null = null;
    for (const d of dims) if (re.test(d.key) && (!best || gapOf(d) < gapOf(best))) best = d;
    if (!best) return { token: null, gap: null };
    const gap = gapOf(best);
    const fits = (g: number) => g === 0 || (g <= Math.max(T.lengthMin, best!.px * T.lengthWindow) && g <= px * T.lengthOwn);
    // Rattachable au mode principal, écarté seulement à cause d'un autre mode (mobile) : compté.
    if (!fits(gap) && fits(Math.abs(best.px - px))) modeOnly++;
    return { token: fits(gap) ? best.key : null, gap };
  };
  let modeOnly = 0;
  const entries: PlanEntry[] = [];
  let truncated = false;
  for (const o of hard) {
    if (o.kind !== 'color' && o.kind !== 'length' && o.kind !== 'font') continue;
    if (entries.length >= T.maxPlanEntries) {
      truncated = true;
      break;
    }
    const prop = o.name ?? '';
    const hit =
      o.kind === 'color'
        ? /^#[0-9A-F]{6}$/.test(o.normalized)
          ? pickColor(o.normalized, prop)
          : { token: null, gap: null }
        : o.kind === 'length'
          ? o.normalized.endsWith('px')
            ? pickLength(parseFloat(o.normalized), prop)
            : { token: null, gap: null }
          : (() => {
              const f = fonts.find((x) => x.family.split(',')[0].trim().replace(/^['"]|['"]$/g, '') === o.normalized);
              return { token: f?.key ?? null, gap: f ? 0 : null };
            })();
    entries.push({
      file: o.file,
      line: o.line,
      col: o.col,
      offset: o.offset,
      length: o.length,
      via: o.via,
      kind: o.kind,
      property: o.via === 'class' ? null : prop,
      value: o.value,
      normalized: o.normalized,
      ...hit,
    });
  }
  const mapped = entries.filter((e) => e.token);
  // Dégradés et ombres : restent dans le code ; leurs couleurs liées à un token
  // sont réécrites (PR, Site en direct). Montrés en lecture seule dans le panneau.
  const composite: RepoReport['composite'] = [];
  for (const r of rejectedNames) {
    const o = byName.get(r.name)?.root;
    if (!o || (o.kind !== 'shadow' && !GRADIENT.test(o.value))) continue;
    const inside = entries.filter((e) => e.kind === 'color' && e.file === o.file && e.offset >= o.offset && e.offset < o.offset + o.length);
    composite.push({ name: r.name, kind: o.kind === 'shadow' ? 'shadow' : 'gradient', value: o.value.slice(0, 300), colors: inside.length, bound: inside.filter((e) => e.token).length });
  }
  const unmappedCounts = new Map<string, number>();
  for (const e of entries) if (!e.token) unmappedCounts.set(e.normalized, (unmappedCounts.get(e.normalized) ?? 0) + 1);

  const finalKeys = new Set(Object.keys(next.tokens));
  const varUses = new Map<string, number>();
  for (const o of scan.occurrences) if (o.detector === 'var-use') varUses.set(o.value, (varUses.get(o.value) ?? 0) + 1);
  const tokens: PlanToken[] = kept
    .filter((d) => finalKeys.has(d.key))
    .map((d) => ({
      key: d.key,
      code: d.name,
      detector: d.detector,
      file: d.root.file,
      line: d.root.line,
      col: d.root.col,
      offset: d.root.offset,
      length: d.root.length,
      value: d.root.value,
      uses: d.detector === 'css-var' || d.detector === 'theme-v4' ? (varUses.get(d.name) ?? 0) : null,
    }));
  const addedFinal = added.filter((k) => finalKeys.has(k) && !set.tokens[k]);
  if (local) notes.push(`${local} redéclaration(s) dans un composant ou un sélecteur, ignorée(s) : le projet garde la valeur de :root.`);
  if (modeIgnored) notes.push(`${modeIgnored} valeur(s) d'un mode absent du projet (sombre, mobile) non reprise(s).`);
  if (modeOnly)
    notes.push(`${modeOnly} longueur(s) en dur laissée(s) telle(s) quelle(s) : le token proche change sur mobile, la valeur du code non (rendu mobile gardé).`);
  if (options.mode === 'attach' && differing.length)
    notes.push(`${differing.length} token(s) du projet ont une autre valeur dans le dépôt : rien n'est changé, la PR de la prochaine version alignera le code.`);

  return {
    changes: final.changes,
    rejected: final.rejected,
    tokens,
    entries,
    proposed: [...finalKeys].filter((k) => !set.tokens[k]),
    truncated,
    report: {
      strategy,
      files: scan.files,
      declared: {
        found: byName.size,
        kept: kept.length,
        matched: kept.filter((d) => d.existing).length,
        added: addedFinal.length,
        removed,
        local,
        modeIgnored,
      },
      differing: differing.slice(0, 50),
      conflicts: conflicts.slice(0, 50),
      rejected: rejectedNames.slice(0, 100),
      hardcoded: { total: entries.length, mapped: mapped.length, exact: mapped.filter((e) => e.gap === 0).length, unmapped: entries.length - mapped.length },
      gaps: mapped
        .filter((e) => (e.gap ?? 0) > 0)
        .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))
        .slice(0, 10)
        .map((e) => ({ file: e.file, line: e.line, value: e.value, token: e.token!, gap: e.gap! })),
      unmapped: [...unmappedCounts]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count })),
      classes: scan.occurrences.filter((o) => o.detector === 'tailwind-class').length,
      composite: composite.slice(0, 50),
      notes,
    },
  };
}
