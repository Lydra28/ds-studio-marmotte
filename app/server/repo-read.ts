import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import { proposeFromRepo, type PlanEntry, type PlanToken, type RepoMode, type RepoReport } from '../shared/repo-propose.js';
import { isScannable, scanRepo, type RepoScan } from '../shared/repo-scan.js';
import { atomicWrite, readPrivate } from './files.js';
import type { GithubAuth } from './github-auth.js';
import { StudioError } from './store.js';
import { readTarGz, type TarResult } from './tar.js';

// Lecture d'un dépôt GitHub (plan GitHub, G2) : archive de la branche en
// mémoire, fichiers de style filtrés, détecteurs de `repo-scan`. Rien n'est
// écrit sur le disque du dépôt ; rien n'est exécuté. Bornes : hypothèses du
// plan, gardées après la sonde Devonia du 2026-11-06 (123 fichiers, 2,9 s).
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
  /** Commit lu (dossier racine `<owner>-<repo>-<sha>` de l'archive). */
  commit: string | null;
  scan: RepoScan;
  skipped: TarResult['skipped'];
  /** Plus de `REPO_LIMITS.files` fichiers à lire : la suite est ignorée. */
  filesTruncated: boolean;
}

export function cleanSubdir(subdir?: string | null) {
  const s = (subdir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!s) return null;
  if (s.length > 200 || s.split('/').some((p) => p === '..' || p === '.' || p === '' || !/^[\w.-]+$/.test(p)))
    throw new StudioError('Sous-dossier invalide.', 400);
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

async function fetchArchive(auth: GithubAuth, repo: string, ref: string, dir: string | null) {
  const archive = await auth.archive(repo, ref, REPO_LIMITS.archiveBytes);
  try {
    return readArchive(archive, dir);
  } catch (e) {
    throw new StudioError((e as Error).message, 422);
  }
}

/** Fichiers lus d'un commit (PR de G5 : textes de la base avant réécriture). */
export async function readRepoFiles(auth: GithubAuth, repo: string, ref: string, subdir?: string | null) {
  return (await fetchArchive(auth, repo, ref, cleanSubdir(subdir))).files;
}

export async function readRepo(auth: GithubAuth, repo: string, ref: string, subdir?: string | null): Promise<RepoRead> {
  const dir = cleanSubdir(subdir);
  const tar: TarResult = await fetchArchive(auth, repo, ref, dir);
  if (dir && tar.files.length === 0) throw new StudioError(`Aucun fichier de style lu dans ${dir}/ : vérifie le sous-dossier.`, 422);
  return {
    repo,
    ref,
    subdir: dir,
    commit: /-([0-9a-f]{7,40})$/.exec(tar.root ?? '')?.[1] ?? null,
    scan: scanRepo(tar.files, { subdir: dir ?? undefined }),
    skipped: tar.skipped,
    filesTruncated: tar.truncated,
  };
}

// --- Plan de remplacement (G3) ----------------------------------------------
// `.ds-studio/github/plan.json` du projet : refait à chaque lecture, lu par la
// PR (G5). Données du dépôt (chemins, valeurs) : restent sur le poste.

export interface RepoPlan {
  // 2 : jetons avec `value` et `uses` (G5) ; un plan plus ancien se relit.
  version: 2;
  date: string;
  repo: string;
  ref: string;
  subdir: string | null;
  commit: string | null;
  mode: RepoMode;
  report: RepoReport;
  tokens: PlanToken[];
  entries: PlanEntry[];
  truncated: boolean;
}

export const planFile = (dataDir: string) => path.join(dataDir, 'github', 'plan.json');

export async function readPlan(dataDir: string): Promise<RepoPlan | null> {
  try {
    const plan = JSON.parse(await readPrivate(planFile(dataDir), 50_000_000)) as RepoPlan;
    return plan.version === 2 ? plan : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StudioError('Plan du dépôt illisible : relis le dépôt.', 500);
  }
}

/** Lecture du dépôt rattaché au projet, proposition sur le jeu enregistré, plan écrit. */
export async function readProjectRepo(
  auth: GithubAuth,
  dataDir: string,
  github: NonNullable<Config['github']>,
  set: TokenSet,
  mode: RepoMode,
) {
  const read = await readRepo(auth, github.repo, github.base, github.subdir);
  const proposal = proposeFromRepo(read.scan, set, { mode, rename: github.rename });
  const plan: RepoPlan = {
    version: 2,
    date: new Date().toISOString(),
    repo: read.repo,
    ref: read.ref,
    subdir: read.subdir,
    commit: read.commit,
    mode,
    report: proposal.report,
    tokens: proposal.tokens,
    entries: proposal.entries,
    truncated: proposal.truncated || read.scan.truncated || read.filesTruncated,
  };
  await fs.mkdir(path.dirname(planFile(dataDir)), { recursive: true, mode: 0o700 });
  await atomicWrite(planFile(dataDir), JSON.stringify(plan) + '\n');
  return {
    changes: proposal.changes,
    rejected: proposal.rejected,
    report: proposal.report,
    source: {
      repo: read.repo,
      ref: read.ref,
      subdir: read.subdir,
      commit: read.commit,
      tailwind: read.scan.tailwind,
      skipped: read.skipped,
      truncated: plan.truncated,
    },
  };
}
