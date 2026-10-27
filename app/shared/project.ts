import { z } from 'zod';
export const projectSchema = z
  .object({
    name: z.string().trim().max(100).default(''),
    audience: z.string().trim().max(1000).default(''),
    goal: z.string().trim().max(2000).default(''),
    // Doctrine du projet et premières idées : contexte de l'assistant.
    doctrine: z.string().trim().max(8000).default(''),
    ideas: z.string().trim().max(4000).default(''),
    figmaUrl: z
      .union([
        z.literal(''),
        z
          .string()
          .url()
          .max(500)
          .refine((value) => {
            const url = new URL(value);
            return (
              url.protocol === 'https:' &&
              url.hostname === 'www.figma.com' &&
              !url.username &&
              !url.password
            );
          }, 'Lien https://www.figma.com/ attendu, sans identifiants.'),
      ])
      .default(''),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
// Clé d'un fichier Figma depuis son lien (design, file, board…).
export const figmaFileKey = (url: string) =>
  /^https:\/\/www\.figma\.com\/(?:design|file)\/([0-9a-zA-Z]{22,128})(?:[/?#]|$)/.exec(url)?.[1] ?? null;
export interface ProjectSnapshot {
  project: Project;
  base: string;
}

// Configuration versionnée d'une instance (`projects/<nom>/project.config.json`).
// La cible Figma n'est utilisée que par l'agent de transfert, jamais par l'application.
export const configSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    figma: z
      .object({
        fileKey: z.string().regex(/^[0-9a-zA-Z]{22,128}$/),
        page: z.string().trim().min(1).max(100),
        protectedPages: z.array(z.string().max(100)).max(20).default([]),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
