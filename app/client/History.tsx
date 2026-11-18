import { useMemo } from 'react';
import { diff, setsByRevision, type Patch, type State } from '../shared/model.js';
import type { VersionSummary } from './api.js';
import { sourceLabel } from './Panels.js';

// Historique (vue Versions, refondu le 2026-11-14 avec Romain, « comme
// l'historique Figma ») : une seule liste, la plus récente en haut. Chaque
// version dit en clair ce qui a changé ; « Voir » l'ouvre dans Comparer,
// « Revenir à cette version » prépare un brouillon validé par le diff (rien
// n'est écrasé sans accord). Révisions repliées dans leur version, avec
// « Annuler cette révision ».

const NOUNS: Record<string, [string, string]> = {
  color: ['couleur', 'couleurs'],
  dimension: ['taille', 'tailles'],
  fontFamily: ['police', 'polices'],
  fontWeight: ['graisse', 'graisses'],
  number: ['nombre', 'nombres'],
  component: ['fiche', 'fiches'],
};

// « 3 couleurs, 1 taille » : changements comptés par type de token.
export function changeSummary(patches: Patch[]) {
  const counts = new Map<string, number>();
  for (const p of patches) {
    const type = p.kind === 'component' ? 'component' : (p.after ?? p.before)?.$type ?? 'number';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const parts = Object.keys(NOUNS)
    .filter((t) => counts.has(t))
    .map((t) => `${counts.get(t)} ${NOUNS[t][counts.get(t)! > 1 ? 1 : 0]}`);
  return parts.join(', ') || 'Aucun changement';
}

// Pourquoi « Revenir à cette version » est grisé, dit en clair sous le bouton
// (null : le bouton est actif). Seule la version égale à l'état enregistré l'est.
export function restoreBlocked(revision: number, saved: number, draft: boolean) {
  if (revision !== saved) return null;
  return draft
    ? 'Version enregistrée en cours : le brouillon se défait par « Abandonner ».'
    : 'Version enregistrée en cours : rien à rétablir.';
}

const date = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

export default function History({
  state,
  versions,
  draft,
  onView,
  onDetail,
  onRestore,
  onUndo,
}: {
  state: State;
  versions: VersionSummary[];
  draft: boolean;
  onView: (revision: number) => void;
  onDetail: (revision: number, previous?: number) => void;
  onRestore: (revision: number) => void;
  onUndo: (id: string) => void;
}) {
  const sets = useMemo(() => setsByRevision(state), [state]);
  const asc = [...versions].sort((a, b) => a.revision - b.revision);
  const last = asc.at(-1)?.revision ?? 0;
  const between = (from: number, to: number) => state.history.filter((r) => r.revision > from && r.revision <= to);
  const pending = between(last, state.revision);

  const revisions = (list: State['history'], open = false) =>
    list.length > 0 && (
      <details className="hist__revisions" open={open}>
        <summary>
          {list.length} révision{list.length > 1 ? 's' : ''}
        </summary>
        <ol reversed>
          {[...list].reverse().map((r) => (
            <li key={r.id}>
              <span>
                <strong>r{r.revision}</strong> · {sourceLabel[r.source]} · {date(r.date)}
              </span>
              <span className="hist__keys">
                {r.patches
                  .slice(0, 4)
                  .map((p) => p.key)
                  .join(', ')}
                {r.patches.length > 4 && ` +${r.patches.length - 4}`}
              </span>
              <button onClick={() => onUndo(r.id)} aria-label={`Annuler cette révision (r${r.revision})`}>
                Annuler cette révision
              </button>
            </li>
          ))}
        </ol>
      </details>
    );

  return (
    <div className="hist" role="region" aria-label="Historique">
      <ol className="hist__list">
        {(pending.length > 0 || draft) && (
          <li className="hist__item hist__item--pending">
            <div className="hist__head">
              <strong>Pas encore acceptées</strong>
              {draft && <span className="hist__badge">brouillon en cours</span>}
            </div>
            {pending.length > 0 && (
              <p className="hist__summary">
                {changeSummary(diff(sets[last], state.set))} depuis {last ? `v${last}` : 'le départ'}
              </p>
            )}
            {revisions(pending, true)}
          </li>
        )}
        {[...asc].reverse().map((v) => {
          const i = asc.indexOf(v);
          const previous = asc[i - 1]?.revision;
          const current = v.revision === state.revision && !draft;
          // Brouillon sur la version actuelle : rien à « revenir » côté
          // enregistré, c'est « Abandonner » qui défait le brouillon.
          const blocked = restoreBlocked(v.revision, state.revision, draft);
          const why = `hist-why-${v.revision}`;
          return (
            <li key={v.file} className="hist__item">
              <div className="hist__head">
                <strong>v{v.revision}</strong>
                <span>{date(v.acceptedAt)}</span>
                {current && <span className="hist__badge">version actuelle</span>}
              </div>
              <button
                className="hist__summary hist__summary--link"
                title="Voir le détail des changements"
                onClick={() => onDetail(v.revision, previous)}
              >
                {changeSummary(diff(sets[previous ?? 0], sets[v.revision]))}
                {previous !== undefined ? ` depuis v${previous}` : ' depuis le départ'}
              </button>
              <div className="hist__actions">
                <button onClick={() => onView(v.revision)} aria-label={`Voir v${v.revision}`}>
                  Voir
                </button>
                <button
                  onClick={() => onRestore(v.revision)}
                  disabled={!!blocked}
                  aria-label={`Revenir à cette version (v${v.revision})`}
                  aria-describedby={blocked ? why : undefined}
                >
                  Revenir à cette version
                </button>
              </div>
              {blocked && (
                <p className="hist__why" id={why}>
                  {blocked}
                </p>
              )}
              {revisions(between(previous ?? 0, v.revision))}
            </li>
          );
        })}
        <li className="hist__item hist__item--start">
          <div className="hist__head">
            <strong>Départ du projet</strong>
          </div>
          <div className="hist__actions">
            <button onClick={() => onView(0)} aria-label="Voir le départ du projet">
              Voir
            </button>
          </div>
        </li>
      </ol>
    </div>
  );
}
