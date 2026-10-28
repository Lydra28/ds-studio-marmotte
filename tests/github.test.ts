import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addImport, exportCss, exportName, importLine, publishVersion } from '../app/server/github.js';
import { tokenSetSchema } from '../app/shared/model.js';
import { configSchema } from '../app/shared/project.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const set = tokenSetSchema.parse(JSON.parse(await readFile(path.join(root, 'projects/marmotte/design-system.tokens.json'), 'utf8')));
const target = configSchema.parse({
  name: 'T',
  github: { repo: 'romain/site', dir: 'src/styles', rename: { 'bg/': 'color/bg/', 'font/line-height/': 'line-height/' } },
}).github!;
const version = { project: 'Marmotte', revision: 7, hash: 'a'.repeat(64), set };

// Faux GitHub en mémoire : branches, fichiers, pull requests.
function fakeGithub(files: Record<string, string> = {}) {
  const calls: string[] = [];
  const branches = new Map([['main', { ...files }]]);
  const pulls: { head: string; body: string }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const route = u.pathname.replace('/repos/romain/site', '');
    calls.push(`${init.method} ${route}`);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer jeton');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (route.startsWith('/contents/')) {
      const file = route.slice('/contents/'.length);
      if (init.method === 'GET') {
        const text = branches.get(u.searchParams.get('ref')!)?.[file];
        return text === undefined ? json(404, {}) : json(200, { sha: `sha-${text.length}`, content: Buffer.from(text).toString('base64') });
      }
      branches.get(body.branch)![file] = Buffer.from(body.content, 'base64').toString('utf8');
      return json(201, {});
    }
    if (route === '/git/ref/heads/main') return json(200, { object: { sha: 'base-sha' } });
    if (route === '/git/refs') {
      const name = body.ref.replace('refs/heads/', '');
      if (branches.has(name)) return json(422, { message: 'Reference already exists' });
      branches.set(name, { ...branches.get('main') });
      return json(201, {});
    }
    if (route === '/pulls' && init.method === 'GET')
      return json(200, pulls.filter((p) => `romain:${p.head}` === u.searchParams.get('head')).map(() => ({ html_url: 'https://github.com/romain/site/pull/1' })));
    if (route === '/pulls') {
      pulls.push({ head: body.head, body: body.body });
      assert.equal(body.base, 'main');
      return json(201, { html_url: 'https://github.com/romain/site/pull/1' });
    }
    return json(500, {});
  }) as typeof globalThis.fetch;
  return { fetch, calls, branches, pulls };
}

test('export : noms renommés comme dans le code, alias en var(), mode mobile en media query', () => {
  assert.equal(exportName('bg/canvas', target.rename), 'color/bg/canvas');
  assert.equal(exportName('space/md', target.rename), 'space/md');
  const css = exportCss(set, target, 'Généré');
  assert.match(css, /--color-bg-canvas: var\(--color-neutral-50\);/);
  assert.match(css, /--font-size-display: 48px;/);
  assert.match(css, /@media \(max-width: 767\.98px\) \{\n {2}:root \{\n {4}--font-size-display: 32px;/);
  assert.doesNotMatch(css, /@media[\s\S]*--font-size-body:/); // identique en mobile : pas répété
});

test('GitHub : branche ds-studio/vN et pull request, jamais sur main ; rien si déjà à jour ; jeton exigé', async () => {
  await assert.rejects(() => publishVersion({}, target, version), /GITHUB_TOKEN/);
  const gh = fakeGithub();
  const opened = await publishVersion({ token: 'jeton', fetch: gh.fetch }, target, version);
  assert.deepEqual(opened, { status: 'opened', branch: 'ds-studio/v7', url: 'https://github.com/romain/site/pull/1' });
  assert.match(gh.branches.get('ds-studio/v7')!['src/styles/ds-studio.tokens.css'], /--color-bg-brand/);
  assert.ok(gh.branches.get('ds-studio/v7')!['src/styles/ds-studio.tokens.json']);
  assert.deepEqual(gh.branches.get('main'), {}); // la base n'est jamais écrite
  assert.ok(!gh.calls.some((c) => c.startsWith('PUT') && c.includes('main')));
  // Relance : branche déjà là, PR déjà ouverte → mise à jour, pas de doublon.
  assert.equal((await publishVersion({ token: 'jeton', fetch: gh.fetch }, target, version)).status, 'updated');
  // Base déjà identique : aucune branche créée.
  const same = fakeGithub(gh.branches.get('ds-studio/v7'));
  assert.equal((await publishVersion({ token: 'jeton', fetch: same.fetch }, target, version)).status, 'unchanged');
  assert.ok(!same.calls.some((c) => c.startsWith('POST')));
  // Jeton refusé : message clair.
  const denied = (async () => new Response('{}', { status: 401 })) as typeof globalThis.fetch;
  await assert.rejects(() => publishVersion({ token: 'jeton', fetch: denied }, target, version), /jeton refusé ou expiré/);
});

test('GitHub : la première PR importe le CSS généré dans le fichier d’entrée du site, une seule fois', async () => {
  const site = configSchema.parse({
    name: 'D',
    github: { repo: 'romain/site', dir: 'site/src/styles', entry: { file: 'site/src/layouts/BaseLayout.astro', after: "import '../styles/tokens.css';" } },
  }).github!;
  assert.equal(importLine(site), "import '../styles/ds-studio.tokens.css';");
  assert.equal(importLine({ ...site, entry: { file: 'site/src/styles/main.css', after: 'x' } }), "@import './ds-studio.tokens.css';");
  const layout = "---\r\nimport '../styles/tokens.css';\r\nimport '../styles/base.css';\r\n---\r\n";
  // Ajout juste après le repère, fins de ligne du fichier gardées ; jamais deux fois.
  const once = addImport(layout, site) as string;
  assert.equal(once, "---\r\nimport '../styles/tokens.css';\r\nimport '../styles/ds-studio.tokens.css';\r\nimport '../styles/base.css';\r\n---\r\n");
  assert.equal(addImport(once, site), 'present');
  assert.equal(addImport('---\n---\n', site), 'missing');

  const gh = fakeGithub({ 'site/src/layouts/BaseLayout.astro': layout });
  assert.equal((await publishVersion({ token: 'jeton', fetch: gh.fetch }, site, version)).status, 'opened');
  assert.equal(gh.branches.get('ds-studio/v7')!['site/src/layouts/BaseLayout.astro'], once);
  assert.equal(gh.branches.get('main')!['site/src/layouts/BaseLayout.astro'], layout); // base intacte
  assert.match(gh.pulls[0].body, /ajoute aussi, une seule fois/);

  // Après le merge : l'import est sur main, la PR suivante ne touche plus le fichier d'entrée.
  const merged = fakeGithub({ ...gh.branches.get('ds-studio/v7')! });
  assert.equal((await publishVersion({ token: 'jeton', fetch: merged.fetch }, site, version)).status, 'unchanged');
  const next = fakeGithub({ 'site/src/layouts/BaseLayout.astro': once });
  await publishVersion({ token: 'jeton', fetch: next.fetch }, site, version);
  assert.ok(!next.calls.some((c) => c === 'PUT /contents/site/src/layouts/BaseLayout.astro'));
  assert.match(next.pulls[0].body, /Déjà importés/);

  // Repère absent : fichier d'entrée intact, ligne à ajouter indiquée dans la PR.
  const lost = fakeGithub({ 'site/src/layouts/BaseLayout.astro': '---\n---\n' });
  await publishVersion({ token: 'jeton', fetch: lost.fetch }, site, version);
  assert.equal(lost.branches.get('ds-studio/v7')!['site/src/layouts/BaseLayout.astro'], '---\n---\n');
  assert.match(lost.pulls[0].body, /introuvable/);
});
