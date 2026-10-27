import type { Change, Proposal, State, TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
export interface Bootstrap {
  csrf: string;
  figma: { label: string; connected: boolean };
  config: Config;
}
export interface VersionSummary {
  revision: number;
  acceptedAt: string;
  hash: string;
  file: string;
  findings: number;
}
let csrf = '';
export async function request<T>(
  url: string,
  body?: unknown,
  retrySession = true,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'X-DS-Studio': csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'Serveur local inaccessible. Relancez DS-Studio. Votre dernière validation reste sur disque.',
    );
  }
  const result = await response.json();
  if (
    response.status === 403 &&
    body !== undefined &&
    retrySession &&
    result.error?.startsWith('Validation de session manquante')
  ) {
    await bootstrap();
    return request<T>(url, body, false);
  }
  if (!response.ok)
    throw new Error(result.error ?? 'Le serveur ne répond pas.');
  return result;
}
export async function bootstrap() {
  const b = await request<Bootstrap>('bootstrap');
  csrf = b.csrf;
  return b;
}
export const getState = () => request<State>('state');
export const propose = (revision: number, changes: Change[]) =>
  request<Proposal>('proposals', { revision, changes });
export const proposeImport = (revision: number, tokens: unknown) =>
  request<Proposal>('import', { revision, tokens });
export const proposeUndo = (revision: number, id: string) =>
  request<Proposal>('undo', { revision, id });
export const commit = (proposal: Proposal) =>
  request<State>('commit', { id: proposal.id });
export const accept = (revision: number) =>
  request<VersionSummary>('accept', { revision });
export const getVersions = () => request<VersionSummary[]>('versions');
export async function exportSet(name: string) {
  const set = await request<TokenSet>('export');
  downloadText(
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.tokens.json`,
    JSON.stringify(set, null, 2) + '\n',
    'application/json',
  );
}
export function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
