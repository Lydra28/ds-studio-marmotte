import type http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';
import type { Registry } from './registry.js';
import { listVersions } from './versions.js';
import { buildFigmaPayload } from './figma-payload.js';
import { componentsFromFigma, rawComponentsSchema } from './figma-components.js';
import { componentsFileSchema } from '../shared/components.js';
import { askSchema } from './assistant.js';
import type { Config } from '../shared/project.js';

// Routes du plugin Figma DS-Studio (`/api/plugin/*`). Le plugin tourne dans
// Figma (origine `null`) : pas de cookie ni de jeton de session, mais un code
// d'appairage affiché dans l'atelier et collé une fois dans le plugin.
// Le plugin lit une version acceptée et renvoie des fiches ; il n'écrit
// jamais le jeu : les fiches reçues attendent un import par diff. Il peut
// désigner le fichier ouvert comme cible d'un projet qui n'en a pas, noter la
// remise à zéro de ce fichier, et poser une question à l'assistant (texte).

// Contrat entre l'atelier et le plugin : le plugin envoie son numéro
// (`X-DS-Plugin-Contract`, constante `CONTRACT` de `figma-plugin/ui.html`) ;
// un écart donne un 426 qui dit quoi mettre à jour. Incrémenter ici et dans
// le plugin à chaque changement incompatible des routes ou des charges.
// v1 : plugin sans en-tête (versions de développement d'avant le 2026-10-30).
// v2 : lien de fichier collé dans le plugin, manifeste Community.
export const PLUGIN_CONTRACT = 2;

// Code d'appairage gardé dans le dossier de données (privé), stable d'un démarrage à l'autre.
export async function loadPluginCode(directory: string) {
  const file = path.join(directory, 'plugin.json');
  try {
    return z.object({ code: z.string().regex(/^[a-f0-9]{4}(-[a-f0-9]{4}){2}$/) }).parse(JSON.parse(await readPrivate(file))).code;
  } catch {
    const hex = randomBytes(6).toString('hex');
    const code = `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`;
    await atomicWrite(file, JSON.stringify({ code }) + '\n');
    return code;
  }
}

const inboxFile = (dataDir: string) => path.join(dataDir, 'figma-inbox.json');
export const inboxSchema = z.object({
  receivedAt: z.string(),
  report: z.array(z.string()),
  file: componentsFileSchema,
});
export type Inbox = z.infer<typeof inboxSchema>;
export async function readInbox(dataDir: string): Promise<Inbox | null> {
  try {
    return inboxSchema.parse(JSON.parse(await readPrivate(inboxFile(dataDir))));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
export const clearInbox = (dataDir: string) => fs.rm(inboxFile(dataDir), { force: true });

const transferSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    fileKey: z.string().regex(/^[0-9a-zA-Z]{22,128}$/),
    report: z
      .object({
        created: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
        extra: z.array(z.string().max(120)).max(500),
        components: z.array(z.string().max(120)).max(50),
        skipped: z.array(z.string().max(300)).max(100),
      })
      .strict(),
  })
  .strict();

const fileKeySchema = z.string().regex(/^[0-9a-zA-Z]{22,128}$/);
const resetSchema = z
  .object({
    fileKey: fileKeySchema,
    removed: z
      .object({
        collections: z.array(z.string().max(120)).max(20),
        variables: z.number().int().nonnegative(),
        page: z.string().max(100).nullable(),
        components: z.array(z.string().max(120)).max(50),
      })
      .strict(),
  })
  .strict();

// Remises à zéro du fichier cible, notées dans `versions/figma-reset.json`
// (hors liste des versions). Un reçu de transfert antérieur ne compte plus.
const resetFile = (dir: string) => path.join(dir, 'versions', 'figma-reset.json');
async function readResets(dir: string): Promise<{ date: string; fileKey: string }[]> {
  try {
    return JSON.parse(await readPrivate(resetFile(dir)));
  } catch {
    return [];
  }
}
// Le fichier a-t-il reçu un transfert depuis sa dernière remise à zéro ? Sert
// à reconnaître les collections écrites avant le marquage par le plugin.
async function knownFile(dir: string, fileKey: string | undefined) {
  if (!fileKey) return false;
  const reset = (await readResets(dir)).filter((r) => r.fileKey === fileKey).at(-1)?.date ?? '';
  const names = await fs.readdir(path.join(dir, 'versions')).catch(() => [] as string[]);
  for (const name of names.filter((n) => /^v\d+\.transfer\.json$/.test(n)))
    try {
      const r = JSON.parse(await readPrivate(path.join(dir, 'versions', name)));
      if (r.fileKey === fileKey && r.date > reset) return true;
    } catch {
      /* Reçu illisible : ignoré. */
    }
  return false;
}

async function readBody(req: http.IncomingMessage, limit: number) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new StudioError('JSON requis.', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new StudioError('Requête trop volumineuse.', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new StudioError('JSON invalide.');
  }
}

export async function handlePlugin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: { registry: Registry; code: string | null; send: (status: number, value: unknown) => void },
) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DS-Plugin, X-DS-Plugin-Contract');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // Figma (site public) vers 127.0.0.1 : accès au réseau privé à autoriser explicitement.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!ctx.code) throw new StudioError('Plugin Figma désactivé pour ce serveur.', 404);
  const given = Buffer.from(String(req.headers['x-ds-plugin'] ?? ''));
  const expected = Buffer.from(ctx.code);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    throw new StudioError('Code d’appairage invalide : recopie celui affiché dans l’atelier (bouton Figma).', 401);
  // Contrat : vérifié après le code (rien n'est dit à qui n'est pas appairé).
  const contract = Number(req.headers['x-ds-plugin-contract'] ?? 1);
  if (!Number.isInteger(contract) || contract < PLUGIN_CONTRACT)
    throw new StudioError(
      `Plugin DS-Studio trop ancien (contrat v${contract}, l’atelier attend v${PLUGIN_CONTRACT}) : mets-le à jour depuis la Community (Figma → Plugins → DS-Studio), ou réimporte figma-plugin/manifest.json en développement. Rien n’a été modifié.`,
      426,
    );
  if (contract > PLUGIN_CONTRACT)
    throw new StudioError(
      `Atelier DS-Studio trop ancien pour ce plugin (contrat v${contract}, l’atelier connaît v${PLUGIN_CONTRACT}) : mets à jour DS-Studio (Réglages → Rechercher une mise à jour). Rien n’a été modifié.`,
      426,
    );

  const instance = () => ctx.registry.get(url.searchParams.get('project') ?? undefined);
  // Version acceptée avant que le projet ait une cible : elle prend la cible
  // désignée depuis (réaccepter le même contenu rendrait la même version).
  // Une cible qui change après acceptation reste refusée plus bas.
  const latest = async (dir: string, config: Config) => {
    const [last] = await listVersions(dir);
    if (!last) throw new StudioError('Aucune version acceptée : accepte une version dans l’atelier.', 409);
    const raw = JSON.parse(await readPrivate(path.join(dir, 'versions', last.file)));
    return { last, raw: raw.target == null && config.figma ? { ...raw, target: config.figma } : raw };
  };

  if (req.method === 'GET' && url.pathname === '/api/plugin/projects') {
    const list = await ctx.registry.list();
    return ctx.send(
      200,
      await Promise.all(
        list.map(async (p) => {
          const { dir, config, assistant } = await ctx.registry.get(p.slug);
          const [last] = await listVersions(dir);
          return {
            slug: p.slug,
            name: p.name,
            figma: config.figma,
            version: last ?? null,
            known: await knownFile(dir, config.figma?.fileKey),
            assistant: assistant.status.enabled,
          };
        }),
      ),
    );
  }
  if (req.method === 'GET' && url.pathname === '/api/plugin/payload') {
    const { dir, config } = await instance();
    const { last, raw } = await latest(dir, config);
    const payload = buildFigmaPayload(raw);
    if (payload.target?.fileKey !== config.figma?.fileKey)
      throw new StudioError('La cible Figma de la version ne correspond plus à celle du projet : transfert refusé.', 409);
    let transferred: unknown = null;
    try {
      transferred = JSON.parse(await readPrivate(path.join(dir, 'versions', `v${last.revision}.transfer.json`)));
    } catch {
      /* Jamais transférée. */
    }
    const reset = (await readResets(dir)).filter((r) => r.fileKey === config.figma?.fileKey).at(-1);
    if (transferred && reset && (transferred as { date: string }).date <= reset.date) transferred = null;
    return ctx.send(200, { ...payload, transferred });
  }
  if (req.method === 'POST' && url.pathname === '/api/plugin/transfer') {
    const { dir, config } = await instance();
    const b = transferSchema.parse(await readBody(req, 128_000));
    const { last, raw } = await latest(dir, config);
    const payload = buildFigmaPayload(raw);
    if (b.revision !== last.revision || b.hash !== payload.hash || b.fileKey !== payload.target?.fileKey)
      throw new StudioError('Le transfert ne correspond pas à la dernière version acceptée : reçu refusé.', 409);
    const receipt = { date: new Date().toISOString(), revision: b.revision, hash: b.hash, fileKey: b.fileKey, page: payload.target.page, by: 'plugin', ...b.report };
    await atomicWrite(path.join(dir, 'versions', `v${b.revision}.transfer.json`), JSON.stringify(receipt, null, 2) + '\n');
    return ctx.send(200, receipt);
  }
  // Fichier ouvert désigné comme cible : seulement pour un projet sans cible,
  // et un fichier qui n'est la cible d'aucun autre projet. Changer une cible
  // existante se fait dans le fichier de configuration, pas depuis Figma.
  if (req.method === 'POST' && url.pathname === '/api/plugin/target') {
    const target = await instance();
    const { fileKey } = z.object({ fileKey: fileKeySchema }).strict().parse(await readBody(req, 4_000));
    if (target.config.figma)
      throw new StudioError(`${target.config.name} a déjà un fichier cible : rien n’a été changé.`, 409);
    for (const p of await ctx.registry.list()) {
      const other = await ctx.registry.get(p.slug);
      if (other.config.figma?.fileKey === fileKey)
        throw new StudioError(`Ce fichier est déjà la cible de ${other.config.name} : rien n’a été changé.`, 409);
    }
    const figma = { fileKey, page: 'DS-Studio · Foundations', protectedPages: [] };
    await atomicWrite(path.join(target.dir, 'project.config.json'), JSON.stringify({ ...target.config, figma }, null, 2) + '\n');
    target.config.figma = figma;
    return ctx.send(200, { figma });
  }
  if (req.method === 'POST' && url.pathname === '/api/plugin/reset') {
    const { dir, config } = await instance();
    const b = resetSchema.parse(await readBody(req, 32_000));
    if (b.fileKey !== config.figma?.fileKey)
      throw new StudioError('Ce fichier n’est pas la cible du projet : remise à zéro non notée.', 409);
    const resets = await readResets(dir);
    const entry = { date: new Date().toISOString(), by: 'plugin', ...b };
    await fs.mkdir(path.join(dir, 'versions'), { recursive: true });
    await atomicWrite(resetFile(dir), JSON.stringify([...resets, entry].slice(-50), null, 2) + '\n');
    return ctx.send(200, entry);
  }
  if (req.method === 'POST' && url.pathname === '/api/plugin/components') {
    const { store } = await instance();
    const raw = rawComponentsSchema.parse(await readBody(req, 2_000_000));
    const set = store.snapshot().set;
    const { file, report } = componentsFromFigma(raw, new Set(Object.keys(set.components ?? {})), new Set(Object.keys(set.tokens)));
    const inbox: Inbox = { receivedAt: new Date().toISOString(), report, file };
    await atomicWrite(inboxFile(store.directory), JSON.stringify(inbox, null, 2) + '\n');
    return ctx.send(200, { count: Object.keys(file.components).length, report });
  }
  // Question à l'assistant depuis Figma : texte seulement, rien d'écrit. La
  // sélection n'arrive que si Romain a coché son envoi dans le plugin.
  if (req.method === 'POST' && url.pathname === '/api/plugin/ask') {
    const { config, store, brief, assistant } = await instance();
    const b = askSchema.parse(await readBody(req, 200_000));
    return ctx.send(200, await assistant.ask(b, { project: (await brief.read()).project, name: config.name, set: store.snapshot().set }));
  }
  throw new StudioError('Route inconnue.', 404);
}
