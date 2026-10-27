import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, readPrivate } from './files.js';
import { StudioError } from './store.js';
import { canonical, type State, type TokenSet } from '../shared/model.js';
import { runRules } from '../shared/rules.js';
import { components } from '../shared/components.js';
import type { Config } from '../shared/project.js';

// Une version acceptée est figée dans `versions/v<révision>.json`, avec son
// empreinte, sa cible Figma et sa révision : l'agent de transfert refuse
// d'écrire si l'un des trois ne correspond pas (docs/FIGMA.md).
export const versionHash = (set: TokenSet) =>
  createHash('sha256').update(canonical(set)).digest('hex');

export interface VersionSummary {
  revision: number;
  acceptedAt: string;
  hash: string;
  file: string;
  findings: number;
}

export async function acceptVersion(
  projectDir: string,
  config: Config,
  state: State,
  revision: number,
): Promise<VersionSummary> {
  if (revision !== state.revision)
    throw new StudioError(
      'Le Design System a changé depuis votre affichage. Rechargez avant d’accepter.',
      409,
    );
  const folder = path.join(projectDir, 'versions');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, `v${state.revision}.json`);
  const hash = versionHash(state.set);
  try {
    const existing = JSON.parse(await readPrivate(file));
    if (existing.hash !== hash)
      throw new StudioError(
        `Une version v${state.revision} différente existe déjà : fichier préservé.`,
        409,
      );
    return summarize(existing, path.basename(file));
  } catch (e) {
    if (e instanceof StudioError) throw e;
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const findings = runRules(state.set);
  const version = {
    format: 'ds-studio-version/1',
    project: config.name,
    target: config.figma,
    revision: state.revision,
    acceptedAt: new Date().toISOString(),
    hash,
    findings,
    components,
    set: state.set,
  };
  await atomicWrite(file, JSON.stringify(version, null, 2) + '\n');
  return summarize(version, path.basename(file));
}

function summarize(
  v: { revision: number; acceptedAt: string; hash: string; findings: unknown[] },
  file: string,
): VersionSummary {
  return {
    revision: v.revision,
    acceptedAt: v.acceptedAt,
    hash: v.hash,
    file,
    findings: v.findings.length,
  };
}

export async function listVersions(projectDir: string) {
  const folder = path.join(projectDir, 'versions');
  let names: string[];
  try {
    names = await fs.readdir(folder);
  } catch {
    return [];
  }
  const versions: VersionSummary[] = [];
  for (const name of names.filter((n) => /^v\d+\.json$/.test(n)))
    try {
      versions.push(summarize(JSON.parse(await readPrivate(path.join(folder, name))), name));
    } catch {
      /* Fichier illisible : ignoré dans la liste, jamais supprimé. */
    }
  return versions.sort((a, b) => b.revision - a.revision);
}
