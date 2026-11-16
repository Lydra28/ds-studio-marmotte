import { StudioError } from './store.js';
import { githubOff } from './hints.js';
import type { TokenSet } from '../shared/model.js';
import { exportCss, exportJson } from '../shared/export.js';
export { exportCss, exportJson, exportName } from '../shared/export.js';
import type { Config } from '../shared/project.js';
import { rewriteRepo, type RewriteResult } from '../shared/repo-rewrite.js';
import type { RepoPlan } from './repo-read.js';

// Code du projet sur GitHub. Projet lu dans un dépôt (`source: 'repo'`, plan
// GitHub G5) : une version acceptée réécrit les fichiers du dépôt d'après le
// plan de remplacement, sur une seule branche `ds-studio/design-system` et une
// seule PR, mise à jour à chaque version. Projet de tokens (`source:
// 'tokens'`) : branche `ds-studio/v<N>` et deux fichiers générés (CSS, JSON),
// plus, une seule fois, la ligne qui les importe dans le fichier d'entrée.
// Jamais d'écriture sur la branche de base : le dev relit et merge.
// Jeton : celui de la connexion GitHub de l'app (github-auth.ts), jamais dans
// un fichier du projet.
export interface GithubOptions {
  token?: string;
  fetch?: typeof fetch;
  /** API GitHub (faux GitHub des tests) ; défaut https://api.github.com. */
  apiUrl?: string;
}
type Target = NonNullable<Config['github']>;

function client(options: GithubOptions, repo: string) {
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const call = async (method: string, route: string, body?: unknown) => {
    let res: Response;
    try {
      res = await (options.fetch ?? fetch)(`${api}/repos/${repo}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'DS-Studio',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new StudioError('GitHub injoignable : vérifier la connexion puis « Réessayer ».', 502);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, data };
  };
  const fail = (what: string, r: { status: number; data: Record<string, any> }): never => {
    const hint =
      r.status === 401
        ? 'jeton refusé ou expiré (reconnecter GitHub dans Réglages)'
        : r.status === 403 || r.status === 404
          ? `DS-Studio n’a pas accès en écriture à ${repo} (Contents et Pull requests)`
          : String(r.data.message ?? r.status);
    throw new StudioError(`GitHub, ${what} : ${hint}.`, 502);
  };
  return { call, fail };
}

// Ligne qui importe le CSS généré, écrite depuis le fichier d'entrée du site.
export function importLine(target: Target) {
  const file = target.entry!.file;
  const from = file.split('/').slice(0, -1);
  const to = `${target.dir}/ds-studio.tokens.css`.split('/');
  let same = 0;
  while (same < from.length && same < to.length - 1 && from[same] === to[same]) same++;
  let rel = [...from.slice(same).map(() => '..'), ...to.slice(same)].join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return file.endsWith('.css') ? `@import '${rel}';` : `import '${rel}';`;
}

// Fichier d'entrée avec l'import ajouté juste après la ligne repère (même
// retrait, mêmes fins de ligne) : chargé après les tokens du site, le CSS
// généré l'emporte. `present` : déjà importé ; `missing` : repère absent.
export function addImport(text: string, target: Target) {
  if (text.includes('ds-studio.tokens.css')) return 'present' as const;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.includes(target.entry!.after));
  if (at < 0) return 'missing' as const;
  const indent = /^\s*/.exec(lines[at])![0];
  lines.splice(at + 1, 0, indent + importLine(target) + (lines[at].endsWith('\r') ? '\r' : ''));
  return lines.join('\n');
}

export async function publishVersion(
  options: GithubOptions,
  target: Target,
  version: { project: string; revision: number; hash: string; set: TokenSet },
) {
  if (!options.token) throw new StudioError(githubOff(), 503);
  const { call, fail } = client(options, target.repo);

  const header = `Généré par DS-Studio · ${version.project} v${version.revision} (${version.hash.slice(0, 8)}). Ne pas modifier à la main : changer le DS dans l’atelier.`;
  const files = [
    { path: `${target.dir}/ds-studio.tokens.css`, content: exportCss(version.set, target, header) },
    { path: `${target.dir}/ds-studio.tokens.json`, content: exportJson(version.set, target, header) },
  ];
  const read = async (path: string, ref: string) => {
    const r = await call('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) fail(`lecture de ${path}`, r);
    return { sha: r.data.sha as string, text: Buffer.from(String(r.data.content ?? ''), 'base64').toString('utf8') };
  };
  // Seule écriture dans un fichier du site : l'import du CSS généré, une fois.
  const entry = target.entry;
  const entryOnBase = entry ? await read(entry.file, target.base) : null;
  const patched = entryOnBase ? addImport(entryOnBase.text, target) : 'missing';
  const importState = !entry ? null : patched === 'present' || patched === 'missing' ? patched : ('added' as const);
  // Contenu identique à la base : rien à proposer.
  const onBase = await Promise.all(files.map((f) => read(f.path, target.base)));
  if (files.every((f, i) => onBase[i]?.text === f.content) && importState !== 'added')
    return { status: 'unchanged' as const, branch: null, url: null };

  const branch = `ds-studio/v${version.revision}`;
  const base = await call('GET', `/git/ref/heads/${target.base}`);
  if (base.status !== 200) fail(`branche ${target.base}`, base);
  const created = await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: base.data.object.sha });
  if (created.status !== 201 && created.status !== 422) fail(`création de ${branch}`, created);
  for (const f of files) {
    const current = created.status === 201 ? onBase[files.indexOf(f)] : await read(f.path, branch);
    if (current?.text === f.content) continue;
    const put = await call('PUT', `/contents/${f.path}`, {
      message: `DS-Studio : ${version.project} v${version.revision} (${f.path.split('/').pop()})`,
      content: Buffer.from(f.content).toString('base64'),
      branch,
      ...(current ? { sha: current.sha } : {}),
    });
    if (put.status !== 200 && put.status !== 201) fail(`écriture de ${f.path}`, put);
  }
  if (entry && importState === 'added') {
    const current = created.status === 201 ? entryOnBase : await read(entry.file, branch);
    const text = current && addImport(current.text, target);
    if (current && text !== 'present' && text !== 'missing') {
      const put = await call('PUT', `/contents/${entry.file}`, {
        message: `DS-Studio : import de ds-studio.tokens.css dans ${entry.file.split('/').pop()}`,
        content: Buffer.from(text!).toString('base64'),
        branch,
        sha: current.sha,
      });
      if (put.status !== 200 && put.status !== 201) fail(`écriture de ${entry.file}`, put);
    }
  }
  const importNote =
    !entry
      ? 'Ils ne sont pas encore importés par le code : à brancher une fois, à la main, après relecture (ordre des feuilles de style, valeurs propres au site).'
      : importState === 'present'
        ? `Déjà importés par \`${entry.file}\` : la preview montre les changements.`
        : importState === 'added'
          ? `Cette PR ajoute aussi, une seule fois, \`${importLine(target)}\` dans \`${entry.file}\`, juste après \`${entry.after}\` : les valeurs générées remplacent celles du site. Les variables propres au site restent dans leurs fichiers.`
          : `Repère \`${entry.after}\` introuvable dans \`${entry.file}\` : rien n’y a été modifié. Ligne à ajouter à la main : \`${importLine(target)}\`.`;
  const owner = target.repo.split('/')[0];
  const open = await call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  if (open.status === 200 && Array.isArray(open.data) && open.data[0])
    return { status: 'updated' as const, branch, url: String(open.data[0].html_url) };
  const pr = await call('POST', '/pulls', {
    title: `DS-Studio : ${version.project} v${version.revision}`,
    head: branch,
    base: target.base,
    body: [
      `Version **v${version.revision}** acceptée dans DS-Studio (empreinte \`${version.hash.slice(0, 8)}\`).`,
      '',
      `Fichiers générés dans \`${target.dir}/\` : \`ds-studio.tokens.css\` (variables CSS, mode mobile sous \`${target.mobileQuery}\`) et \`ds-studio.tokens.json\`.`,
      '',
      importNote,
    ].join('\n'),
  });
  if (pr.status !== 201) fail('ouverture de la pull request', pr);
  return { status: 'opened' as const, branch, url: String(pr.data.html_url) };
}

// --- PR qui modifie le code (G5) ---------------------------------------------

export const REPO_BRANCH = 'ds-studio/design-system';
export interface RepoPrSummary {
  files: number;
  written: number;
  changed: number;
  added: number;
  removed: number;
  skipped: number;
  unmapped: number;
}

const list = <T,>(items: T[], line: (x: T) => string, max = 40) => [
  ...items.slice(0, max).map((x) => `- ${line(x)}`),
  ...(items.length > max ? [`- … et ${items.length - max} autre(s)`] : []),
];
const gapText = (g: RewriteResult['gaps'][number]) =>
  g.kind === 'color' ? `ΔE ${String(Math.round(g.gap * 1000) / 10).replace('.', ',')}` : g.kind === 'length' ? `${g.gap} px` : 'police';
const code = (s: string) => `\`${s}\``;

export function repoPrBody(r: RewriteResult, version: { revision: number; hash: string }, plan: Pick<RepoPlan, 'commit' | 'date' | 'ref'>) {
  const names = (xs: string[], max = 30) => xs.slice(0, max).map(code).join(', ') + (xs.length > max ? '…' : '');
  const body = [
    `Version **v${version.revision}** acceptée dans DS-Studio (empreinte ${code(version.hash.slice(0, 8))}), d’après la lecture de ${code(plan.ref)}${plan.commit ? ` au commit ${code(plan.commit.slice(0, 7))}` : ''} du ${plan.date.slice(0, 10)}.`,
    '',
    'Cette PR remplace des valeurs écrites en dur par les variables du design system et aligne les variables sur la version acceptée. Rien n’est exécuté ; seuls les fichiers listés changent.',
    '',
    '### Tokens',
    `- ${r.changed.length} variable(s) à la nouvelle valeur${r.changed.length ? ' : ' + names(r.changed) : ''}`,
    `- ${r.added.length} variable(s) ajoutée(s)${r.added.length ? ` dans ${code(r.added[0].file)}` : ''}`,
    `- ${r.removed.length} déclaration(s) retirée(s), sans usage${r.removed.length ? ' : ' + names(r.removed) : ''}`,
    '',
    `### Fichiers modifiés (${r.files.length})`,
    ...list(r.files, (f) => `${code(f.path)} : ${f.edits} modification(s)`),
    '',
    `### Valeurs en dur remplacées (${r.written})`,
    r.gaps.length
      ? `Dont ${r.gaps.length} par un token proche, pas identique (écart de rendu à vérifier) :`
      : 'Toutes par un token de même valeur : aucun écart de rendu attendu.',
    ...list(
      [...r.gaps].sort((a, b) => b.gap - a.gap),
      (g) => `${code(`${g.file}:${g.line}`)} ${code(g.value)} → ${code(g.code)} (${gapText(g)})`,
    ),
    '',
    `### Non écrit (${r.skipped.length + r.unmapped})`,
    `- ${r.unmapped} valeur(s) en dur sans token assez proche, laissée(s) telle(s) quelle(s) (liste dans le panneau Dépôt de l’atelier).`,
    ...list(r.skipped, (x) => `${code(`${x.file}:${x.line}`)} ${code(x.value)} : ${x.reason}`),
    ...(r.notes.length ? ['', '### Notes', ...r.notes.map((n) => `- ${n}`)] : []),
  ].join('\n');
  return body.length > 60_000 ? body.slice(0, 60_000) + '\n\n… (corps tronqué)' : body;
}

/**
 * Version acceptée d'un projet lu dans un dépôt → un commit sur la base,
 * branche `ds-studio/design-system` refaite à chaque version, une seule PR.
 * `readBase(sha)` rend le texte des fichiers lus (archive de ce commit).
 */
export async function publishRepoVersion(
  options: GithubOptions,
  target: Target,
  version: { project: string; revision: number; hash: string; set: TokenSet },
  plan: RepoPlan,
  readBase: (sha: string) => Promise<Map<string, string>>,
) {
  if (!options.token) throw new StudioError(githubOff(), 503);
  const { call, fail } = client(options, target.repo);
  const head = `${target.repo.split('/')[0]}:${REPO_BRANCH}`;
  // PR mergée depuis la lecture : le code a changé sous le plan, relecture d'abord.
  const closed = await call('GET', `/pulls?state=closed&head=${encodeURIComponent(head)}&per_page=20`);
  if (closed.status === 200 && Array.isArray(closed.data) && closed.data.some((p) => p.merged_at && String(p.merged_at) > plan.date))
    throw new StudioError('La PR DS-Studio a été mergée depuis la dernière lecture du dépôt : le relire (bouton Dépôt) avant de publier.', 409);

  const base = await call('GET', `/git/ref/heads/${target.base}`);
  if (base.status !== 200) fail(`branche ${target.base}`, base);
  const sha = String(base.data.object.sha);
  const files = await readBase(sha);
  const result = rewriteRepo({ tokens: plan.tokens, entries: plan.entries, set: version.set, rename: target.rename, files, truncated: plan.truncated });
  if (result.blocked.length)
    throw new StudioError(
      `Token(s) retiré(s) dans l’atelier mais encore utilisé(s) dans le code : ${result.blocked
        .slice(0, 10)
        .map((b) => `${b.code} (${b.uses} usage(s))`)
        .join(', ')}. Les remettre ou remplacer leurs usages, puis « Réessayer ».`,
      409,
    );
  const summary: RepoPrSummary = {
    files: result.files.length,
    written: result.written,
    changed: result.changed.length,
    added: result.added.length,
    removed: result.removed.length,
    skipped: result.skipped.length,
    unmapped: result.unmapped,
  };
  if (!result.files.length) return { status: 'unchanged' as const, branch: null, url: null, summary };

  const commit = await call('GET', `/git/commits/${sha}`);
  if (commit.status !== 200) fail(`commit ${sha.slice(0, 7)}`, commit);
  const tree = await call('POST', '/git/trees', {
    base_tree: commit.data.tree.sha,
    tree: result.files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
  });
  if (tree.status !== 201) fail('écriture des fichiers', tree);
  const made = await call('POST', '/git/commits', {
    message: `DS-Studio : ${version.project} v${version.revision}`,
    tree: tree.data.sha,
    parents: [sha],
  });
  if (made.status !== 201) fail('commit', made);
  // Branche refaite depuis la base à chaque version : la PR montre l'écart
  // avec la base, jamais un empilement de versions.
  const existing = await call('GET', `/git/ref/heads/${REPO_BRANCH}`);
  const moved =
    existing.status === 200
      ? await call('PATCH', `/git/refs/heads/${REPO_BRANCH}`, { sha: made.data.sha, force: true })
      : await call('POST', '/git/refs', { ref: `refs/heads/${REPO_BRANCH}`, sha: made.data.sha });
  if (moved.status !== 200 && moved.status !== 201) fail(`branche ${REPO_BRANCH}`, moved);

  const title = `DS-Studio : ${version.project} v${version.revision}`;
  const body = repoPrBody(result, version, plan);
  const open = await call('GET', `/pulls?state=open&head=${encodeURIComponent(head)}`);
  const current = open.status === 200 && Array.isArray(open.data) ? open.data[0] : null;
  if (current) {
    const updated = await call('PATCH', `/pulls/${current.number}`, { title, body });
    if (updated.status !== 200) fail('mise à jour de la pull request', updated);
    return { status: 'updated' as const, branch: REPO_BRANCH, url: String(current.html_url), summary };
  }
  const pr = await call('POST', '/pulls', { title, head: REPO_BRANCH, base: target.base, body });
  if (pr.status !== 201) fail('ouverture de la pull request', pr);
  return { status: 'opened' as const, branch: REPO_BRANCH, url: String(pr.data.html_url), summary };
}
