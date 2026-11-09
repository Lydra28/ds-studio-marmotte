import { exportName, value as codeValue } from './export.js';
import { aliasTarget, cssName, isAlias, resolve, type TokenSet, type TokenType, type TokenValue } from './model.js';
import type { PlanEntry, PlanToken } from './repo-propose.js';
import { parseColor, parseLength } from './repo-scan.js';

// PR qui modifie le code (plan GitHub, G5) : plan de remplacement (G3) +
// fichiers de la branche de base → fichiers réécrits. Pur et déterministe :
// chaque position est vérifiée (sinon la même valeur cherchée sur la même
// ligne, sinon signalée), rien n'est deviné. Aucun fichier n'est créé ; seuls
// les fichiers lus du dépôt changent.

export interface Skipped {
  file: string;
  line: number;
  value: string;
  reason: string;
}

export interface RewriteResult {
  files: { path: string; text: string; edits: number }[];
  /** Variables déclarées dont la valeur change (noms du code). */
  changed: string[];
  /** Tokens du DS absents du code, ajoutés après la dernière variable du fichier hôte. */
  added: { code: string; file: string }[];
  /** Déclarations retirées (aucun usage mesuré). */
  removed: string[];
  /** Tokens retirés dans l'atelier mais encore utilisés : la PR est refusée. */
  blocked: { code: string; uses: number }[];
  /** Valeurs en dur remplacées par un token. */
  written: number;
  /** Remplacements par un token proche, pas identique (écart de rendu). */
  gaps: { file: string; line: number; value: string; code: string; kind: PlanEntry['kind']; gap: number }[];
  skipped: Skipped[];
  /** Valeurs en dur sans token assez proche : laissées telles quelles. */
  unmapped: number;
  notes: string[];
}

const CSS_DECL = new Set(['css-var', 'theme-v4', 'scss-var']);
const JS_VIA = new Set(['jsx-style', 'config', 'json']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstFamily = (raw: string) => raw.split(',')[0].trim().replace(/^['"]|['"]$/g, '').toLowerCase();
const quoteFamily = (family: string) => (/\s/.test(family) && !/[",]/.test(family) ? `"${family}"` : family);

function lineBounds(text: string, line: number) {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', start);
    if (next === -1) return null;
    start = next + 1;
  }
  const nl = text.indexOf('\n', start);
  return { start, end: nl === -1 ? text.length : nl };
}

/** Position de `value` : à son offset du plan, sinon seule fois sur sa ligne ; null sinon. */
export function locate(text: string, offset: number, value: string, line: number): number | null {
  if (text.slice(offset, offset + value.length) === value) return offset;
  const b = lineBounds(text, line);
  if (!b) return null;
  const row = text.slice(b.start, b.end);
  const first = row.indexOf(value);
  if (first === -1 || row.indexOf(value, first + 1) !== -1) return null;
  return b.start + first;
}

export function rewriteRepo(input: {
  tokens: PlanToken[];
  entries: PlanEntry[];
  set: TokenSet;
  rename: Record<string, string>;
  files: Map<string, string>;
  truncated?: boolean;
}): RewriteResult {
  const { set, rename, files } = input;
  const out: RewriteResult = { files: [], changed: [], added: [], removed: [], blocked: [], written: 0, gaps: [], skipped: [], unmapped: 0, notes: [] };
  type Edit = { at: number; end: number; text: string; line: number; value: string; entry?: PlanEntry };
  const edits = new Map<string, Edit[]>();
  const edit = (file: string, e: Edit) => {
    const list = edits.get(file) ?? [];
    list.push(e);
    edits.set(file, list);
  };
  const skip = (file: string, line: number, value: string, reason: string) => out.skipped.push({ file, line, value, reason });

  // Nom de code d'un token : celui du dépôt quand il y est déclaré en variable CSS.
  const codeOf = new Map(input.tokens.filter((t) => t.code.startsWith('--') || t.code.startsWith('$')).map((t) => [t.key, t.code]));
  const cssRef = (key: string) => {
    const code = codeOf.get(key);
    return `var(${code?.startsWith('--') ? code : cssName(exportName(key, rename))})`;
  };
  const write = (key: string, v: TokenValue) => (isAlias(v) ? cssRef(aliasTarget(v)) : codeValue(set, key, v, rename));
  const rootMode = (key: string) => set.modes[set.tokens[key].$collection][0];
  const modeNotes: string[] = [];
  const otherModes = (key: string, code: string) => {
    const t = set.tokens[key];
    const [root, ...rest] = set.modes[t.$collection];
    for (const m of rest) if (t.$values[m] !== undefined && t.$values[m] !== t.$values[root]) modeNotes.push(`${code} (${m} : ${write(key, t.$values[m])})`);
  };
  const same = (type: TokenType, current: string, v: TokenValue, detector: string) => {
    const cur = current.trim();
    if (isAlias(v)) {
      const target = aliasTarget(v);
      if (detector === 'scss-var') return cur === codeOf.get(target);
      return /^var\(\s*(--[\w-]+)/.exec(cur)?.[1] === cssRef(target).slice(4, -1);
    }
    if (type === 'color') return parseColor(cur) === String(v).toUpperCase();
    if (type === 'dimension') return parseLength(cur) === `${v}px`;
    if (type === 'fontFamily') return firstFamily(cur) === String(v).toLowerCase();
    return cur === String(v);
  };

  // 1. Variables déclarées : nouvelle valeur sur place, ou déclaration retirée.
  for (const t of input.tokens) {
    const token = set.tokens[t.key];
    const text = files.get(t.file);
    if (!token) {
      if (t.uses) {
        out.blocked.push({ code: t.code, uses: t.uses });
        continue;
      }
      const at = text === undefined ? null : locate(text, t.offset, t.value, t.line);
      const b = at === null ? null : lineBounds(text!, t.line);
      const row = b ? text!.slice(b.start, b.end) : '';
      if (t.uses === 0 && b && at! >= b.start && at! <= b.end && new RegExp(`^\\s*${escape(t.code)}\\s*:\\s*${escape(t.value)}\\s*;?\\s*\\r?$`).test(row)) {
        edit(t.file, { at: b.start, end: Math.min(b.end + 1, text!.length), text: '', line: t.line, value: t.code });
        out.removed.push(t.code);
      } else skip(t.file, t.line, t.code, t.uses === null ? 'retiré dans l’atelier : déclaration à retirer à la main (usages non mesurés)' : 'retiré dans l’atelier : déclaration à retirer à la main');
      continue;
    }
    otherModes(t.key, t.code);
    const v = token.$values[rootMode(t.key)];
    if (v === undefined || same(token.$type, t.value, v, t.detector)) continue;
    if (!CSS_DECL.has(t.detector)) {
      skip(t.file, t.line, t.code, `valeur à reporter à la main : ${write(t.key, v)}`);
      continue;
    }
    const at = text === undefined ? null : locate(text, t.offset, t.value, t.line);
    if (at === null) {
      skip(t.file, t.line, t.code, 'déclaration déplacée depuis la lecture du dépôt');
      continue;
    }
    let next: string;
    if (token.$type === 'fontFamily' && !isAlias(v)) next = t.value.replace(/^\s*("[^"]*"|'[^']*'|[^,]*)/, quoteFamily(String(v)));
    else if (t.detector === 'scss-var' && isAlias(v)) {
      const target = codeOf.get(aliasTarget(v));
      next = target?.startsWith('$') ? target : codeValue(set, t.key, resolve(set, t.key), rename);
    } else next = write(t.key, v);
    edit(t.file, { at, end: at + t.value.length, text: next, line: t.line, value: t.value });
    out.changed.push(t.code);
  }

  // 2. Tokens du DS absents du code : après la dernière variable CSS du
  // fichier qui en déclare le plus (même retrait, mêmes fins de ligne).
  const planKeys = new Set(input.tokens.map((t) => t.key));
  const fresh = Object.keys(set.tokens).filter((k) => !planKeys.has(k));
  if (fresh.length) {
    const hosts = new Map<string, PlanToken[]>();
    for (const t of input.tokens)
      if ((t.detector === 'css-var' || t.detector === 'theme-v4') && set.tokens[t.key] && files.has(t.file)) hosts.set(t.file, [...(hosts.get(t.file) ?? []), t]);
    const [file, list] = [...hosts].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    const anchor = list?.sort((a, b) => b.offset - a.offset)[0];
    const text = file ? files.get(file)! : '';
    const at = anchor ? locate(text, anchor.offset, anchor.value, anchor.line) : null;
    const b = anchor && at !== null ? lineBounds(text, anchor.line) : null;
    const tail = b && at! >= b.start && at! <= b.end ? text.slice(at! + anchor!.value.length, b.end) : null;
    if (file && b && tail !== null && /^\s*;\s*(\/\*.*?\*\/)?\s*\r?$/.test(tail)) {
      const row = text.slice(b.start, b.end);
      const indent = /^\s*/.exec(row)![0];
      const eol = row.endsWith('\r') ? '\r\n' : '\n';
      const insertAt = row.endsWith('\r') ? b.end - 1 : b.end;
      const lines = fresh.map((key) => {
        const code = cssName(exportName(key, rename));
        otherModes(key, code);
        out.added.push({ code, file });
        return `${eol}${indent}${code}: ${write(key, set.tokens[key].$values[rootMode(key)])};`;
      });
      edit(file, { at: insertAt, end: insertAt, text: lines.join(''), line: anchor!.line, value: '' });
    } else
      out.notes.push(
        `${fresh.length} token(s) du DS absent(s) du code non écrit(s) : aucun fichier de variables CSS où les ajouter sans risque. Export CSS de l’atelier à brancher à la main.`,
      );
  }

  // 3. Valeurs en dur rattachées à un token : remplacées par sa variable.
  for (const e of input.entries) {
    if (!e.token) {
      out.unmapped++;
      continue;
    }
    if (!set.tokens[e.token]) {
      skip(e.file, e.line, e.value, 'token retiré dans l’atelier');
      continue;
    }
    if (JS_VIA.has(e.via) || /^['"`]/.test(e.value)) {
      skip(e.file, e.line, e.value, 'objet de style JS : à remplacer à la main');
      continue;
    }
    const text = files.get(e.file);
    const at = text === undefined ? null : locate(text, e.offset, e.value, e.line);
    if (at === null) {
      skip(e.file, e.line, e.value, 'valeur déplacée depuis la lecture du dépôt');
      continue;
    }
    let next = cssRef(e.token);
    if (e.via === 'class') {
      const util = /^([a-z]+(?:-[a-z]+)*)-\[/.exec(e.value)?.[1];
      if (!util) {
        skip(e.file, e.line, e.value, 'classe non reconnue');
        continue;
      }
      next = `${util}-[${e.kind === 'color' ? 'color' : e.kind === 'length' ? 'length' : 'family-name'}:${next}]`;
    }
    edit(e.file, { at, end: at + e.value.length, text: next, line: e.line, value: e.value, entry: e });
  }

  // 4. Application, de la fin vers le début ; un chevauchement n'est jamais écrit.
  for (const [path, list] of edits) {
    list.sort((a, b) => a.at - b.at || a.end - b.end);
    const kept: typeof list = [];
    for (const e of list) {
      const prev = kept.at(-1);
      if (prev && e.at < prev.end) {
        skip(path, e.line, e.value, 'chevauche un autre remplacement');
        continue;
      }
      kept.push(e);
      const x = e.entry;
      if (x) {
        out.written++;
        if (x.gap) out.gaps.push({ file: x.file, line: x.line, value: x.value, code: e.text, kind: x.kind, gap: x.gap });
      }
    }
    let text = files.get(path)!;
    for (const e of [...kept].reverse()) text = text.slice(0, e.at) + e.text + text.slice(e.end);
    if (text !== files.get(path)) out.files.push({ path, text, edits: kept.length });
  }
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  if (modeNotes.length)
    out.notes.push(`Valeurs d’un autre mode (mobile, sombre) non écrites dans le code, à reporter à la main : ${modeNotes.slice(0, 20).join(', ')}${modeNotes.length > 20 ? '…' : ''}.`);
  if (input.truncated) out.notes.push('Dépôt lu en partie (bornes de lecture) : des valeurs en dur restent hors du plan.');
  return out;
}
