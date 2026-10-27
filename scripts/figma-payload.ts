// Prépare le transfert d'une version acceptée vers Figma, sans contacter Figma.
// Usage : npx tsx scripts/figma-payload.ts projects/marmotte/versions/v4.json
// Refuse (code 1) si l'empreinte recalculée ne correspond pas au fichier.
import { readFile } from 'node:fs/promises';
import { tokenSetSchema, isAlias, aliasTarget, type Token } from '../app/shared/model.js';
import { versionHash } from '../app/server/versions.js';

const file = process.argv[2];
if (!file) {
  console.error('Chemin de la version acceptée requis.');
  process.exit(1);
}
const version = JSON.parse(await readFile(file, 'utf8'));
const set = tokenSetSchema.parse(version.set);
const hash = versionHash(set);
if (hash !== version.hash) {
  console.error(`Empreinte invalide : ${hash} ≠ ${version.hash}. Transfert refusé.`);
  process.exit(1);
}
if (!version.target?.fileKey) {
  console.error('Aucune cible Figma dans la version. Transfert refusé.');
  process.exit(1);
}

const figmaType = (t: Token['$type']) =>
  t === 'color' ? 'COLOR' : t === 'fontFamily' ? 'STRING' : 'FLOAT';
// Scopes repris de design-system-figma (references/structure-tokens.md).
function scopes(key: string, t: Token): string[] {
  if (t.$type === 'fontFamily') return ['FONT_FAMILY'];
  if (t.$type === 'fontWeight') return ['FONT_WEIGHT'];
  if (key.startsWith('font/size/')) return ['FONT_SIZE'];
  if (key.startsWith('font/line-height/')) return ['LINE_HEIGHT'];
  if (key.startsWith('radius/')) return ['CORNER_RADIUS'];
  if (key.startsWith('border-width/')) return ['STROKE_FLOAT'];
  if (key.startsWith('space/') || key.startsWith('layout/')) return ['GAP', 'WIDTH_HEIGHT'];
  if (key.startsWith('text/')) return ['TEXT_FILL'];
  if (key.startsWith('bg/')) return ['FRAME_FILL', 'SHAPE_FILL'];
  if (key.startsWith('border/')) return ['STROKE_COLOR'];
  if (t.$type === 'color')
    return ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR', 'EFFECT_COLOR'];
  return ['ALL_SCOPES'];
}
const rgb = (hex: string) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
  a: 1,
});
const names = { primitives: 'Primitives', tokens: 'Tokens', typography: 'Typography' } as const;
const collections = (Object.keys(names) as (keyof typeof names)[]).map((c) => ({
  name: names[c],
  modes: set.modes[c],
  variables: Object.entries(set.tokens)
    .filter(([, t]) => t.$collection === c)
    .map(([key, t]) => ({
      name: key,
      type: figmaType(t.$type),
      scopes: scopes(key, t),
      hidden: c === 'primitives',
      description: t.$description ?? '',
      values: Object.fromEntries(
        Object.entries(t.$values).map(([mode, v]) => [
          mode,
          isAlias(v)
            ? { alias: aliasTarget(v), collection: names[set.tokens[aliasTarget(v)].$collection] }
            : t.$type === 'color'
              ? rgb(String(v))
              : v,
        ]),
      ),
    })),
}));
console.log(
  JSON.stringify(
    {
      target: version.target,
      project: version.project,
      revision: version.revision,
      hash,
      findings: version.findings.length,
      collections,
      components: version.components,
    },
    null,
    2,
  ),
);
