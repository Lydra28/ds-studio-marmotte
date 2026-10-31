// Bundle du serveur pour Render : `server/index.ts` et le code partagé
// (`app/shared`) en un fichier ESM Node 22, dépendances npm laissées
// externes (installées par `npm ci` dans server/). Même esbuild que le
// bundle desktop (scripts/build-desktop.mjs).
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'server/dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(out, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
console.log('Serveur bundlé : server/dist/index.mjs');
