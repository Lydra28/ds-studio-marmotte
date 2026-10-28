import { randomUUID } from 'node:crypto';

// Pont avec l'app Electron : le serveur y tourne en processus utilitaire.
// Arrêt propre demandé par l'app, et captures de liens du Mur des DA faites
// par le Chromium d'Electron (aucun téléchargement de Playwright sur le poste).
// Hors de l'app, `parentPort` est absent et rien ne change.
type Message = { type?: string; id?: string; url?: string; data?: Uint8Array; error?: string; port?: number };
type ParentPort = {
  postMessage(message: Message): void;
  on(event: 'message', listener: (event: { data: Message }) => void): void;
};
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
export const inDesktop = !!parent;

const waiting = new Map<string, { resolve: (data: Buffer) => void; reject: (e: Error) => void }>();
parent?.on('message', ({ data }) => {
  if (data?.type !== 'capture-result' || !data.id) return;
  const job = waiting.get(data.id);
  waiting.delete(data.id);
  if (!job) return;
  if (data.data) job.resolve(Buffer.from(data.data));
  else job.reject(new Error(data.error || 'Capture impossible.'));
});

export function captureInDesktop(url: string): Promise<Buffer> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('Capture trop longue.'));
    }, 30_000);
    waiting.set(id, {
      resolve: (data) => (clearTimeout(timer), resolve(data)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    parent!.postMessage({ type: 'capture', id, url });
  });
}

export function onDesktopStop(stop: () => void) {
  parent?.on('message', ({ data }) => {
    if (data?.type === 'stop') stop();
  });
}

export function desktopReady(port: number) {
  parent?.postMessage({ type: 'ready', port });
}
