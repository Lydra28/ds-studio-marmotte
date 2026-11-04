// Serveur des tests du site (lot 7) : build Astro hors ligne (catalogue de
// fixture, API factice inerte), puis service de site/dist avec les en-têtes
// de dist/_headers comme Cloudflare Pages. Aucun réseau : les appels à l'API
// sont simulés par page.route dans site.spec.ts.
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_PORT = 4330;
export const FAKE_API = 'http://127.0.0.1:4331';
// Chemins depuis studio/, quel que soit le dossier de lancement (preview de l'agent comprise).
const studio = fileURLToPath(new URL('../..', import.meta.url));
const root = path.join(studio, 'site');
const dist = path.join(root, 'dist');

execSync('npm run build', {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    SITE_CATALOG_FILE: path.join(studio, 'tests/site/catalog.json'),
    PUBLIC_API_URL: FAKE_API,
    PUBLIC_DOWNLOAD_URL: 'https://downloads.example/stable',
    PUBLIC_FIGMA_PLUGIN_URL: '',
  },
});

// Format _headers de Cloudflare Pages, limité au motif `/*` qu'écrit headers.mjs.
const headers = {};
for (const line of readFileSync(path.join(dist, '_headers'), 'utf8').split('\n').slice(1)) {
  const m = line.match(/^\s+([^:]+):\s*(.+)$/);
  if (m) headers[m[1]] = m[2];
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) file = dist;
    let status = 200;
    try {
      if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
      statSync(file);
    } catch {
      file = path.join(dist, '404.html');
      status = 404;
    }
    res.writeHead(status, { ...headers, 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  })
  .listen(SITE_PORT, '127.0.0.1', () => console.log(`site de test sur http://127.0.0.1:${SITE_PORT}`));
