import { isScannable, scanRepo, type RepoScan } from '../shared/repo-scan.js';
import type { GithubAuth } from './github-auth.js';
import { StudioError } from './store.js';
import { readTarGz, type TarResult } from './tar.js';

// Lecture d'un dépôt GitHub (plan GitHub, G2) : archive de la branche en
// mémoire, fichiers de style filtrés, détecteurs de `repo-scan`. Rien n'est
// écrit sur le disque ; rien n'est exécuté. Bornes : hypothèses du plan, à
// revoir sur Devonia (revoir quand la sonde Devonia est rendue).
export const REPO_LIMITS = {
  archiveBytes: 50_000_000,
  unpackedBytes: 250_000_000,
  files: 5000,
  fileBytes: 1_000_000,
};

export interface RepoRead {
  repo: string;
  ref: string;
  subdir: string | null;
  scan: RepoScan;
  skipped: TarResult['skipped'];
  /** Plus de `REPO_LIMITS.files` fichiers à lire : la suite est ignorée. */
  filesTruncated: boolean;
}

export function cleanSubdir(subdir?: string | null) {
  const s = (subdir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (s.length > 200 || s.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new StudioError('Sous-dossier invalide.', 400);
  return s;
}

export function readArchive(archive: Buffer, subdir: string | null) {
  const prefix = subdir ? subdir + '/' : '';
  return readTarGz(archive, {
    maxBytes: REPO_LIMITS.unpackedBytes,
    maxFiles: REPO_LIMITS.files,
    maxFileBytes: REPO_LIMITS.fileBytes,
    accept: (p) => p.startsWith(prefix) && isScannable(p),
  });
}

export async function readRepo(auth: GithubAuth, repo: string, ref: string, subdir?: string | null): Promise<RepoRead> {
  const dir = cleanSubdir(subdir);
  const archive = await auth.archive(repo, ref, REPO_LIMITS.archiveBytes);
  let tar: TarResult;
  try {
    tar = readArchive(archive, dir);
  } catch (e) {
    throw new StudioError((e as Error).message, 422);
  }
  return { repo, ref, subdir: dir, scan: scanRepo(tar.files, { subdir: dir ?? undefined }), skipped: tar.skipped, filesTruncated: tar.truncated };
}
