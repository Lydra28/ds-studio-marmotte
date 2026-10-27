import {
  contrast,
  fromHsl,
  isAlias,
  resolve,
  toHsl,
  type Change,
  type TokenSet,
} from './model.js';
import { components } from './components.js';

// Règles de correction : elles signalent et proposent, elles n'appliquent
// jamais. Ajouter une règle = ajouter une entrée à `rules` et un test.
export interface Finding {
  rule: string;
  key: string;
  mode?: string;
  message: string;
  fix?: Change;
  fixLabel?: string;
}
interface Rule {
  id: string;
  label: string;
  check: (set: TokenSet) => Finding[];
}

const rawEntries = (set: TokenSet) =>
  Object.entries(set.tokens).flatMap(([key, token]) =>
    Object.entries(token.$values).map(([mode, value]) => ({
      key,
      token,
      mode,
      value,
    })),
  );

// Paires texte / fond vérifiées quand les deux tokens existent.
export const contrastPairs: [string, string, number][] = [
  ['text/primary', 'bg/canvas', 4.5],
  ['text/primary', 'bg/surface', 4.5],
  ['text/secondary', 'bg/surface', 4.5],
  ['text/muted', 'bg/surface', 4.5],
  ['text/danger', 'bg/surface', 4.5],
  ['text/on-brand', 'bg/brand', 4.5],
  ['text/on-brand', 'bg/brand-hover', 4.5],
  ['border/interactive', 'bg/surface', 3],
  ['border/focus', 'bg/canvas', 3],
];

function contrastFix(
  set: TokenSet,
  fg: string,
  bgHex: string,
  min: number,
  current: string,
): { value: string; label: string } {
  // D'abord une primitive existante qui passe, la plus proche de la teinte actuelle.
  const [h, , l] = toHsl(current);
  const candidates = Object.entries(set.tokens)
    .filter(([, t]) => t.$collection === 'primitives' && t.$type === 'color')
    .map(([key]) => ({ key, hex: String(resolve(set, key)) }))
    .filter((c) => contrast(c.hex, bgHex) >= min)
    .map((c) => {
      const [ch, , cl] = toHsl(c.hex);
      const dh = Math.min(Math.abs(ch - h), 360 - Math.abs(ch - h)) / 180;
      return { ...c, distance: dh + Math.abs(cl - l) };
    })
    .sort((a, b) => a.distance - b.distance);
  if (candidates[0])
    return {
      value: `{${candidates[0].key}}`,
      label: `utiliser ${candidates[0].key} (${contrast(candidates[0].hex, bgHex).toFixed(1)}:1)`,
    };
  // Sinon la même teinte, assombrie ou éclaircie jusqu'au seuil.
  const [hh, s, ll] = toHsl(current);
  const darker = toHsl(bgHex)[2] > 0.5;
  for (let step = 1; step <= 100; step++) {
    const next = Math.min(1, Math.max(0, ll + (darker ? -step : step) / 100));
    const hex = fromHsl(hh, s, next);
    if (contrast(hex, bgHex) >= min)
      return {
        value: hex,
        label: `${hex} (${contrast(hex, bgHex).toFixed(1)}:1), même teinte`,
      };
  }
  return { value: darker ? '#000000' : '#FFFFFF', label: 'noir ou blanc' };
}

export const rules: Rule[] = [
  {
    id: 'espacement-multiple-4',
    label: 'Espacements en multiples de 4',
    check: (set) =>
      rawEntries(set)
        .filter(
          (e) =>
            /^(space|layout)\//.test(e.key) &&
            e.token.$type === 'dimension' &&
            !isAlias(e.value) &&
            typeof e.value === 'number' &&
            // 0 et 2 px (filet, demi-pas) sont admis : choix de l'agent, cadrage du 2026-10-27.
            ![0, 2].includes(e.value) &&
            e.value % 4 !== 0,
        )
        .map((e) => {
          const fixed = Math.max(4, Math.round((e.value as number) / 4) * 4);
          return {
            rule: 'espacement-multiple-4',
            key: e.key,
            mode: e.mode,
            message: `${e.value} px n'est pas un multiple de 4.`,
            fix: { key: e.key, mode: e.mode, value: fixed },
            fixLabel: `${fixed} px`,
          };
        }),
  },
  {
    id: 'contraste',
    label: 'Contraste 4,5:1 (texte) et 3:1 (bordures d’interface)',
    check: (set) =>
      set.modes.tokens.flatMap((mode) =>
        contrastPairs
          .filter(([fg, bg]) => set.tokens[fg] && set.tokens[bg])
          .flatMap(([fg, bg, min]) => {
            const selection = { tokens: mode };
            const fgHex = String(resolve(set, fg, selection));
            const bgHex = String(resolve(set, bg, selection));
            const ratio = contrast(fgHex, bgHex);
            if (ratio >= min) return [];
            const fix = contrastFix(set, fg, bgHex, min, fgHex);
            return [
              {
                rule: 'contraste',
                key: fg,
                mode: set.tokens[fg].$collection === 'tokens' ? mode : undefined,
                message: `${fg} sur ${bg} : ${ratio.toFixed(2)}:1, il faut ${min}:1.`,
                fix:
                  set.tokens[fg].$collection === 'tokens'
                    ? { key: fg, mode, value: fix.value }
                    : undefined,
                fixLabel: fix.label,
              },
            ];
          }),
      ),
  },
  {
    id: 'taille-texte',
    label: 'Texte courant ≥ 16 px en mobile, aucun texte sous 12 px',
    check: (set) =>
      rawEntries(set)
        .filter((e) => e.key.startsWith('font/size/') && !isAlias(e.value))
        .flatMap((e) => {
          const size = e.value as number;
          const min =
            e.key.startsWith('font/size/body') && e.mode === 'mobile' ? 16 : 12;
          return size < min
            ? [
                {
                  rule: 'taille-texte',
                  key: e.key,
                  mode: e.mode,
                  message: `${size} px en ${e.mode} : minimum ${min} px.`,
                  fix: { key: e.key, mode: e.mode, value: min },
                  fixLabel: `${min} px`,
                },
              ]
            : [];
        }),
  },
  {
    id: 'nommage-composants',
    label: 'Noms de composants conformes',
    check: () =>
      components.flatMap((c) =>
        checkComponentName(c.name).issues.map((message) => ({
          rule: 'nommage-composants',
          key: c.name,
          message,
        })),
      ),
  },
];

export const runRules = (set: TokenSet) => rules.flatMap((r) => r.check(set));

// --- Nomenclature : nom de composant anglais en PascalCase, propriétés de
// variantes Variant / State / Size, valeurs en minuscules.
const translations: Record<string, string> = {
  bouton: 'Button',
  carte: 'Card',
  champ: 'Input',
  formulaire: 'Form',
  form: 'Form',
  fleche: 'Arrow',
  statut: 'Status',
  etiquette: 'Tag',
  etape: 'Step',
  entete: 'Header',
  header: 'Header',
  pied: 'Footer',
  barre: 'Bar',
  progression: 'Progress',
  recherche: 'Search',
  resultat: 'Result',
  projet: 'Project',
  projets: 'Project',
  photo: 'Photo',
  profil: 'Profile',
  outils: 'Tool',
  outil: 'Tool',
  mur: 'Wall',
  flou: 'Blur',
  texte: 'Text',
  titre: 'Title',
  filtres: 'Filter',
  filtre: 'Filter',
  icone: 'Icon',
  courts: 'Short',
  longs: 'Long',
  grand: 'Large',
};
const generic = ['component', 'frame', 'section', 'group', 'rectangle', 'box', 'row', 'container', 'h1', 'h2', 'h3', 'all'];
const standardProps = ['Variant', 'State', 'Size'];
const stopWords = ['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l', 'et'];
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function checkComponentName(input: string): {
  issues: string[];
  suggestion: string;
} {
  const issues: string[] = [];
  // Formats acceptés : « Nom », « Prop=valeur, Prop=valeur » (variante Figma)
  // ou « Nom · Prop=valeur ».
  const parts = input.split(/\s*[·|]\s*/);
  let name = parts.length > 1 || !input.includes('=') ? parts[0].trim() : '';
  const propPart =
    parts.length > 1 ? parts.slice(1).join(', ') : input.includes('=') ? input : '';
  if (/ \d+$/.test(name)) {
    issues.push('Suffixe numérique ajouté par Figma (« 1 ») à retirer.');
    name = name.replace(/ \d+$/, '');
  }
  const spacedSeparator = /\s\/|\/\s/.test(name);
  const segments = name.split('/').map((s) => s.trim()).filter(Boolean);
  const fixedSegments = segments.map((segment) => {
    const words = segment.split(/[\s_-]+/).filter(Boolean);
    if (words.some((w) => stopWords.includes(plain(w))))
      issues.push('Mots de liaison français (« de », « du »…) à retirer.');
    words.splice(0, words.length, ...words.filter((w) => !stopWords.includes(plain(w))));
    return words
      .map((w) => {
        const p = plain(w);
        if (translations[p]) {
          if (translations[p].toLowerCase() !== p)
            issues.push(`Mot français « ${w} » : en anglais « ${translations[p]} ».`);
          return translations[p];
        }
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join('');
  });
  if (segments.some((s) => generic.includes(plain(s))))
    issues.push('Nom générique qui ne dit pas ce que fait le composant.');
  const suggestion = fixedSegments.join('/');
  if (spacedSeparator)
    issues.push(`Séparateur « / » sans espaces : « ${suggestion} ».`);
  if (segments.length && suggestion !== segments.join('/'))
    issues.push(`Casse : composant en PascalCase anglais (« ${suggestion} »).`);
  // Propriétés de variantes : `Clé=valeur`.
  const pairs = [...propPart.matchAll(/([\w ]+)=([^,]+)/g)];
  const fixedProps = pairs.map(([, key, value]) => {
    const k = key.trim();
    let fixedKey = standardProps.find((s) => s.toLowerCase() === k.toLowerCase()) ?? k;
    if (/^property \d+$/i.test(k)) {
      issues.push(`« ${k} » est le nom par défaut de Figma : choisir Variant, State ou Size.`);
      fixedKey = 'Variant';
    } else if (!standardProps.includes(k)) {
      if (fixedKey !== k) issues.push(`Propriété « ${k} » : écrire « ${fixedKey} ».`);
      else issues.push(`Propriété « ${k} » hors standard : utiliser Variant, State ou Size.`);
    }
    const v = value.trim();
    const fixedValue = plain(v).replace(/\s+/g, '-');
    if (fixedValue !== v) issues.push(`Valeur « ${v} » : écrire « ${fixedValue} » (minuscules).`);
    return `${fixedKey}=${fixedValue}`;
  });
  return {
    issues: [...new Set(issues)],
    suggestion: [suggestion, fixedProps.join(', ')].filter(Boolean).join(' · '),
  };
}

// Vérifie une liste de noms (un par ligne) et signale aussi les doublons.
export function checkNames(lines: string[]) {
  const results = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, ...checkComponentName(name) }));
  const seen = new Map<string, string>();
  for (const r of results) {
    const base = r.suggestion.split(' · ')[0];
    const first = seen.get(base);
    if (first && first !== r.name)
      r.issues.push(`Doublon probable de « ${first} ».`);
    else seen.set(base, r.name);
  }
  return results;
}
