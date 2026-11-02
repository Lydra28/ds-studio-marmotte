import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, openInstance } from './registry.js';
import { createStudioServer } from './http.js';
import { loadPluginCode } from './plugin.js';
import { createSiteRelay } from './site-relay.js';
import { acquireLease } from '../../scripts/runtime.mjs';
import { desktopReady, onDesktopStop } from './desktop.js';
import { AccountClient } from './account.js';

// L'app Electron donne la racine (serveur compilé en un seul fichier) et le
// chemin du `.env` (dans les réglages de l'utilisateur, jamais dans l'exe).
const root = process.env.DS_STUDIO_ROOT
  ? path.resolve(process.env.DS_STUDIO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// `--projects=projects` : tous les projets d'un dossier, choisis dans l'atelier.
// `--project=projects/x` : une seule instance. Sinon l'exemple d'origine dans
// workspace/, avec ses données dans .ds-studio/.
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const projectsArg = arg('projects') ?? process.env.DS_STUDIO_PROJECTS;
const projectArg = arg('project') ?? process.env.DS_STUDIO_PROJECT;
const projectsDir = projectsArg ? path.resolve(root, projectsArg) : null;
const projectDir = projectArg
  ? path.resolve(root, projectArg)
  : path.join(root, 'workspace');
const directory = process.env.DS_STUDIO_DATA_DIR
  ? path.resolve(process.env.DS_STUDIO_DATA_DIR)
  : projectsDir
    ? path.join(projectsDir, '.ds-studio')
    : projectArg
      ? path.join(projectDir, '.ds-studio')
      : path.join(root, '.ds-studio');
// Secrets locaux (jeton GitHub de la PR, usage avancé) : `.env` gitignoré, jamais renvoyé au navigateur.
try {
  process.loadEnvFile(process.env.DS_STUDIO_ENV_FILE || path.join(root, '.env'));
} catch {
  /* Pas de .env : rien d'obligatoire dedans. */
}
// Clé publique des licences (lot 3) : à côté des sources, ou copiée dans
// desktop/build/ par build-desktop.mjs. Sans elle, aucune licence ne serait
// vérifiable : refus de démarrer plutôt qu'un palier « Gratuit » à tort.
async function licensePublicKey() {
  for (const rel of ['server/license-public.pem', 'desktop/build/license-public.pem']) {
    try {
      return await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      /* pas ici */
    }
  }
  throw new Error('clé publique de licence introuvable (server/license-public.pem) : paquet incomplet.');
}
const port = Number(process.env.PORT ?? 4310);
let lease: Awaited<ReturnType<typeof acquireLease>> | undefined;
try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORT doit être un entier entre 1024 et 65535.');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink())
    throw new Error('Dossier de données symbolique refusé.');
  lease = await acquireLease(directory, 'server', { root, directory, port });
  // Compte DS-Studio (lot 3) : session dans le dossier des réglages de l'app
  // (DS_STUDIO_SETTINGS_DIR), sinon dans les données locales ; serveur de
  // production, sauf DS_STUDIO_API_URL (développement : `npm run dev:server`).
  const account = await AccountClient.open({
    dir: process.env.DS_STUDIO_SETTINGS_DIR ? path.resolve(process.env.DS_STUDIO_SETTINGS_DIR) : directory,
    apiUrl: process.env.DS_STUDIO_API_URL,
    publicKey: await licensePublicKey(),
  });
  account.start();
  void account.refresh();
  const registry = projectsDir
    ? Registry.folder(projectsDir, path.join(root, 'templates/blank/design-system.tokens.json'), 'marmotte', { account })
    : Registry.single(await openInstance(path.basename(projectDir) === 'workspace' ? 'exemple' : path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-'), projectDir, directory, { account }));
  const label = projectsDir ? 'projets' : (await registry.get()).config.name;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    account.stop();
    for (const relay of relays) relay.close();
    await app.close();
    await registry.flush();
    await lease!.release();
    process.exit(0);
  };
  // Relais « Site en direct » : port de l'atelier + 10, en boucle locale
  // seulement (IPv4 et IPv6 : `<projet>.localhost` peut résoudre vers l'un ou l'autre).
  const relayPort = Number(process.env.DS_STUDIO_RELAY_PORT ?? port + 10);
  const relays = [createSiteRelay(registry, { atelier: `http://127.0.0.1:${port}` }), createSiteRelay(registry, { atelier: `http://127.0.0.1:${port}` })];
  const relayUp = (
    await Promise.all(
      relays.map(
        (relay, i) =>
          new Promise<boolean>((resolve) => {
            relay.once('error', () => resolve(false));
            relay.listen(relayPort, i ? '::1' : '127.0.0.1', () => resolve(true));
          }),
      ),
    )
  )[0];
  // Vue Réglages : version et nom donnés par l'app Electron, sinon ceux du dépôt.
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version?: string };
  const app = await createStudioServer({
    root,
    registry,
    dev: process.argv.includes('--dev'),
    relayPort: relayUp ? relayPort : undefined,
    pluginCode: await loadPluginCode(directory),
    account,
    settings: {
      version: process.env.DS_STUDIO_APP_VERSION || pkg.version || '0.0.0',
      appName: process.env.DS_STUDIO_APP_NAME || 'DS-Studio',
      projects: projectsDir,
    },
    control: {
      record: lease.record,
      stop: () => {
        void stop();
      },
    },
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, '127.0.0.1', () => resolve());
  });
  console.log(
    `DS-Studio · ${label} · http://127.0.0.1:${port}\nMode manuel autonome · Figma non connecté · Ctrl+C pour fermer.`,
  );
  onDesktopStop(() => void stop());
  desktopReady(port);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (e) {
  if (lease) await lease.release().catch(() => {});
  console.error(
    'DS-Studio : ' +
      ((e as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? 'port occupé. Fermez l’autre serveur ou définissez PORT.'
        : (e as Error).message),
  );
  process.exit(1);
}
