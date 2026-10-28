import { StudioError } from './store.js';
import { cssName, cssValue, isAlias, aliasTarget, type TokenSet, type TokenValue } from '../shared/model.js';
import type { Config } from '../shared/project.js';

// Code du projet sur GitHub : une version acceptée devient une branche
// `ds-studio/v<N>` et une pull request avec deux fichiers générés (CSS, JSON),
// plus, une seule fois, la ligne qui les importe dans le fichier d'entrée.
// Jamais d'écriture sur la branche de base : Romain relit et merge.
// Jeton : GITHUB_TOKEN dans .env, lu par le serveur seulement.
export interface GithubOptions {
  token?: string;
  fetch?: typeof fetch;
}
export const githubFromEnv = (): GithubOptions => ({ token: process.env.GITHUB_TOKEN || undefined });
type Target = NonNullable<Config['github']>;

// Préfixe le plus long qui correspond, renommé ; sinon le nom de l'atelier.
export function exportName(key: string, rename: Record<string, string>) {
  const from = Object.keys(rename)
    .filter((p) => key.startsWith(p))
    .sort((a, b) => b.length - a.length)[0];
  return from === undefined ? key : rename[from] + key.slice(from.length);
}

function value(set: TokenSet, key: string, v: TokenValue, rename: Record<string, string>) {
  if (isAlias(v)) return `var(${cssName(exportName(aliasTarget(v), rename))})`;
  const type = set.tokens[key].$type;
  if (type === 'fontFamily') {
    const family = String(v);
    return cssValue(type, /[\s]/.test(family) && !/[",]/.test(family) ? `"${family}"` : family);
  }
  return cssValue(type, v);
}

export function exportCss(set: TokenSet, target: Target, header: string) {
  const lines = (pick: (modes: string[]) => string | undefined, keys = Object.keys(set.tokens)) =>
    keys
      .map((key) => {
        const t = set.tokens[key];
        const mode = pick(set.modes[t.$collection]);
        return mode && t.$values[mode] !== undefined
          ? `  ${cssName(exportName(key, target.rename))}: ${value(set, key, t.$values[mode], target.rename)};`
          : null;
      })
      .filter(Boolean)
      .join('\n');
  const typography = Object.keys(set.tokens).filter((k) => {
    const t = set.tokens[k];
    const [first, second] = set.modes.typography;
    return t.$collection === 'typography' && second && t.$values[second] !== t.$values[first];
  });
  const out = [`/* ${header} */`, `:root {\n${lines((m) => m[0])}\n}`];
  if (typography.length)
    out.push(`@media ${target.mobileQuery} {\n  :root {\n${lines((m) => m[1], typography).replace(/^/gm, '  ')}\n  }\n}`);
  return out.join('\n\n') + '\n';
}

export function exportJson(set: TokenSet, target: Target, header: string) {
  const tokens = Object.fromEntries(
    Object.entries(set.tokens).map(([key, t]) => [
      exportName(key, target.rename),
      {
        ...t,
        $values: Object.fromEntries(
          Object.entries(t.$values).map(([m, v]) => [m, isAlias(v) ? `{${exportName(aliasTarget(v), target.rename)}}` : v]),
        ),
      },
    ]),
  );
  return JSON.stringify({ $comment: header, modes: set.modes, tokens }, null, 2) + '\n';
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
  if (!options.token)
    throw new StudioError('GITHUB_TOKEN absent de .env : PR non ouverte. Ajoute le jeton puis relance l’atelier.', 503);
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await (options.fetch ?? fetch)(`https://api.github.com/repos/${target.repo}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DS-Studio',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { status: res.status, data };
  };
  const fail = (what: string, r: { status: number; data: Record<string, any> }): never => {
    const hint =
      r.status === 401
        ? 'jeton refusé ou expiré'
        : r.status === 403 || r.status === 404
          ? `jeton sans accès à ${target.repo} (Contents et Pull requests en écriture)`
          : String(r.data.message ?? r.status);
    throw new StudioError(`GitHub, ${what} : ${hint}.`, 502);
  };

  const header = `Généré par DS-Studio · ${version.project} v${version.revision} (${version.hash.slice(0, 8)}). Ne pas modifier à la main : change le DS dans l’atelier.`;
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
export type PublishResult = Awaited<ReturnType<typeof publishVersion>>;
