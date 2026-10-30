import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { proposeSchema } from '../shared/model.js';
import { Store, StudioError } from './store.js';
import { ProjectStore } from './project.js';
import { projectSchema, type Config } from '../shared/project.js';
import { Registry, newProjectSchema } from './registry.js';
import { Assistant, chatSchema } from './assistant.js';
import { Wall, directionsRequestSchema, imageSchema, linkSchema } from './wall.js';
import { acceptVersion, listVersions, readVersion } from './versions.js';
import { clearInbox, handlePlugin, readInbox } from './plugin.js';
import { githubFromEnv, publishVersion, type GithubOptions } from './github.js';
import { atomicWrite } from './files.js';
import { figmaStatus } from '../../connectors/figma/contract.js';
import { inDesktop, requestDesktop, updateState } from './desktop.js';
import type { RecordInfo } from '../../scripts/runtime.mjs';

// Vue Réglages : ce que l'app sait d'elle-même, sans jamais une valeur de secret.
export interface SettingsInfo {
  version: string;
  appName: string;
  // Dossier des projets (null pour une instance fixe `--project=`).
  projects: string | null;
  services: { assistant: boolean };
}
const desktopActionSchema = z
  .object({ action: z.enum(['choose-projects', 'check-update', 'install-update']) })
  .strict();

export async function createStudioServer(
  options: {
    root: string;
    dev?: boolean;
    // Code d'appairage du plugin Figma ; absent : routes du plugin fermées.
    pluginCode?: string;
    // Accès GitHub (jeton, fetch simulé en test) ; par défaut GITHUB_TOKEN de .env.
    github?: GithubOptions;
    // Port du relais « Site en direct » (site-relay.ts) ; absent : pas de site.
    relayPort?: number;
    control?: { record: RecordInfo; stop: () => void };
    settings?: SettingsInfo;
  } & (
    | { registry: Registry }
    | { store: Store; projectDir: string; config: Config }
  ),
) {
  const { root } = options;
  // Une instance fixe (tests, --project=) reste servie comme un registre d'un seul projet.
  const registry =
    'registry' in options
      ? options.registry
      : Registry.single({
          slug: 'projet',
          dir: options.projectDir,
          config: options.config,
          store: options.store,
          brief: new ProjectStore(options.store.directory),
          assistant: new Assistant(options.store.directory, {}),
          wall: new Wall(options.store.directory, {}),
        });
  const csrf = randomBytes(32).toString('hex');
  const github = options.github ?? githubFromEnv();
  // Version acceptée → pull request sur le code du projet ; un échec GitHub
  // n'annule jamais l'acceptation, il est rendu avec la version.
  const publish = async (projectDir: string, config: Config, revision: number) => {
    if (!config.github) return null;
    try {
      const v = await readVersion(projectDir, revision);
      const result = await publishVersion(github, config.github, { project: config.name, revision, hash: v.hash, set: v.set });
      await atomicWrite(
        path.join(projectDir, 'versions', `v${revision}.github.json`),
        JSON.stringify({ date: new Date().toISOString(), repo: config.github.repo, ...result }, null, 2) + '\n',
      );
      return result;
    } catch (e) {
      return { status: 'error' as const, message: (e as Error).message };
    }
  };
  const vite = options.dev
    ? await (
        await import('vite')
      ).createServer({
        root,
        server: { middlewareMode: true, host: '127.0.0.1' },
        appType: 'spa',
      })
    : null;
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    const send = (status: number, value: unknown) => {
      if (!res.destroyed) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify(value));
      }
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'${options.dev ? ' ws://127.0.0.1:*' : ''}; frame-src 'self'${options.relayPort ? ` http://*.localhost:${options.relayPort}` : ''}; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`,
    );
    try {
      // Plugin Figma : origine `null`, protégé par son code d'appairage (plugin.ts).
      // Figma refuse une adresse IP dans le manifeste : le plugin passe par
      // `localhost`, accepté pour ces routes seulement.
      const pluginUrl = new URL(req.url ?? '/', origin);
      const pluginRoute = pluginUrl.pathname.startsWith('/api/plugin/');
      if (req.headers.host !== `127.0.0.1:${port}` && !(pluginRoute && req.headers.host === `localhost:${port}`))
        throw new StudioError(
          'Hôte refusé. Utilisez l’adresse 127.0.0.1 affichée au démarrage.',
          403,
        );
      if (pluginRoute)
        return await handlePlugin(req, res, pluginUrl, { registry, code: options.pluginCode ?? null, send });
      if (req.headers.origin && req.headers.origin !== origin)
        throw new StudioError('Origine non autorisée.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new StudioError('Requête externe refusée.', 403);
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname.startsWith('/_studio/')) {
        const control = options.control;
        if (
          !control ||
          req.headers['x-studio-control'] !== control.record.token
        )
          throw new StudioError('Contrôle privé refusé.', 403);
        const { token: _token, ...identity } = control.record;
        if (url.pathname === '/_studio/health' && req.method === 'GET')
          return send(200, identity);
        if (url.pathname === '/_studio/stop' && req.method === 'POST') {
          send(200, identity);
          setImmediate(control.stop);
          return;
        }
        throw new StudioError('Route inconnue.', 404);
      }
      if (url.pathname.startsWith('/api/')) {
        // Projet visé : en-tête X-DS-Project (ou ?project= pour une image), sinon le projet par défaut.
        const header = req.headers['x-ds-project'] ?? url.searchParams.get('project') ?? undefined;
        const instance = () => registry.get(typeof header === 'string' ? header : undefined);
        if (req.method === 'GET') {
          if (url.pathname === '/api/bootstrap')
            return send(200, {
              csrf,
              figma: figmaStatus,
              multi: registry.multi,
              fallback: registry.fallback,
              plugin: options.pluginCode ?? null,
              github: !!github.token,
              relay: options.relayPort ?? null,
              desktop: inDesktop,
            });
          if (url.pathname === '/api/projects') return send(200, await registry.list());
          if (url.pathname === '/api/settings')
            return send(200, {
              desktop: inDesktop,
              app: { name: options.settings?.appName ?? 'DS-Studio', version: options.settings?.version ?? '0.0.0' },
              projects: options.settings?.projects ?? null,
              update: updateState(),
              services: {
                assistant: options.settings?.services.assistant ?? false,
                github: !!github.token,
                relay: !!options.relayPort,
                plugin: !!options.pluginCode,
              },
            });
          const { store, dir: projectDir, config, brief: project, assistant, wall } = await instance();
          if (url.pathname === '/api/config') return send(200, config);
          if (url.pathname === '/api/wall') return send(200, { ...(await wall.read()), enabled: assistant.status.enabled });
          if (url.pathname === '/api/wall/file') {
            const file = await wall.file(z.string().uuid().parse(url.searchParams.get('id')));
            res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'private, max-age=3600' });
            res.end(file.data);
            return;
          }
          if (url.pathname === '/api/assistant')
            return send(200, { ...assistant.status, messages: await assistant.history() });
          if (url.pathname === '/api/inbox') return send(200, await readInbox(store.directory));
          if (url.pathname === '/api/versions')
            return send(200, await listVersions(projectDir));
          if (url.pathname === '/api/version') {
            const revision = Number(z.string().regex(/^\d{1,9}$/).parse(url.searchParams.get('revision')));
            return send(200, await readVersion(projectDir, revision));
          }
          if (url.pathname === '/api/project')
            return send(200, await project.read());
          if (url.pathname === '/api/state') return send(200, store.snapshot());
          if (url.pathname === '/api/export')
            return send(200, store.snapshot().set);
          throw new StudioError('Route inconnue.', 404);
        }
        if (req.method !== 'POST')
          throw new StudioError('Méthode non autorisée.', 405);
        if (req.headers['x-ds-studio'] !== csrf)
          throw new StudioError(
            'Validation de session manquante. Rechargez la page.',
            403,
          );
        if (!req.headers['content-type']?.startsWith('application/json'))
          throw new StudioError('JSON requis.', 415);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          const max =
            url.pathname === '/api/wall/image' ? 5_200_000 : url.pathname === '/api/proposals' ? 512_000 : 128_000;
          if (size > max)
            throw new StudioError('Requête trop volumineuse.', 413);
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new StudioError('JSON invalide.');
        }
        if (url.pathname === '/api/projects')
          return send(200, { slug: await registry.create(newProjectSchema.parse(body)) });
        if (url.pathname === '/api/desktop') {
          // Réglages : l'app Electron exécute (dialogue de dossier, mise à jour) ; hors de l'app, rien.
          if (!inDesktop) throw new StudioError('Disponible dans l’app DS-Studio installée seulement.', 409);
          requestDesktop(desktopActionSchema.parse(body).action);
          return send(200, { ok: true });
        }
        const { store, dir: projectDir, config, brief: project, assistant, wall } = await instance();
        if (url.pathname === '/api/wall/image') return send(200, await wall.addImage(imageSchema.parse(body)));
        if (url.pathname === '/api/wall/link') return send(200, await wall.addLink(linkSchema.parse(body).url));
        if (url.pathname === '/api/wall/remove') {
          await wall.remove(z.object({ id: z.string().uuid() }).strict().parse(body).id);
          return send(200, await wall.read());
        }
        if (url.pathname === '/api/wall/directions')
          return send(
            200,
            await wall.directions(directionsRequestSchema.parse(body), {
              project: (await project.read()).project,
              name: config.name,
              set: store.snapshot().set,
            }),
          );
        if (url.pathname === '/api/assistant/chat') {
          const b = chatSchema.parse(body);
          const messages = await assistant.chat(b.message, {
            project: (await project.read()).project,
            name: config.name,
            set: store.snapshot().set,
          });
          return send(200, { messages });
        }
        if (url.pathname === '/api/assistant/reset') {
          await assistant.reset();
          return send(200, { messages: [] });
        }
        if (url.pathname === '/api/project') {
          const b = z
            .object({ base: z.string().max(64), project: projectSchema })
            .strict()
            .parse(body);
          return send(200, await project.save(b.base, b.project));
        }
        if (url.pathname === '/api/proposals') {
          const b = proposeSchema.parse(body);
          return send(200, store.propose(b.revision, b.changes));
        }
        if (url.pathname === '/api/inbox/clear') {
          await clearInbox(store.directory);
          return send(200, null);
        }
        if (url.pathname === '/api/import') {
          const b = z
            .object({
              revision: z.number().int().nonnegative(),
              tokens: z.unknown(),
            })
            .strict()
            .parse(body);
          return send(200, store.proposeImport(b.revision, b.tokens));
        }
        if (url.pathname === '/api/undo') {
          const b = z
            .object({
              revision: z.number().int().nonnegative(),
              id: z.string().uuid(),
            })
            .strict()
            .parse(body);
          return send(200, store.proposeUndo(b.revision, b.id));
        }
        if (url.pathname === '/api/commit') {
          const b = z.object({ id: z.string().uuid() }).strict().parse(body);
          return send(200, await store.commit(b.id));
        }
        if (url.pathname === '/api/accept') {
          const b = z
            .object({ revision: z.number().int().nonnegative() })
            .strict()
            .parse(body);
          await store.flush();
          const version = await acceptVersion(projectDir, config, store.snapshot(), b.revision);
          return send(200, { ...version, github: await publish(projectDir, config, version.revision) });
        }
        if (url.pathname === '/api/github/publish') {
          const b = z.object({ revision: z.number().int().nonnegative() }).strict().parse(body);
          if (!config.github) throw new StudioError('Ce projet n’a pas de dépôt GitHub configuré.', 409);
          return send(200, await publish(projectDir, config, b.revision));
        }
        throw new StudioError('Route inconnue.', 404);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        throw new StudioError('Méthode non autorisée.', 405);
      if (vite) {
        const allowed = [
          '/app/client/',
          '/app/shared/',
          '/node_modules/',
          '/@vite/',
          '/@id/',
        ];
        if (
          url.pathname !== '/' &&
          url.pathname !== '/index.html' &&
          !allowed.some((prefix) => url.pathname.startsWith(prefix))
        )
          throw new StudioError('Source privée non distribuée.', 403);
        vite.middlewares(req, res);
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('..') || pathname.includes('\\'))
        throw new StudioError('Chemin refusé.', 403);
      let file: string;
      if (pathname.startsWith('/assets/'))
        file = path.join(root, 'dist', pathname);
      else if (pathname === '/' || pathname === '/index.html')
        file = path.join(root, 'dist', 'index.html');
      else throw new StudioError('Fichier introuvable.', 404);
      const data = await fs.readFile(file);
      const ext = path.extname(file);
      res.setHeader(
        'Content-Type',
        (
          {
            '.html': 'text/html; charset=utf-8',
            '.js': 'text/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.svg': 'image/svg+xml',
          } as Record<string, string>
        )[ext] ?? 'application/octet-stream',
      );
      res.end(data);
    } catch (error) {
      if (error instanceof z.ZodError)
        return send(400, {
          error:
            'Données invalides : ' +
            error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
        });
      if (error instanceof StudioError)
        return send(error.status, { error: error.message });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return send(404, {
          error: 'Fichier introuvable. Exécutez npm run build avant npm start.',
        });
      return send(500, { error: urlSafeMessage(error) });
    }
  });
  server.requestTimeout = 15000;
  let closing: Promise<void> | undefined;
  server.headersTimeout = 10000;
  return {
    server,
    close: () =>
      (closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
        // Un onglet peut retenir un socket (requête inachevée, préconnexion) :
        // server.close() attendrait requestTimeout et l'arrêt dépasserait les
        // 10 s accordées par le lanceur (Ubuntu en CI, 2026-10-30). Au-delà de
        // 2 s, les connexions restantes sont coupées ; l'onglet renouvelle sa
        // session sur le serveur suivant.
        const cutoff = setTimeout(() => server.closeAllConnections(), 2000);
        try {
          await closed;
        } finally {
          clearTimeout(cutoff);
        }
        await vite?.close();
      })()),
  };
}
function urlSafeMessage(error: unknown) {
  // Seuls les messages métier connus remontent, jamais de stack.
  const message = (error as Error).message ?? '';
  if (
    /^(Token inconnu|Token déjà existant|Token utilisé|Composant inconnu|Mode inconnu|Un token ne peut|Alias circulaire)/.test(message)
  )
    return message;
  return 'Opération impossible. Aucune validation automatique. Vérifiez les données et relancez si nécessaire.';
}
