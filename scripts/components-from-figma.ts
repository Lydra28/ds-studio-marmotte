// Convertit la liste brute des composants lus dans Figma par l'agent (lecture
// seule, voir le README du projet) en fichier de fiches importable dans
// l'atelier : noms corrigés par la nomenclature, propriétés ramenées à
// Variant / State / Size, tokens liés repris. Ne contacte pas Figma.
// Usage : npx tsx scripts/components-from-figma.ts brut.json [--project=projects/marmotte] > fiches.json
// Le rapport des corrections sort sur stderr ; rien n'est écrit dans l'atelier.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkComponentName } from '../app/shared/rules.js';
import {
  componentName,
  componentsFileSchema,
  type ComponentDoc,
  type Components,
} from '../app/shared/components.js';
import { isTokenKey } from '../app/shared/model.js';

const rawSchema = z.object({
  source: z.string().max(200).optional(),
  components: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      page: z.string().optional(),
      props: z.record(z.string(), z.array(z.string())).optional(),
      ignored: z.array(z.string()).optional(),
      variables: z.array(z.string()).optional(),
    }),
  ),
});

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Chemin du fichier brut requis.');
  process.exit(1);
}
const raw = rawSchema.parse(JSON.parse(await readFile(file, 'utf8')));

// Fiches déjà présentes dans l'atelier : jamais écrasées par l'import.
const project = args.find((a) => a.startsWith('--project='))?.slice(10);
const existing = new Set<string>();
if (project)
  for (const [source, pick] of [
    [path.join(project, '.ds-studio/state.json'), (j: any) => j.set?.components],
    [path.join(project, 'components.json'), (j: any) => j],
  ] as const)
    try {
      for (const name of Object.keys(pick(JSON.parse(await readFile(source, 'utf8'))) ?? {}))
        existing.add(name);
      break;
    } catch {
      /* Source absente : essayer la suivante. */
    }

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

const report: string[] = [];
const out: Components = {};
for (const c of raw.components) {
  // Apostrophes et signes retirés avant la nomenclature (« mur d'outils »).
  const check = checkComponentName(c.name.replace(/[^\p{L}\p{N}\s/_-]+/gu, ' '));
  const name = check.suggestion.split(' · ')[0];
  const where = c.page ? ` (page ${c.page})` : '';
  if (!componentName.test(name)) {
    report.push(`ignoré : « ${c.name} »${where}, nom inutilisable → à renommer à la main`);
    continue;
  }
  if (existing.has(name)) {
    report.push(`déjà dans l'atelier : ${name}, fiche conservée`);
    continue;
  }
  if (out[name]) {
    report.push(`doublon : « ${c.name} »${where} donne aussi ${name}, seul le premier est gardé`);
    continue;
  }
  if (name !== c.name) report.push(`renommé : « ${c.name} » → ${name}`);
  if (check.issues.some((i) => i.includes('générique')))
    report.push(`à revoir : ${name} est un nom générique`);
  const props: ComponentDoc['props'] = {};
  for (const [key, values] of Object.entries(c.props ?? {})) {
    const target = /^property \d+$/i.test(key) ? 'Variant' : propAlias[plain(key)];
    if (!target || props[target]) {
      report.push(`propriété non reprise : ${name} « ${key} » (${values.join(', ')})`);
      continue;
    }
    if (target !== key) report.push(`propriété : ${name} « ${key} » → ${target}`);
    const kept = [...new Set(values.map(value))];
    if (kept.length > 40) report.push(`propriété tronquée : ${name} ${target}, 40 valeurs gardées sur ${kept.length}`);
    props[target] = kept.slice(0, 40);
  }
  for (const p of c.ignored ?? []) report.push(`propriété non reprise : ${name} « ${p} »`);
  out[name] = {
    status: 'fiche',
    props,
    role: (c.description ?? '').trim().slice(0, 400),
    use: '',
    avoid: '',
    a11y: '',
    tokens: [...new Set((c.variables ?? []).filter(isTokenKey))].slice(0, 40),
  };
}

const result = componentsFileSchema.parse({
  format: 'ds-studio-components/1',
  source: raw.source,
  components: out,
});
console.log(JSON.stringify(result, null, 2));
console.error(
  [`${Object.keys(out).length} fiche(s) prête(s) sur ${raw.components.length} composant(s).`, ...report].join(
    '\n',
  ),
);
