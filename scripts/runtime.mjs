// Bibliothèque standard seulement : utilisable avant npm ci.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}
export async function readRecord(directory, name) {
  try {
    const file = path.join(directory, name + '.lock');
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.size > 8192)
      throw new Error('Verrou non sûr.');
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    const pid = typeof record === 'number' ? record : record?.pid;
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      (typeof record !== 'number' &&
        (typeof record.id !== 'string' || typeof record.token !== 'string'))
    )
      throw new Error(
        'Verrou illisible : préservé, aucune suppression automatique.',
      );
    return record;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
export async function leasePort(directory, name) {
  const canonical = await fs.realpath(directory);
  const key =
    process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return (
    49152 +
    (createHash('sha256')
      .update(key + '/' + name)
      .digest()
      .readUInt16BE() %
      16384)
  );
}
export async function acquireLease(directory, name, extra = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink())
    throw new Error('Dossier de données symbolique refusé.');
  // Le noyau sérialise aussi la récupération d'un fichier abandonné. Aucun
  // unlink concurrent ne peut retirer le nouveau verrou d'un autre serveur.
  // Une collision de port auxiliaire échoue sans toucher au fichier ni aux données.
  const guard = net.createServer((socket) => socket.destroy());
  try {
    const port = await leasePort(directory, name);
    await new Promise((resolve, reject) => {
      guard.once('error', reject);
      guard.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (e) {
    guard.close();
    throw new Error(
      e.code === 'EADDRINUSE'
        ? 'Dossier déjà verrouillé : instance active ou port de protection occupé. Aucune donnée modifiée.'
        : e.message,
    );
  }
  const file = path.join(directory, name + '.lock');
  const record = {
    pid: process.pid,
    id: randomUUID(),
    token: randomBytes(32).toString('hex'),
    ...extra,
  };
  async function publish() {
    const temporary = path.join(directory, `${name}-${record.id}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(record), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  try {
    const old = await readRecord(directory, name);
    const pid = typeof old === 'number' ? old : old?.pid;
    if (old !== null && (!Number.isSafeInteger(pid) || alive(pid)))
      throw new Error(
        'Dossier déjà verrouillé : PID actif ou verrou illisible. Aucun processus inconnu ne sera arrêté.',
      );
    if (old !== null) await fs.unlink(file);
    await publish();
  } catch (e) {
    guard.close();
    throw e;
  }
  return {
    record,
    async update(extra) {
      Object.assign(record, extra);
      await publish();
    },
    async release() {
      const current = await readRecord(directory, name);
      if (current?.id === record.id) await fs.unlink(file);
      await new Promise((resolve) => guard.close(resolve));
    },
  };
}
export async function control(record, action = 'health') {
  if (
    !record ||
    !Number.isInteger(record.port) ||
    record.port < 1024 ||
    record.port > 65535 ||
    !alive(record.pid)
  )
    return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/_studio/${action}`,
      {
        method: action === 'health' ? 'GET' : 'POST',
        headers: { 'X-Studio-Control': record.token },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) return null;
    const result = await response.json();
    return result.id === record.id &&
      result.pid === record.pid &&
      result.root === record.root &&
      result.directory === record.directory
      ? result
      : null;
  } catch {
    return null;
  }
}
export function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    });
    // Certains ouvreurs restent vivants avec le navigateur : ne pas bloquer
    // Arrêter / Quitter sur leur durée de vie. Détecter les refus immédiats.
    const timer = setTimeout(() => {
      child.unref();
      resolve();
    }, 1500);
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Navigateur non ouvert. Copiez le lien affiché.'));
    });
  });
}
