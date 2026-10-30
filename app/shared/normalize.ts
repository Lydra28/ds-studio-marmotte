import { isAlias, type Change, type TokenSet } from './model.js';

// Écarts de forme fréquents du modèle (Mur des DA et assistant), corrigés sans
// deviner le fond : ajout d'un token existant → valeurs ; nombre écrit en
// texte ("48", "48px") → nombre ; police de titre écrite comme une valeur →
// ajout des deux tokens documentés dans le prompt.
export function normalize(change: Change, set: TokenSet): Change[] {
  if ('op' in change) {
    if (change.op === 'add' && set.tokens[change.key])
      return Object.entries(change.token.$values).map(([mode, value]) => ({ key: change.key, mode, value }));
    return [change];
  }
  const token = set.tokens[change.key];
  if (token) {
    const numeric = ['dimension', 'number', 'fontWeight'].includes(token.$type);
    if (numeric && typeof change.value === 'string' && /^-?\d+(\.\d+)?\s*(px|%)?$/.test(change.value.trim()))
      return [{ ...change, value: parseFloat(change.value) }];
    return [change];
  }
  const family = String(change.value);
  const heading = (modes: string[]): Change => ({
    op: 'add',
    key: 'font/family/heading',
    token: {
      $type: 'fontFamily',
      $collection: 'typography',
      $values: Object.fromEntries(modes.map((m) => [m, '{font/family/display}'])),
    },
  });
  if (change.key === 'font/family/display')
    return [
      { op: 'add', key: 'font/family/display', token: { $type: 'fontFamily', $collection: 'primitives', $values: { default: family } } },
      ...(set.tokens['font/family/heading'] ? [] : [heading(set.modes.typography)]),
    ];
  // Nouveau cran d'une échelle existante (ex. font/weight/semibold) : type et
  // collection repris des voisins de même nature (valeurs brutes ou alias)
  // s'ils sont tous identiques.
  const parent = change.key.split('/').slice(0, -1).join('/');
  const alias = isAlias(change.value);
  const siblings = Object.entries(set.tokens).filter(
    ([k, t]) =>
      k.split('/').slice(0, -1).join('/') === parent && Object.values(t.$values).every((v) => isAlias(v) === alias),
  );
  const kinds = new Set(siblings.map(([, t]) => `${t.$type}|${t.$collection}`));
  if (parent && siblings.length && kinds.size === 1 && !change.key.startsWith('font/family/')) {
    const [, sample] = siblings[0];
    const value =
      sample.$type !== 'color' && typeof change.value === 'string' && /^-?\d+(\.\d+)?\s*(px|%)?$/.test(change.value.trim())
        ? parseFloat(change.value)
        : change.value;
    return [
      {
        op: 'add',
        key: change.key,
        token: {
          $type: sample.$type,
          $collection: sample.$collection,
          $values: Object.fromEntries(set.modes[sample.$collection].map((m) => [m, value])),
        },
      },
    ];
  }
  if (change.key === 'font/family/heading' && !family.startsWith('{'))
    return [
      { op: 'add', key: 'font/family/display', token: { $type: 'fontFamily', $collection: 'primitives', $values: { default: family } } },
      heading(set.modes.typography),
    ].filter((c) => !set.tokens[(c as { key: string }).key]) as Change[];
  return [change];
}
