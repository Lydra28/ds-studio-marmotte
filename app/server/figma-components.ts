import { z } from 'zod';
import { checkComponentName } from '../shared/rules.js';
import {
  componentName,
  componentsFileSchema,
  type ComponentDoc,
  type Components,
} from '../shared/components.js';
import { isTokenKey } from '../shared/model.js';

// Composants lus dans Figma (plugin DS-Studio ou agent, lecture seule)
// convertis en fichier de fiches importable : noms corrigés par la
// nomenclature, propriétés ramenées à Variant / State / Size, tokens liés
// repris. Rien n'est écrit : l'atelier en fait une proposition (diff).
export const rawComponentsSchema = z.object({
  source: z.string().max(200).optional(),
  components: z
    .array(
      z.object({
        name: z.string().max(200),
        description: z.string().max(2000).optional(),
        page: z.string().max(200).optional(),
        props: z
          .record(z.string(), z.array(z.string().max(100)).max(200))
          .optional(),
        ignored: z.array(z.string().max(200)).max(50).optional(),
        variables: z.array(z.string().max(200)).max(200).optional(),
      }),
    )
    .max(400),
});
export type RawComponents = z.infer<typeof rawComponentsSchema>;

const propAlias: Record<string, 'Variant' | 'State' | 'Size'> = {
  variant: 'Variant',
  variante: 'Variant',
  type: 'Variant',
  style: 'Variant',
  kind: 'Variant',
  state: 'State',
  etat: 'State',
  status: 'State',
  statut: 'State',
  size: 'Size',
  taille: 'Size',
};
const plain = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const value = (v: string) => plain(v).replace(/\s+/g, '-');

export function componentsFromFigma(
  raw: RawComponents,
  existing: Set<string>,
  // Tokens du projet : les variables Figma absentes du jeu ne sont pas reprises.
  known?: Set<string>,
) {
  const report: string[] = [];
  const out: Components = {};
  for (const c of raw.components) {
    // Apostrophes et signes retirés avant la nomenclature (« mur d'outils »).
    const check = checkComponentName(
      c.name.replace(/[^\p{L}\p{N}\s/_-]+/gu, ' '),
    );
    const name = check.suggestion.split(' · ')[0];
    const where = c.page ? ` (page ${c.page})` : '';
    if (!componentName.test(name)) {
      report.push(
        `ignoré : « ${c.name} »${where}, nom inutilisable → à renommer à la main`,
      );
      continue;
    }
    if (existing.has(name)) {
      report.push(`déjà dans l'atelier : ${name}, fiche conservée`);
      continue;
    }
    if (out[name]) {
      report.push(
        `doublon : « ${c.name} »${where} donne aussi ${name}, seul le premier est gardé`,
      );
      continue;
    }
    if (name !== c.name) report.push(`renommé : « ${c.name} » → ${name}`);
    if (check.issues.some((i) => i.includes('générique')))
      report.push(`à revoir : ${name} est un nom générique`);
    const props: ComponentDoc['props'] = {};
    for (const [key, values] of Object.entries(c.props ?? {})) {
      const target = /^property \d+$/i.test(key)
        ? 'Variant'
        : propAlias[plain(key)];
      if (!target || props[target]) {
        report.push(
          `propriété non reprise : ${name} « ${key} » (${values.join(', ')})`,
        );
        continue;
      }
      if (target !== key)
        report.push(`propriété : ${name} « ${key} » → ${target}`);
      const kept = [...new Set(values.map(value))];
      if (kept.length > 40)
        report.push(
          `propriété tronquée : ${name} ${target}, 40 valeurs gardées sur ${kept.length}`,
        );
      props[target] = kept.slice(0, 40);
    }
    for (const p of c.ignored ?? [])
      report.push(`propriété non reprise : ${name} « ${p} »`);
    out[name] = {
      status: 'fiche',
      props,
      role: (c.description ?? '').trim().slice(0, 400),
      use: '',
      avoid: '',
      a11y: '',
      tokens: [
        ...new Set(
          (c.variables ?? []).filter(
            (v) => isTokenKey(v) && (!known || known.has(v)),
          ),
        ),
      ].slice(0, 40),
    };
  }

  const file = componentsFileSchema.parse({
    format: 'ds-studio-components/1',
    source: raw.source,
    components: out,
  });
  return {
    file,
    report: [
      `${Object.keys(out).length} fiche(s) prête(s) sur ${raw.components.length} composant(s).`,
      ...report,
    ],
  };
}
