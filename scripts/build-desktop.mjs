// Serveur de l'app desktop : un seul fichier ESM minifié pour le Node d'Electron.
// Playwright reste externe : dans l'app, les captures passent par Electron.
// Écrit aussi desktop/build/update.json, le flux de mise à jour lu par
// desktop/main.mjs : DS_STUDIO_UPDATE_URL (https, dossier du canal),
// DS_STUDIO_UPDATE_CHANNEL (stable par défaut), DS_STUDIO_MAC_SIGNED=1 quand
// l'app Mac est signée. Sans URL : mises à jour désactivées, affiché dans Réglages.
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';

await build({
  entryPoints: ['app/server/index.ts'],
  outfile: 'desktop/build/server.mjs',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Vite ne sert qu'au mode --dev, jamais dans l'app.
  external: ['@playwright/test', 'vite'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
const update = {
  url: process.env.DS_STUDIO_UPDATE_URL || null,
  channel: process.env.DS_STUDIO_UPDATE_CHANNEL || 'stable',
  macSigned: process.env.DS_STUDIO_MAC_SIGNED === '1',
};
await fs.writeFile('desktop/build/update.json', JSON.stringify(update, null, 2) + '\n');
console.log(`desktop/build/server.mjs prêt · mises à jour : ${update.url ? `${update.url} (${update.channel})` : 'désactivées'}`);
