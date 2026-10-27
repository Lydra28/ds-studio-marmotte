import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isV1Tokens, migrateV1Tokens, tokenSetSchema } from '../shared/model.js';
import { configSchema, figmaFileKey, type Config } from '../shared/project.js';
import { componentsSchema } from '../shared/components.js';
import { Store, StudioError } from './store.js';
import { ProjectStore } from './project.js';
import { atomicWrite } from './files.js';
import { listVersions } from './versions.js';
import { Assistant, assistantFromEnv, type AssistantOptions } from './assistant.js';
import { Wall } from './wall.js';

// Une instance = un dossier projet : seed, configuration, versions acceptées,
// et ses données privées dans `.ds-studio/` (état, journal, brief).
export interface Instance {
  slug: string;
  dir: string;
  config: Config;
  store: Store;
  brief: ProjectStore;
  assistant: Assistant;
  wall: Wall;
}
export interface ProjectSummary {
  slug: string;
  name: string;
  revision: number;
  accepted: number | null;
  updatedAt: string;
}
export const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const newProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    doctrine: z.string().trim().max(8000).default(''),
    ideas: z.string().trim().max(4000).default(''),
    figmaUrl: z.string().trim().max(500).default(''),
  })
  .strict();

const readJson = (file: string) =>
  fs
    .readFile(file, 'utf8')
    .then(JSON.parse)
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });

export async function openInstance(
  slug: string,
  dir: string,
  dataDir: string,
  assistant: AssistantOptions = assistantFromEnv(),
): Promise<Instance> {
  const rawSeed = await readJson(path.join(dir, 'design-system.tokens.json'));
  if (!rawSeed) throw new StudioError('Projet sans design-system.tokens.json.', 500);
  const seed = isV1Tokens(rawSeed) ? migrateV1Tokens(rawSeed) : tokenSetSchema.parse(rawSeed);
  // Fiches de départ du projet, facultatives.
  const rawComponents = await readJson(path.join(dir, 'components.json'));
  if (rawComponents) seed.components = componentsSchema.parse(rawComponents);
  const config = configSchema.parse(
    (await readJson(path.join(dir, 'project.config.json'))) ?? { name: 'Lisière (exemple)' },
  );
  const store = new Store(dataDir, seed);
  await store.init();
  return {
    slug,
    dir,
    config,
    store,
    brief: new ProjectStore(dataDir),
    assistant: new Assistant(dataDir, assistant),
    wall: new Wall(dataDir, assistant),
  };
}

export const slugify = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'projet';

// Projets d'un dossier (`projects/`) ouverts à la demande, ou une seule instance
// fixe (`--project=`, tests) : la création est alors refusée.
export class Registry {
  private open = new Map<string, Promise<Instance>>();
  private constructor(
    private projectsDir: string | null,
    private template: string | null,
    readonly fallback: string,
    private assistant: AssistantOptions = assistantFromEnv(),
  ) {}
  static single(instance: Instance) {
    const r = new Registry(null, null, instance.slug);
    r.open.set(instance.slug, Promise.resolve(instance));
    return r;
  }
  static folder(projectsDir: string, template: string, fallback = 'marmotte', assistant?: AssistantOptions) {
    return new Registry(projectsDir, template, fallback, assistant);
  }
  get multi() {
    return this.projectsDir !== null;
  }
  private async slugs() {
    if (!this.projectsDir) return [...this.open.keys()];
    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    const found: string[] = [];
    for (const e of entries)
      if (
        e.isDirectory() &&
        slugSchema.safeParse(e.name).success &&
        (await fs.stat(path.join(this.projectsDir, e.name, 'design-system.tokens.json')).catch(() => null))
      )
        found.push(e.name);
    return found.sort();
  }
  async get(slug?: string) {
    const target = slug ?? this.fallback;
    if (!slugSchema.safeParse(target).success) throw new StudioError('Projet invalide.', 400);
    const cached = this.open.get(target);
    if (cached) return cached;
    if (!this.projectsDir || !(await this.slugs()).includes(target))
      throw new StudioError('Projet introuvable.', 404);
    const dir = path.join(this.projectsDir, target);
    const opening = openInstance(target, dir, path.join(dir, '.ds-studio'), this.assistant);
    this.open.set(target, opening);
    opening.catch(() => this.open.delete(target));
    return opening;
  }
  async list(): Promise<ProjectSummary[]> {
    const out: ProjectSummary[] = [];
    for (const slug of await this.slugs()) {
      try {
        const i = await this.get(slug);
        const versions = await listVersions(i.dir);
        const s = i.store.snapshot();
        out.push({
          slug,
          name: i.config.name,
          revision: s.revision,
          accepted: versions.length ? Math.max(...versions.map((v) => v.revision)) : null,
          updatedAt: s.history.at(-1)?.date ?? '',
        });
      } catch {
        // Projet illisible : il reste sur disque, intact, mais n'est pas listé.
      }
    }
    return out;
  }
  async create(input: z.input<typeof newProjectSchema>) {
    if (!this.projectsDir || !this.template)
      throw new StudioError('Création de projet indisponible dans cette instance.', 403);
    const p = newProjectSchema.parse(input);
    const fileKey = p.figmaUrl ? figmaFileKey(p.figmaUrl) : null;
    if (p.figmaUrl && !fileKey)
      throw new StudioError('Lien Figma attendu : https://www.figma.com/design/<fichier>/…');
    const taken = new Set(await this.slugs());
    const base = slugify(p.name);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, 36)}-${n}`;
    const dir = path.join(this.projectsDir, slug);
    await fs.mkdir(dir, { recursive: false });
    const config: Config = {
      name: p.name,
      figma: fileKey ? { fileKey, page: 'DS-Studio · Foundations', protectedPages: [] } : null,
    };
    await atomicWrite(path.join(dir, 'project.config.json'), JSON.stringify(config, null, 2) + '\n');
    await fs.copyFile(this.template, path.join(dir, 'design-system.tokens.json'));
    const instance = await this.get(slug);
    const brief = await instance.brief.read();
    await instance.brief.save(brief.base, {
      ...brief.project,
      name: p.name,
      doctrine: p.doctrine,
      ideas: p.ideas,
      figmaUrl: p.figmaUrl,
    });
    return slug;
  }
  async flush() {
    for (const opening of this.open.values()) await (await opening).store.flush();
  }
}
