import { z } from 'zod';

// Fiche d'un composant : nom (anglais, PascalCase), propriétés de variantes
// standard et documentation en français. Les fiches vivent dans le jeu du
// projet (`set.components`), avec le même diff, historique et versions que
// les tokens. Départ d'une instance : `projects/<projet>/components.json`.
const list = z.array(z.string().min(1).max(40)).max(40);
export const componentName = /^[A-Z][A-Za-z0-9]*(?:\/[A-Z][A-Za-z0-9]*)*$/;
export const componentSchema = z
  .object({
    status: z.enum(['figma', 'fiche']),
    props: z
      .object({ Variant: list.optional(), State: list.optional(), Size: list.optional() })
      .strict(),
    role: z.string().max(400),
    use: z.string().max(600),
    avoid: z.string().max(600),
    a11y: z.string().max(600),
    tokens: z.array(z.string().max(80)).max(40),
  })
  .strict();
export type ComponentDoc = z.infer<typeof componentSchema>;
export const componentsSchema = z.record(
  z.string().max(60).regex(componentName),
  componentSchema,
);
export type Components = z.infer<typeof componentsSchema>;
export const propNames = ['Variant', 'State', 'Size'] as const;

// Fichier d'échange préparé par l'agent depuis Figma (references/composants-figma.md),
// importé dans l'atelier comme une proposition : diff puis validation.
export const componentsFileSchema = z
  .object({
    format: z.literal('ds-studio-components/1'),
    source: z.string().max(200).optional(),
    components: componentsSchema,
  })
  .strict();
export const isComponentsFile = (input: unknown) =>
  !!input &&
  typeof input === 'object' &&
  (input as { format?: unknown }).format === 'ds-studio-components/1';
