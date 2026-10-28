import { z } from 'zod';
import { tokenSetSchema, isAlias, aliasTarget, resolve, type Token } from '../shared/model.js';
import { versionHash } from './versions.js';
import { StudioError } from './store.js';

// Transfert d'une version acceptée vers Figma, calculé sans contacter Figma :
// collections, modes, variables (alias, scopes), composants à construire.
// Utilisé par le plugin DS-Studio et par scripts/figma-payload.ts (agent).
const versionSchema = z
  .object({
    project: z.string(),
    target: z
      .object({ fileKey: z.string(), page: z.string(), protectedPages: z.array(z.string()).default([]) })
      .nullable(),
    revision: z.number().int().nonnegative(),
    acceptedAt: z.string(),
    hash: z.string(),
    findings: z.array(z.unknown()),
    components: z.array(z.record(z.string(), z.unknown())).default([]),
    set: z.unknown(),
  })
  .passthrough();

const figmaType = (t: Token['$type']) =>
  t === 'color' ? 'COLOR' : t === 'fontFamily' ? 'STRING' : 'FLOAT';
// Scopes repris de design-system-figma (references/structure-tokens.md).
function scopes(key: string, t: Token): string[] {
  if (t.$type === 'fontFamily') return ['FONT_FAMILY'];
  if (t.$type === 'fontWeight') return ['FONT_WEIGHT'];
  if (key.startsWith('font/size/')) return ['FONT_SIZE'];
  if (key.startsWith('font/line-height/')) return ['LINE_HEIGHT'];
  if (key.startsWith('radius/')) return ['CORNER_RADIUS'];
  if (key.startsWith('border-width/') || key.startsWith('stroke/')) return ['STROKE_FLOAT'];
  if (key.startsWith('space/') || key.startsWith('layout/')) return ['GAP', 'WIDTH_HEIGHT'];
  if (key.startsWith('text/')) return ['TEXT_FILL'];
  if (key.startsWith('bg/')) return ['FRAME_FILL', 'SHAPE_FILL'];
  if (key.startsWith('border/')) return ['STROKE_COLOR'];
  if (key.startsWith('icon/')) return ['SHAPE_FILL', 'STROKE_COLOR'];
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
export const collectionNames = { primitives: 'Primitives', tokens: 'Tokens', typography: 'Typography' } as const;

export function buildFigmaPayload(raw: unknown) {
  const version = versionSchema.parse(raw);
  const set = tokenSetSchema.parse(version.set);
  const hash = versionHash(set);
  if (hash !== version.hash)
    throw new StudioError(`Empreinte invalide : ${hash} ≠ ${version.hash}. Transfert refusé.`, 409);
  if (!version.target?.fileKey)
    throw new StudioError('Aucune cible Figma pour ce projet : transfert refusé.', 409);
  const collections = (Object.keys(collectionNames) as (keyof typeof collectionNames)[]).map((c) => ({
    name: collectionNames[c],
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
              ? { alias: aliasTarget(v), collection: collectionNames[set.tokens[aliasTarget(v)].$collection] }
              : t.$type === 'color'
                ? rgb(String(v))
                : v,
          ]),
        ),
      })),
  }));
  // Police du composant : pile résolue (premier mode) ; le plugin prend la
  // première que Figma connaît (« Figtree Variable » sur le site, « Figtree » dans Figma).
  const stack = set.tokens['font/family/base'] ? String(resolve(set, 'font/family/base')) : '';
  const fonts = stack.split(',').map((f) => f.replace(/["']/g, '').trim()).filter(Boolean);
  return {
    target: version.target,
    project: version.project,
    revision: version.revision,
    acceptedAt: version.acceptedAt,
    hash,
    findings: version.findings.length,
    font: fonts[0] ?? null,
    fonts,
    collections,
    components: version.components,
  };
}
export type FigmaPayload = ReturnType<typeof buildFigmaPayload>;
