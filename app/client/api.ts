import type { Change, Proposal, State, TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
export interface Bootstrap {
  csrf: string;
  figma: { label: string; connected: boolean };
  multi: boolean;
  fallback: string;
  // Code d'appairage du plugin Figma, affiché dans l'atelier seulement.
  plugin: string | null;
}
export interface ProjectSummary {
  slug: string;
  name: string;
  revision: number;
  accepted: number | null;
  updatedAt: string;
}
export interface VersionSummary {
  revision: number;
  acceptedAt: string;
  hash: string;
  file: string;
  findings: number;
}
let csrf = '';
// Projet ouvert : envoyé à chaque requête, le serveur sert le projet par défaut sinon.
let project = '';
export const setProject = (slug: string) => {
  project = slug;
};
export async function request<T>(
  url: string,
  body?: unknown,
  retrySession = true,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(project ? { 'X-DS-Project': project } : {}),
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'X-DS-Studio': csrf }),
      },
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
export const getConfig = () => request<Config>('config');
export const listProjects = () => request<ProjectSummary[]>('projects');
export const createProject = (p: { name: string; doctrine: string; ideas: string; figmaUrl: string }) =>
  request<{ slug: string }>('projects', p);
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
// Fiches envoyées par le plugin Figma, en attente d'import par diff.
export interface Inbox {
  receivedAt: string;
  report: string[];
  file: { format: 'ds-studio-components/1'; source?: string; components: Record<string, unknown> };
}
export const getInbox = () => request<Inbox | null>('inbox');
export const clearInbox = () => request<null>('inbox/clear', {});
export const getVersion = (revision: number) =>
  request<VersionSummary & { set: TokenSet }>(`version?revision=${revision}`);
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
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  date: string;
  proposal?: { reason: string; changes: Change[] };
  usage?: { prompt: number; completion: number };
}
export interface AssistantState {
  enabled: boolean;
  model: string;
  messages: AssistantMessage[];
}
export const getAssistant = () => request<AssistantState>('assistant');
export const askAssistant = (message: string) =>
  request<{ messages: AssistantMessage[] }>('assistant/chat', { message });
export const resetAssistant = () => request<{ messages: AssistantMessage[] }>('assistant/reset', {});
export interface Inspiration {
  id: string;
  kind: 'image' | 'capture';
  name: string;
  url?: string;
}
export interface Direction {
  name: string;
  intention: string;
  rationale: string;
  fonts: { heading: string; body: string };
  changes: Change[];
  dropped: number;
  droppedReasons?: string[];
}
export interface WallState {
  enabled: boolean;
  inspirations: Inspiration[];
  result?: {
    date: string;
    model: string;
    note: string;
    directions: Direction[];
    usage?: { prompt: number; completion: number };
  };
}
export const getWall = () => request<WallState>('wall');
export const wallFileUrl = (slug: string, id: string) =>
  `/api/wall/file?project=${encodeURIComponent(slug)}&id=${encodeURIComponent(id)}`;
export const addImage = (name: string, dataUrl: string) => request<Inspiration>('wall/image', { name, dataUrl });
export const addLink = (url: string) => request<Inspiration>('wall/link', { url });
export const removeInspiration = (id: string) => request<WallState>('wall/remove', { id });
export const proposeDirections = (note: string, count: number) =>
  request<NonNullable<WallState['result']>>('wall/directions', { note, count });
