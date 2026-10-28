import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../app/server/registry.js';
import { createSiteRelay, injectLive, liveScript } from '../app/server/site-relay.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('site en direct : relais en lecture seule du site configuré, script de l’atelier injecté', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-relay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const slug of ['vitrine', 'marmotte'])
    await cp(path.join(root, 'projects/marmotte/design-system.tokens.json'), path.join(dir, slug, 'design-system.tokens.json'));
  await writeFile(
    path.join(dir, 'vitrine', 'project.config.json'),
    JSON.stringify({ name: 'Vitrine', figma: null, github: null, site: { url: 'https://vitrine.example/', pages: ['/', '/projets'] } }),
  );
  await writeFile(path.join(dir, 'marmotte', 'project.config.json'), JSON.stringify({ name: 'Marmotte' }));
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'));

  // Faux site public : une page, une feuille, une redirection interne et une externe.
  const asked: string[] = [];
  const fakeFetch = (async (input: URL) => {
    asked.push(input.href);
    const page = (body: string, type = 'text/html; charset=utf-8', status = 200, extra: Record<string, string> = {}) =>
      new Response(body, { status, headers: { 'content-type': type, 'set-cookie': 'piste=1', 'x-frame-options': 'DENY', ...extra } });
    if (input.pathname === '/') return page('<html><head><title>V</title></head><body>Accueil</body></html>');
    if (input.pathname === '/_astro/site.css') return page(':root{--color-bg-canvas:#000}', 'text/css');
    if (input.pathname === '/ancien') return page('', 'text/plain', 301, { location: '/projets' });
    if (input.pathname === '/dehors') return page('', 'text/plain', 302, { location: 'https://ailleurs.example/' });
    return page('introuvable', 'text/plain', 404);
  }) as unknown as typeof fetch;

  const atelier = 'http://127.0.0.1:4310';
  const relay = createSiteRelay(registry, { atelier, fetch: fakeFetch });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const port = (relay.address() as { port: number }).port;
  const get = (route: string, host = `vitrine.localhost:${port}`, method = 'GET') =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) =>
      http
        .request({ host: '127.0.0.1', port, path: route, method, headers: { Host: host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject)
        .end(),
    );

  const home = await get('/');
  assert.equal(home.status, 200);
  assert.match(home.body, /<script src="\/__ds-studio\/live\.js"><\/script><\/head>/);
  assert.equal(home.headers['set-cookie'], undefined); // rien du site ne passe hors du contenu
  assert.equal(home.headers['x-frame-options'], undefined);
  assert.equal(home.headers['content-security-policy'], `frame-ancestors ${atelier}`);
  assert.equal(home.headers['cache-control'], 'no-store');

  const css = await get('/_astro/site.css');
  assert.equal(css.body, ':root{--color-bg-canvas:#000}');
  await get('/_astro/site.css');
  assert.equal(asked.filter((u) => u.endsWith('/_astro/site.css')).length, 1); // fichiers gardés en cache

  const live = await get('/__ds-studio/live.js');
  assert.match(live.body, /e\.origin !== atelier/);
  assert.match(live.body, /"http:\/\/127\.0\.0\.1:4310"/);

  assert.equal((await get('/ancien')).headers.location, '/projets');
  assert.equal((await get('/dehors')).status, 502); // redirection hors du site refusée
  assert.equal((await get('/inconnue')).status, 404);
  assert.equal((await get('/', `vitrine.localhost:${port}`, 'POST')).status, 405); // lecture seule
  assert.equal((await get('/', `127.0.0.1:${port}`)).status, 403);
  assert.equal((await get('/', `marmotte.localhost:${port}`)).status, 404); // pas de site configuré
  assert.equal((await get('/', `absent.localhost:${port}`)).status, 404);
  assert.ok(asked.every((u) => u.startsWith('https://vitrine.example/')));
});

test('site en direct : script injecté même sans <head>, origine de l’atelier seule écoutée', () => {
  assert.equal(injectLive('<p>x</p>'), '<script src="/__ds-studio/live.js"></script><p>x</p>');
  assert.match(liveScript('http://127.0.0.1:4310'), /document\.head\.appendChild\(style\)/);
});
