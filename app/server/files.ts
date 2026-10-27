import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Les parents sont choisis par l'opérateur. Les fichiers directs restent fermés
// aux liens et aux tailles démesurées ; aucun chemin fourni par HTTP.
export async function readPrivate(file: string, max = 10_000_000) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error('Fichier non sûr ou trop volumineux : original préservé.');
  return fs.readFile(file, 'utf8');
}
export async function atomicWrite(file: string, raw: string) {
  const temporary = path.join(
    path.dirname(file),
    `${path.basename(file)}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(raw);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}
