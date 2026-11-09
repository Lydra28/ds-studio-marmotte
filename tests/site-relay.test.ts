import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../app/server/registry.js';
import { applyPlan, createSiteRelay, injectLive, liveScript, planLookup, scrollbarCss } from '../app/server/site-relay.js';

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
  // Défilement lié : position bornée entre 0 et 1, écho coupé, envoyée à l'atelier seul.
  assert.match(liveScript('http://127.0.0.1:4310'), /Math\.min\(1, Math\.max\(0,/);
  assert.match(liveScript('http://127.0.0.1:4310'), /if \(Date\.now\(\) > quiet\) parent\.postMessage\(\{ type: 'ds-scroll'.*\}, atelier\)/);
  // Barres pixel de l'atelier : injectées dès le chargement, sans réafficher ce que le site cache.
  assert.match(liveScript('http://127.0.0.1:4310'), /ds-studio-scrollbars/);
  assert.match(scrollbarCss, /::-webkit-scrollbar-thumb\{/);
  assert.doesNotMatch(scrollbarCss, /scrollbar-width/);
});

test('site en direct (G4) : plan du dépôt appliqué au CSS et au HTML, JS intact, cache gardé, site brut à part', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-relay-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(root, 'projects/marmotte/design-system.tokens.json'), path.join(dir, 'vitrine', 'design-system.tokens.json'));
  await writeFile(
    path.join(dir, 'vitrine', 'project.config.json'),
    JSON.stringify({
      name: 'Vitrine',
      github: { repo: 'dev/vitrine', base: 'main', dir: '.', rename: {}, entry: null, source: 'repo', subdir: null },
      site: { url: 'https://vitrine.example/', pages: ['/'] },
    }),
  );
  const entry = (kind: 'color' | 'length' | 'font', property: string, value: string, normalized: string, token: string | null) => ({
    file: 'src/app.css', line: 1, col: 1, offset: 0, length: value.length, via: 'css', kind, property, value, normalized, token, gap: 0,
  });
  await mkdir(path.join(dir, 'vitrine', '.ds-studio', 'github'), { recursive: true });
  await writeFile(
    path.join(dir, 'vitrine', '.ds-studio', 'github', 'plan.json'),
    JSON.stringify({
      version: 2, date: '2026-11-09T10:00:00.000Z', repo: 'dev/vitrine', ref: 'main', subdir: null, commit: null, mode: 'attach',
      report: {}, tokens: [], truncated: false,
      entries: [
        entry('color', 'color', '#ff0000', '#FF0000', 'color/brand'),
        entry('color', 'color', '#ff0000', '#FF0000', 'color/brand'),
        entry('color', 'background', '#ff0000', '#FF0000', 'color/alert'),
        entry('length', 'padding', '16px', '16px', 'space/4'),
        entry('font', 'font-family', 'Inter, sans-serif', 'inter', 'font/family/body'),
        entry('color', 'color', '#123456', '#123456', null),
      ],
    }),
  );
  const registry = Registry.folder(dir, path.join(root, 'templates/blank/design-system.tokens.json'));
  const asked: string[] = [];
  const fakeFetch = (async (input: URL) => {
    asked.push(input.pathname);
    const page = (body: string, type: string) => new Response(body, { status: 200, headers: { 'content-type': type } });
    if (input.pathname === '/')
      return page(
        '<html><head><style>h1{color:#F00}</style></head><body><p style="padding: 1rem">x</p>' +
          '<script>el.innerHTML = \'<b style="color:#ff0000">\'</script></body></html>',
        'text/html; charset=utf-8',
      );
    if (input.pathname === '/site.css')
      return page('a{color:rgb(255,0,0);padding:16px;margin:16px;font-family:Inter, sans-serif !important;border:1px solid #ff0000}.x{color:#123456}:root{--brand:#ff0000}', 'text/css');
    if (input.pathname === '/app.js') return page('const c = "color:#ff0000";', 'text/javascript');
    return new Response('introuvable', { status: 404 });
  }) as unknown as typeof fetch;
  const relay = createSiteRelay(registry, { atelier: 'http://127.0.0.1:4310', fetch: fakeFetch });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const port = (relay.address() as { port: number }).port;
  const get = (route: string, host = `vitrine.localhost:${port}`) =>
    new Promise<{ headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) =>
      http
        .request({ host: '127.0.0.1', port, path: route, headers: { Host: host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ headers: res.headers, body }));
        })
        .on('error', reject)
        .end(),
    );

  const css = await get('/site.css');
  assert.equal(
    css.body,
    'a{color:var(--color-brand, rgb(255,0,0));padding:var(--space-4, 16px);margin:16px;' +
      'font-family:var(--font-family-body, Inter, sans-serif) !important;border:1px solid var(--color-brand, #ff0000)}' +
      '.x{color:#123456}:root{--brand:#ff0000}',
  ); // marge sans token de même propriété, couleur sans token et variable du site intactes
  assert.equal(css.headers['cache-control'], 'no-cache');
  assert.equal(Number(css.headers['content-length']), Buffer.byteLength(css.body));
  const home = await get('/');
  assert.match(home.body, /h1\{color:var\(--color-brand, #F00\)\}/);
  assert.match(home.body, /style="padding: var\(--space-4, 1rem\)"/);
  assert.match(home.body, /<b style="color:#ff0000">/); // script de la page jamais réécrit
  assert.match(home.body, /live\.js/);
  assert.equal((await get('/app.js')).body, 'const c = "color:#ff0000";');

  // Site brut : même cache, aucun remplacement.
  const raw = await get('/site.css', `brut.vitrine.localhost:${port}`);
  assert.match(raw.body, /^a\{color:rgb\(255,0,0\);padding:16px;/);
  assert.match((await get('/', `brut.vitrine.localhost:${port}`)).body, /h1\{color:#F00\}/);
  await get('/site.css');
  assert.equal(asked.filter((p) => p === '/site.css').length, 1); // une seule lecture du vrai site
});

test('site en direct (G4) : choix du token par propriété puis par valeur', () => {
  const plan = {
    entries: [
      { kind: 'color', property: 'color', normalized: '#FF0000', token: 'color/brand' },
      { kind: 'color', property: 'background', normalized: '#FF0000', token: 'color/alert' },
      { kind: 'color', property: 'background', normalized: '#FF0000', token: 'color/alert' },
      { kind: 'length', property: 'padding', normalized: '16px', token: 'space/4' },
    ],
  } as unknown as Parameters<typeof planLookup>[0];
  const lookup = planLookup(plan, {});
  assert.equal(lookup('color', 'color', '#FF0000'), '--color-brand');
  assert.equal(lookup('color', 'border-color', '#FF0000'), '--color-alert'); // le plus fréquent
  assert.equal(lookup('length', 'gap', '16px'), null);
  assert.equal(planLookup(plan, { 'space/': 'spacing/' })('length', 'padding', '16px'), '--spacing-4');
  assert.equal(applyPlan('a{color:#fff}', 'css', lookup).count, 0);
});
