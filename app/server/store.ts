import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite, readPrivate } from './files.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  applyChanges,
  applyPatches,
  diff,
  isV1Tokens,
  migrateV1State,
  migrateV1Tokens,
  patchTarget,
  sameToken,
  stateSchema,
  tokenSetSchema,
  type Change,
  type State,
  type TokenSet,
  type Proposal,
  type Revision,
} from '../shared/model.js';
import { componentsFileSchema, isComponentsFile } from '../shared/components.js';

export class StudioError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export class Store {
  private state!: State;
  private digest = '';
  private queue: Promise<unknown> = Promise.resolve();
  private proposals = new Map<string, Proposal>();
  readonly file: string;
  constructor(
    readonly directory: string,
    private seed: TokenSet,
  ) {
    this.file = path.join(directory, 'state.json');
  }
  async init() {
    tokenSetSchema.parse(this.seed);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(this.directory)).isSymbolicLink())
      throw new StudioError('Dossier de données symbolique refusé.', 500);
    let raw: string;
    try {
      raw = await readPrivate(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new StudioError(
          'state.json inaccessible : original préservé. Sauvegardez-le avant toute réparation.',
          500,
        );
      this.state = {
        version: 2,
        revision: 0,
        set: structuredClone(this.seed),
        history: [],
      };
      await this.write(this.state);
      return;
    }
    try {
      this.state = parseStoredState(raw);
    } catch {
      throw new StudioError(
        'state.json invalide : original préservé. Sauvegardez-le avant toute réparation.',
        500,
      );
    }
    if (JSON.parse(raw).version === 1) {
      // Migration non destructive : l'original v1 est archivé avant réécriture.
      await atomicWrite(
        path.join(this.directory, `state-v1-preserved-${randomUUID()}.json`),
        raw,
      );
      await this.write(this.state);
    } else this.digest = this.hash(raw);
    // Instance créée avant les fiches éditables : elles arrivent par une
    // révision « migration », visible et annulable comme les autres.
    if (!this.state.set.components && this.seed.components) {
      const next = { ...this.state.set, components: structuredClone(this.seed.components) };
      await this.commit(this.proposeSet(this.state.revision, next, 'migration').id);
    }
  }
  snapshot(): State {
    return structuredClone(this.state);
  }
  async flush() {
    await this.queue;
  }
  private proposeSet(
    revision: number,
    next: TokenSet,
    source: Revision['source'],
  ): Proposal {
    if (revision !== this.state.revision)
      throw new StudioError(
        'Le Design System a changé. Rechargez et refaites la proposition.',
        409,
      );
    const patches = diff(this.state.set, next);
    if (!patches.length) throw new StudioError('Aucune modification.');
    if (this.proposals.size >= 100)
      this.proposals.delete(this.proposals.keys().next().value!);
    const proposal = { id: randomUUID(), revision, source, patches };
    this.proposals.set(proposal.id, proposal);
    return structuredClone(proposal);
  }
  propose(
    revision: number,
    changes: Change[],
    source: Revision['source'] = 'manual',
  ): Proposal {
    let next: TokenSet;
    try {
      next = applyChanges(this.state.set, changes);
    } catch (e) {
      throw new StudioError((e as Error).message);
    }
    return this.proposeSet(revision, next, source);
  }
  proposeImport(revision: number, input: unknown) {
    if (isComponentsFile(input)) {
      // Fiches préparées par l'agent : ajoutées ou remplacées, jamais retirées.
      const file = componentsFileSchema.parse(input);
      const current = this.state.set;
      return this.proposeSet(
        revision,
        { ...current, components: { ...current.components, ...file.components } },
        'import',
      );
    }
    const set = isV1Tokens(input)
      ? migrateV1Tokens(input)
      : tokenSetSchema.parse(input);
    const current = this.state.set.modes;
    for (const c of Object.keys(current) as (keyof typeof current)[])
      if (current[c].join(',') !== set.modes[c].join(','))
        throw new StudioError(
          `Modes différents pour ${c} : ${set.modes[c].join(', ')} au lieu de ${current[c].join(', ')}. Une migration est nécessaire.`,
        );
    // Un jeu de tokens sans fiches ne retire pas les fiches existantes.
    if (!set.components && this.state.set.components)
      set.components = structuredClone(this.state.set.components);
    return this.proposeSet(revision, set, 'import');
  }
  proposeUndo(revision: number, id: string) {
    const event = this.state.history.find((r) => r.id === id);
    if (!event) throw new StudioError('Révision inconnue.', 404);
    for (const p of event.patches)
      if (!sameToken(patchTarget(this.state.set, p), p.after))
        throw new StudioError(
          `Conflit sur ${p.key} : un changement plus récent serait perdu.`,
          409,
        );
    let next: TokenSet;
    try {
      next = applyPatches(this.state.set, event.patches, 'before');
    } catch (e) {
      throw new StudioError(
        `Annulation impossible : ${(e as Error).message}`,
        409,
      );
    }
    return this.proposeSet(revision, next, 'undo');
  }
  commit(id: string): Promise<State> {
    const work = this.queue.then(async () => {
      const p = this.proposals.get(id);
      if (!p)
        throw new StudioError(
          'Proposition inconnue ou expirée. Refaites le diff.',
          404,
        );
      if (p.revision !== this.state.revision)
        throw new StudioError('Proposition périmée. Refaites le diff.', 409);
      const raw = await readPrivate(this.file);
      if (this.hash(raw) !== this.digest)
        throw new StudioError(
          'Données modifiées hors application. Redémarrez pour les relire.',
          409,
        );
      const next: State = {
        ...this.state,
        revision: this.state.revision + 1,
        set: applyPatches(this.state.set, p.patches),
        history: [
          ...this.state.history,
          {
            ...p,
            revision: this.state.revision + 1,
            date: new Date().toISOString(),
          },
        ],
      };
      // Pas de mise à jour en mémoire ni à l'écran avant la réussite du remplacement disque.
      // La copie précédente est complète avant de remplacer l’état courant.
      await atomicWrite(path.join(this.directory, 'state.previous.json'), raw);
      await this.write(next);
      this.state = next;
      this.proposals.delete(id);
      return this.snapshot();
    });
    this.queue = work.catch(() => {});
    return work;
  }
  private hash(raw: string) {
    return createHash('sha256').update(raw).digest('hex');
  }
  private async write(state: State) {
    const raw = JSON.stringify(state, null, 2) + '\n';
    if (Buffer.byteLength(raw) > 10_000_000)
      throw new StudioError(
        'Historique trop volumineux : exportez et archivez avant de continuer.',
        507,
      );
    await atomicWrite(this.file, raw);
    this.digest = this.hash(raw);
  }
}

export function parseStoredState(raw: string): State {
  const input = JSON.parse(raw);
  const state = stateSchema.parse(
    input?.version === 1 ? migrateV1State(input) : input,
  );
  if (state.history.length !== state.revision)
    throw new Error('Historique incohérent');
  for (const [i, r] of state.history.entries())
    if (r.revision !== i + 1) throw new Error('Historique non ordonné');
  // Relecture inverse : chaque patch doit réellement correspondre à l'état enregistré.
  let set = structuredClone(state.set);
  for (const r of [...state.history].reverse()) {
    if (new Set(r.patches.map((p) => p.key)).size !== r.patches.length)
      throw new Error('Doublon');
    for (const p of r.patches)
      if (!sameToken(patchTarget(set, p), p.after))
        throw new Error('Patch incohérent');
    set = applyPatches(set, r.patches, 'before');
  }
  return state;
}

// À appeler uniquement sous le bail serveur, après confirmation explicite.
export async function restorePrevious(directory: string) {
  const previous = await readPrivate(
    path.join(directory, 'state.previous.json'),
  );
  const state = parseStoredState(previous);
  const file = path.join(directory, 'state.json');
  const original = await readPrivate(file);
  const archive = path.join(directory, `state-preserved-${randomUUID()}.json`);
  await atomicWrite(archive, original);
  await atomicWrite(file, previous);
  return { revision: state.revision, preserved: path.basename(archive) };
}
