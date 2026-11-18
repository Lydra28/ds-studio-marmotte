import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addImport, exportCss, exportName, importLine, publishRepoVersion, publishVersion, REPO_BRANCH } from '../app/server/github.js';
import { applyChanges, tokenSetSchema } from '../app/shared/model.js';
import { configSchema } from '../app/shared/project.js';
import { proposeFromRepo } from '../app/shared/repo-propose.js';
import { scanRepo } from '../app/shared/repo-scan.js';

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
  await assert.rejects(() => publishVersion({}, target, version), /GitHub n’est pas connecté/);
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

// --- PR qui modifie le code (plan GitHub, G5) --------------------------------

const REPO_FILES = {
  'src/styles/tokens.css':
    ':root {\n  --color-ink: #111111;\n  --color-paper: #FAFAF7;\n  --bg-canvas: var(--color-paper);\n  --text-primary: var(--color-ink);\n  --space-sm: 8px;\n  --space-md: 16px;\n  --space-lg: 24px;\n  --radius-card: 12px;\n  --font-body: "Satoshi", sans-serif;\n  --font-size-body: 16px;\n}\n',
  'src/components/Card.css': '.card { background: #FAFAF7; padding: 16px; color: var(--text-primary); }\n',
};

// Faux GitHub, API Git Data : un commit sur la base, une branche, des PR.
function fakeGitData(options: { merged?: string } = {}) {
  const calls: string[] = [];
  const refs = new Map<string, string>([['main', 'base-sha']]);
  const trees: { base: string; files: { path: string; content: string }[] }[] = [];
  const pulls: { number: number; head: string; title: string; body: string; state: string; merged_at: string | null }[] = [];
  if (options.merged) pulls.push({ number: 9, head: 'ds-studio/design-system', title: 'ancienne', body: '', state: 'closed', merged_at: options.merged });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    assert.equal(u.origin, 'http://faux-github.test');
    const route = u.pathname.replace('/repos/dev/site', '');
    calls.push(`${init.method} ${route}`);
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer jeton-app');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (route.startsWith('/git/ref/heads/')) {
      const sha = refs.get(route.slice('/git/ref/heads/'.length));
      return sha ? json(200, { object: { sha } }) : json(404, {});
    }
    if (route === '/git/commits/base-sha') return json(200, { tree: { sha: 'base-tree' } });
    if (route === '/git/trees') {
      trees.push({ base: body.base_tree, files: body.tree });
      return json(201, { sha: `tree-${trees.length}` });
    }
    if (route === '/git/commits') {
      assert.deepEqual(body.parents, ['base-sha']);
      return json(201, { sha: `commit-${body.tree}` });
    }
    if (route === '/git/refs' && init.method === 'POST') {
      refs.set(body.ref.replace('refs/heads/', ''), body.sha);
      return json(201, {});
    }
    if (route.startsWith('/git/refs/heads/') && init.method === 'PATCH') {
      assert.equal(body.force, true);
      refs.set(route.slice('/git/refs/heads/'.length), body.sha);
      return json(200, {});
    }
    if (route === '/pulls' && init.method === 'GET') {
      const state = u.searchParams.get('state');
      assert.equal(u.searchParams.get('head'), 'dev:ds-studio/design-system');
      return json(
        200,
        pulls.filter((p) => p.state === state).map((p) => ({ number: p.number, html_url: `https://github.com/dev/site/pull/${p.number}`, merged_at: p.merged_at })),
      );
    }
    if (route === '/pulls' && init.method === 'POST') {
      assert.equal(body.base, 'main');
      pulls.push({ number: 1, head: body.head, title: body.title, body: body.body, state: 'open', merged_at: null });
      return json(201, { html_url: 'https://github.com/dev/site/pull/1' });
    }
    if (route.startsWith('/pulls/') && init.method === 'PATCH') {
      const pr = pulls.find((p) => p.number === Number(route.slice(7)))!;
      Object.assign(pr, { title: body.title, body: body.body });
      return json(200, {});
    }
    return json(500, {});
  }) as typeof globalThis.fetch;
  return { fetch, calls, refs, trees, pulls };
}

test('GitHub G5 : la version réécrit le code du dépôt, une seule branche et une seule PR, mise à jour', async () => {
  const blank = tokenSetSchema.parse(JSON.parse(await readFile(path.join(root, 'templates/blank/design-system.tokens.json'), 'utf8')));
  const p = proposeFromRepo(scanRepo(Object.entries(REPO_FILES).map(([file, text]) => ({ path: file, text }))), blank, { mode: 'create' });
  const plan = {
    version: 2 as const,
    date: '2026-11-09T10:00:00.000Z',
    repo: 'dev/site',
    ref: 'main',
    subdir: null,
    commit: 'abc1234',
    mode: 'create' as const,
    report: p.report,
    tokens: p.tokens,
    entries: p.entries,
    truncated: false,
  };
  const set = applyChanges(blank, p.changes);
  const repoTarget = configSchema.parse({ name: 'S', github: { repo: 'dev/site', dir: '.', source: 'repo' } }).github!;
  const v = { project: 'Site', revision: 1, hash: 'b'.repeat(64), set };
  const read = async (sha: string) => {
    assert.equal(sha, 'base-sha', 'fichiers lus au commit de la base');
    return new Map(Object.entries(REPO_FILES));
  };
  const access = { token: 'jeton-app', apiUrl: 'http://faux-github.test' };
  await assert.rejects(() => publishRepoVersion({}, repoTarget, v, plan, read), /pas connecté/);

  const gh = fakeGitData();
  const opened = await publishRepoVersion({ ...access, fetch: gh.fetch }, repoTarget, v, plan, read);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.branch, REPO_BRANCH);
  assert.equal(gh.refs.get('main'), 'base-sha', 'la base ne bouge jamais');
  assert.equal(gh.refs.get(REPO_BRANCH), 'commit-tree-1');
  const card = gh.trees[0].files.find((f) => f.path === 'src/components/Card.css')!;
  assert.equal(card.content, '.card { background: var(--bg-canvas); padding: var(--space-md); color: var(--text-primary); }\n');
  assert.equal(gh.trees[0].base, 'base-tree');
  assert.equal(opened.summary.written, 2);
  assert.match(gh.pulls[0].body, /Valeurs en dur remplacées \(2\)/);
  assert.match(gh.pulls[0].body, /aucun écart de rendu attendu/);

  // Version suivante : même branche refaite depuis la base, même PR mise à jour.
  const v2 = { ...v, revision: 2, set: structuredClone(set) };
  v2.set.tokens['color/paper'].$values.default = '#FFFFFF';
  const updated = await publishRepoVersion({ ...access, fetch: gh.fetch }, repoTarget, v2, plan, read);
  assert.equal(updated.status, 'updated');
  assert.equal(gh.pulls.length, 1);
  assert.equal(gh.pulls[0].title, 'DS-Studio : Site v2');
  assert.ok(gh.calls.includes(`PATCH /git/refs/heads/${REPO_BRANCH}`));
  assert.match(gh.trees[1].files.find((f) => f.path === 'src/styles/tokens.css')!.content, /--color-paper: #FFFFFF;/);

  // PR mergée après la lecture : relecture du dépôt exigée, rien n'est écrit.
  const merged = fakeGitData({ merged: '2026-11-09T12:00:00Z' });
  await assert.rejects(() => publishRepoVersion({ ...access, fetch: merged.fetch }, repoTarget, v, plan, read), /mergée depuis la dernière lecture/);
  assert.equal(merged.trees.length, 0);
  // Mergée avant la lecture : sans effet.
  const before = fakeGitData({ merged: '2026-11-08T12:00:00Z' });
  assert.equal((await publishRepoVersion({ ...access, fetch: before.fetch }, repoTarget, v, plan, read)).status, 'opened');

  // Token retiré encore utilisé : refusé, usages cités, rien n'est écrit.
  const removed = { ...v, set: structuredClone(set) };
  delete removed.set.tokens['text/primary'];
  const refused = fakeGitData();
  // Message de refus : nom du code, clé de l'atelier, fichier et ligne, quoi faire (retour de Romain du 2026-11-17).
  await assert.rejects(
    () => publishRepoVersion({ ...access, fetch: refused.fetch }, repoTarget, removed, plan, read),
    (e: Error) => {
      assert.match(e.message, /--text-primary \(token text\/primary de l’atelier, déclaré dans src\/styles\/tokens\.css ligne 5, 1 usage\(s\)\)/);
      assert.match(e.message, /remettre ce token dans le design system sous le même nom \(text\/primary\) puis accepter une nouvelle version/);
      assert.match(e.message, /« Réessayer »/);
      assert.doesNotMatch(e.message, /\btu\b|redemande/);
      return true;
    },
  );
  assert.equal(refused.trees.length, 0);

  // Code déjà à jour : aucune branche.
  const done = fakeGitData();
  const clean = async () =>
    new Map([
      ['src/styles/tokens.css', REPO_FILES['src/styles/tokens.css']],
      ['src/components/Card.css', '.card { background: var(--bg-canvas); }\n'],
    ]);
  const unchanged = await publishRepoVersion({ ...access, fetch: done.fetch }, repoTarget, v, { ...plan, entries: [] }, clean);
  assert.equal(unchanged.status, 'unchanged');
  assert.ok(!done.calls.some((c) => c.startsWith('POST')));
});

// Recette du 2026-11-17 : projet créé depuis un dépôt, proposition jamais mise
// en brouillon, version acceptée. Rien n'est « retiré » : PR non bloquée, les
// variables du dépôt restent et la PR dit comment les reprendre.
test('GitHub G5 : tokens du dépôt jamais repris → PR ouverte, déclarations gardées, chemin pour les reprendre', async () => {
  const blank = tokenSetSchema.parse(JSON.parse(await readFile(path.join(root, 'templates/blank/design-system.tokens.json'), 'utf8')));
  const css = ':root {\n  --brand-main: #2563eb;\n  --ink-strong: #111827;\n}\n.a { color: var(--brand-main); padding: 16px; }\n';
  const p = proposeFromRepo(scanRepo([{ path: 'src/a.css', text: css }]), blank, { mode: 'create' });
  const plan = {
    version: 2 as const,
    date: '2026-11-17T10:00:00.000Z',
    repo: 'dev/site',
    ref: 'main',
    subdir: null,
    commit: 'abc1234',
    mode: 'create' as const,
    report: p.report,
    tokens: p.tokens,
    entries: p.entries,
    proposed: p.proposed,
    truncated: false,
  };
  const repoTarget = configSchema.parse({ name: 'S', github: { repo: 'dev/site', dir: '.', source: 'repo' } }).github!;
  const v = { project: 'Site', revision: 1, hash: 'c'.repeat(64), set: blank };
  const gh = fakeGitData();
  const r = await publishRepoVersion({ token: 'jeton-app', apiUrl: 'http://faux-github.test', fetch: gh.fetch }, repoTarget, v, plan, async () => new Map([['src/a.css', css]]));
  assert.notEqual(r.status, 'error');
  assert.equal(r.summary.untaken, 2);
  assert.equal(r.summary.removed, 0);
  const written = gh.trees[0]?.files.find((f) => f.path === 'src/a.css')?.content ?? css;
  assert.match(written, /--brand-main: #2563eb;\n {2}--ink-strong: #111827;/, 'déclarations intactes');
  assert.match(
    gh.pulls[0]?.body ?? '',
    /2 variable\(s\) du dépôt jamais reprise\(s\)[^\n]*« GitHub » → « Relire le dépôt » → « Mettre en brouillon » → « Voir le diff et valider »/,
  );
});
