import { cssName, cssValue, isAlias, aliasTarget, type TokenSet, type TokenValue } from './model.js';

// Export du jeu vers le code d'un site : noms renommés comme dans le code
// (« bg/ » → « color/bg/ »), alias en var(), mode mobile en media query.
// Partagé : PR GitHub (serveur) et site en direct (navigateur).
export interface Naming {
  rename: Record<string, string>;
  mobileQuery: string;
}

// Préfixe le plus long qui correspond, renommé ; sinon le nom de l'atelier.
export function exportName(key: string, rename: Record<string, string>) {
  const from = Object.keys(rename)
    .filter((p) => key.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return from === undefined ? key : rename[from] + key.slice(from.length);
}

function value(set: TokenSet, key: string, v: TokenValue, rename: Record<string, string>) {
  if (isAlias(v)) return `var(${cssName(exportName(aliasTarget(v), rename))})`;
  const type = set.tokens[key].$type;
  if (type === 'fontFamily') {
    const family = String(v);
    return cssValue(type, /[\s]/.test(family) && !/[",]/.test(family) ? `"${family}"` : family);
  }
  return cssValue(type, v);
}

export function exportCss(set: TokenSet, target: Naming, header: string) {
  const lines = (pick: (modes: string[]) => string | undefined, keys = Object.keys(set.tokens)) =>
    keys
      .map((key) => {
        const t = set.tokens[key];
        const mode = pick(set.modes[t.$collection]);
        return mode && t.$values[mode] !== undefined
          ? `  ${cssName(exportName(key, target.rename))}: ${value(set, key, t.$values[mode], target.rename)};`
          : null;
      })
      .filter(Boolean)
      .join('\n');
  const typography = Object.keys(set.tokens).filter((k) => {
    const t = set.tokens[k];
    const [first, second] = set.modes.typography;
    return t.$collection === 'typography' && second && t.$values[second] !== t.$values[first];
  });
  const out = [`/* ${header} */`, `:root {\n${lines((m) => m[0])}\n}`];
  if (typography.length)
    out.push(`@media ${target.mobileQuery} {\n  :root {\n${lines((m) => m[1], typography).replace(/^/gm, '  ')}\n  }\n}`);
  return out.join('\n\n') + '\n';
}

export function exportJson(set: TokenSet, target: Naming, header: string) {
  const tokens = Object.fromEntries(
    Object.entries(set.tokens).map(([key, t]) => [
      exportName(key, target.rename),
      {
        ...t,
        $values: Object.fromEntries(
          Object.entries(t.$values).map(([m, v]) => [m, isAlias(v) ? `{${exportName(aliasTarget(v), target.rename)}}` : v]),
        ),
      },
    ]),
  );
  return JSON.stringify({ $comment: header, modes: set.modes, tokens }, null, 2) + '\n';
}

// Tailwind v4 : le CSS des variables, puis un bloc `@theme inline` qui les
// expose en utilitaires (bg-bg-brand, p-md, rounded-card, text-body…).
// Nom d'utilitaire tiré du nom de l'atelier ; la valeur suit le nom du code.
export function tailwindName(key: string, type: string): string | null {
  const dashed = (s: string) => s.replaceAll('/', '-');
  const last = key.split('/').at(-1)!;
  if (type === 'color') return `--color-${dashed(key.startsWith('color/') ? key.slice(6) : key)}`;
  if (type === 'fontFamily') return `--font-${last}`;
  if (type === 'fontWeight') return `--font-weight-${last}`;
  if (key.startsWith('font/size/')) return `--text-${dashed(key.slice(10))}`;
  if (key.startsWith('font/line-height/')) return `--leading-${dashed(key.slice(17))}`;
  if (key.startsWith('space/')) return `--spacing-${dashed(key.slice(6))}`;
  if (key.startsWith('radius/')) return `--radius-${dashed(key.slice(7))}`;
  return null;
}

export function exportTailwind(set: TokenSet, target: Naming, header: string) {
  const theme = Object.entries(set.tokens)
    .map(([key, t]) => {
      const name = tailwindName(key, t.$type);
      if (!name) return null;
      const code = cssName(exportName(key, target.rename));
      // Même nom dans le code (couleurs renommées en color/…) : la valeur
      // elle-même, sinon `--x: var(--x)` boucle.
      const first = t.$values[set.modes[t.$collection][0]];
      return `  ${name}: ${name === code ? value(set, key, first, target.rename) : `var(${code})`};`;
    })
    .filter(Boolean);
  return (
    exportCss(set, target, `${header} · à importer après @import "tailwindcss";`) +
    `\n@theme inline {\n${theme.join('\n')}\n}\n`
  );
}
