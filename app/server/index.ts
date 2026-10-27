import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, openInstance } from './registry.js';
import { createStudioServer } from './http.js';
import { acquireLease } from '../../scripts/runtime.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
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
// Secrets locaux (clé OpenRouter) : `.env` gitignoré, jamais renvoyé au navigateur.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  /* Pas de .env : assistant désactivé, le reste de l'atelier marche. */
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
  const registry = projectsDir
    ? Registry.folder(projectsDir, path.join(root, 'templates/blank/design-system.tokens.json'))
    : Registry.single(await openInstance(path.basename(projectDir) === 'workspace' ? 'exemple' : path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-'), projectDir, directory));
  const label = projectsDir ? 'projets' : (await registry.get()).config.name;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await registry.flush();
    await lease!.release();
    process.exit(0);
  };
  const app = await createStudioServer({
    root,
    registry,
    dev: process.argv.includes('--dev'),
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
