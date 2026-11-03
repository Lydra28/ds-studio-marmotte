import { randomUUID } from 'node:crypto';

// Pont avec l'app Electron : le serveur y tourne en processus utilitaire.
// Arrêt propre demandé par l'app, captures de liens du Mur des DA faites par
// le Chromium d'Electron (aucun téléchargement de Playwright sur le poste),
// état des mises à jour reçu de l'app et actions de la vue Réglages renvoyées
// vers elle. Lecture des styles d'un site (lot 5) par le même Chromium :
// message `extract`, script fourni par le serveur. Hors de l'app, `parentPort` est absent et rien ne change.
export type UpdateState = {
  status: 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'error';
  version: string;
  channel: string;
  reason: string | null;
  available: string | null;
  progress: number | null;
  message: string | null;
  checkedAt: string | null;
};
export type DesktopAction = 'choose-projects' | 'check-update' | 'install-update';
type Message = {
  type?: string;
  id?: string;
  url?: string;
  data?: Uint8Array;
  script?: string;
  inventory?: unknown;
  error?: string;
  port?: number;
  action?: DesktopAction;
  update?: UpdateState;
};
type ParentPort = {
  postMessage(message: Message): void;
  on(event: 'message', listener: (event: { data: Message }) => void): void;
};
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
export const inDesktop = !!parent;

const waiting = new Map<string, { resolve: (data: Message) => void; reject: (e: Error) => void }>();
let update: UpdateState | null = null;
parent?.on('message', ({ data }) => {
  if (data?.type === 'desktop-state') {
    update = data.update ?? null;
    return;
  }
  if ((data?.type !== 'capture-result' && data?.type !== 'extract-result') || !data.id) return;
  const job = waiting.get(data.id);
  waiting.delete(data.id);
  if (!job) return;
  if (data.error) job.reject(new Error(data.error));
  else job.resolve(data);
});

// Travail confié à l'app, réponse attendue par son id.
function askDesktop(message: Message, timeoutMs: number, slow: string): Promise<Message> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(slow));
    }, timeoutMs);
    waiting.set(id, {
      resolve: (data) => (clearTimeout(timer), resolve(data)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    parent!.postMessage({ ...message, id });
  });
}

export async function captureInDesktop(url: string): Promise<Buffer> {
  const reply = await askDesktop({ type: 'capture', url }, 30_000, 'Capture trop longue.');
  if (!reply.data) throw new Error('Capture impossible.');
  return Buffer.from(reply.data);
}

// Lecture des styles en deux largeurs ; `script` = PAGE_SCRIPT (extract-page.ts).
export async function extractInDesktop(url: string, script: string): Promise<unknown> {
  const reply = await askDesktop({ type: 'extract', url, script }, 45_000, 'Lecture trop longue (45 s).');
  return reply.inventory;
}

// Dernier état des mises à jour envoyé par l'app (null hors de l'app).
export const updateState = () => update;

// Action demandée depuis la vue Réglages, exécutée par l'app (dialogue de
// dossier, vérification ou installation d'une mise à jour).
export function requestDesktop(action: DesktopAction) {
  if (!parent) throw new Error('Disponible dans l’app DS-Studio seulement.');
  parent.postMessage({ type: 'desktop', action });
}

export function onDesktopStop(stop: () => void) {
  parent?.on('message', ({ data }) => {
    if (data?.type === 'stop') stop();
  });
}

export function desktopReady(port: number) {
  parent?.postMessage({ type: 'ready', port });
}
