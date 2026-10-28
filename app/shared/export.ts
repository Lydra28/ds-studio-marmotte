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
