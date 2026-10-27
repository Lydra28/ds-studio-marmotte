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

// Routes du plugin Figma DS-Studio (`/api/plugin/*`). Le plugin tourne dans
// Figma (origine `null`) : pas de cookie ni de jeton de session, mais un code
// d'appairage affiché dans l'atelier et collé une fois dans le plugin.
// Le plugin lit une version acceptée et renvoie des fiches ; il n'écrit
// jamais le jeu : les fiches reçues attendent un import par diff.

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DS-Plugin');
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

  const instance = () => ctx.registry.get(url.searchParams.get('project') ?? undefined);
  const latest = async (dir: string) => {
    const [last] = await listVersions(dir);
    if (!last) throw new StudioError('Aucune version acceptée : accepte une version dans l’atelier.', 409);
    return { last, raw: JSON.parse(await readPrivate(path.join(dir, 'versions', last.file))) };
  };

  if (req.method === 'GET' && url.pathname === '/api/plugin/projects') {
    const list = await ctx.registry.list();
    return ctx.send(
      200,
      await Promise.all(
        list.map(async (p) => {
          const { dir, config } = await ctx.registry.get(p.slug);
          const [last] = await listVersions(dir);
          return { slug: p.slug, name: p.name, figma: config.figma, version: last ?? null };
        }),
      ),
    );
  }
  if (req.method === 'GET' && url.pathname === '/api/plugin/payload') {
    const { dir, config } = await instance();
    const { last, raw } = await latest(dir);
    const payload = buildFigmaPayload(raw);
    if (payload.target?.fileKey !== config.figma?.fileKey)
      throw new StudioError('La cible Figma de la version ne correspond plus à celle du projet : transfert refusé.', 409);
    let transferred: unknown = null;
    try {
      transferred = JSON.parse(await readPrivate(path.join(dir, 'versions', `v${last.revision}.transfer.json`)));
    } catch {
      /* Jamais transférée. */
    }
    return ctx.send(200, { ...payload, transferred });
  }
  if (req.method === 'POST' && url.pathname === '/api/plugin/transfer') {
    const { dir } = await instance();
    const b = transferSchema.parse(await readBody(req, 128_000));
    const { last, raw } = await latest(dir);
    const payload = buildFigmaPayload(raw);
    if (b.revision !== last.revision || b.hash !== payload.hash || b.fileKey !== payload.target?.fileKey)
      throw new StudioError('Le transfert ne correspond pas à la dernière version acceptée : reçu refusé.', 409);
    const receipt = { date: new Date().toISOString(), revision: b.revision, hash: b.hash, fileKey: b.fileKey, page: payload.target.page, by: 'plugin', ...b.report };
    await atomicWrite(path.join(dir, 'versions', `v${b.revision}.transfer.json`), JSON.stringify(receipt, null, 2) + '\n');
    return ctx.send(200, receipt);
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
  throw new StudioError('Route inconnue.', 404);
}
