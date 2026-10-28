// Serveur de l'app desktop : un seul fichier ESM pour le Node d'Electron.
// Playwright reste externe : dans l'app, les captures passent par Electron.
import { build } from 'esbuild';

await build({
  entryPoints: ['app/server/index.ts'],
  outfile: 'desktop/build/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Vite ne sert qu'au mode --dev, jamais dans l'app.
  external: ['@playwright/test', 'vite'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('desktop/build/server.mjs prêt');
