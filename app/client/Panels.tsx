import { useEffect, useRef } from 'react';
import type { Patch, Proposal, State, TokenValue } from '../shared/model.js';
import { rules, type Finding } from '../shared/rules.js';
import type { ComponentDoc } from '../shared/components.js';
import type { VersionSummary } from './api.js';

const sourceLabel: Record<string, string> = {
  manual: 'manuel',
  import: 'import',
  undo: 'annulation',
  correction: 'correction',
  migration: 'migration',
  codex: 'Codex (V1)',
};

function Value({ v }: { v: TokenValue | undefined }) {
  if (v === undefined) return <span className="none">—</span>;
  const color = typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  return (
    <span className="value">
      {color && <span className="dot" style={{ background: v }} />}
      {String(v)}
    </span>
  );
}

// Champs d'une fiche de composant, dans l'ordre d'affichage du diff.
const fieldLabel: Record<keyof ComponentDoc, string> = {
  status: 'statut',
  props: 'propriétés',
  role: 'rôle',
  use: 'quand l’utiliser',
  avoid: 'quand l’éviter',
  a11y: 'accessibilité',
  tokens: 'tokens',
};
const fieldText = (doc: ComponentDoc | null, f: keyof ComponentDoc) => {
  if (!doc) return undefined;
  if (f === 'props')
    return Object.entries(doc.props)
      .map(([k, v]) => `${k}=${v.join('/')}`)
      .join(' · ');
  if (f === 'tokens') return doc.tokens.join(', ');
  return doc[f];
};

function ComponentRows({ patch }: { patch: Extract<Patch, { kind: 'component' }> }) {
  const label = !patch.before ? 'ajouté' : !patch.after ? 'retiré' : '';
  const fields = (Object.keys(fieldLabel) as (keyof ComponentDoc)[]).filter(
    (f) => (fieldText(patch.before, f) || '') !== (fieldText(patch.after, f) || ''),
  );
  return (
    <>
      {fields.map((f) => (
        <tr key={f}>
          <th scope="row">
            <code>{patch.key}</code> <small>{fieldLabel[f]}</small>{' '}
            {label && <small className="tag">{label}</small>}
          </th>
          <td>
            <Value v={fieldText(patch.before, f)} />
          </td>
          <td>
            <Value v={fieldText(patch.after, f)} />
          </td>
        </tr>
      ))}
    </>
  );
}

function PatchRows({ patch }: { patch: Patch }) {
  if (patch.kind === 'component') return <ComponentRows patch={patch} />;
  const modes = [
    ...new Set([
      ...Object.keys(patch.before?.$values ?? {}),
      ...Object.keys(patch.after?.$values ?? {}),
    ]),
  ];
  const label = !patch.before ? 'ajouté' : !patch.after ? 'retiré' : '';
  return (
    <>
      {modes
        .filter((m) => patch.before?.$values[m] !== patch.after?.$values[m])
        .map((m) => (
          <tr key={m}>
            <th scope="row">
              <code>{patch.key}</code> {modes.length > 1 && <small>{m}</small>}{' '}
              {label && <small className="tag">{label}</small>}
            </th>
            <td>
              <Value v={patch.before?.$values[m]} />
            </td>
            <td>
              <Value v={patch.after?.$values[m]} />
            </td>
          </tr>
        ))}
    </>
  );
}

export function DiffDialog({
  proposal,
  busy,
  onCancel,
  onValidate,
}: {
  proposal: Proposal;
  busy: boolean;
  onCancel: () => void;
  onValidate: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="diff" aria-labelledby="diff-title" onCancel={onCancel}>
      <h2 id="diff-title">
        Diff · {sourceLabel[proposal.source]} · {proposal.patches.length} changement(s)
      </h2>
      <p className="hint">Rien n’est écrit tant que tu n’as pas validé.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Avant</th>
              <th scope="col">Après</th>
            </tr>
          </thead>
          <tbody>
            {proposal.patches.map((p) => (
              <PatchRows key={`${p.kind ?? 'token'}:${p.key}`} patch={p} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="dialog-actions">
        <button onClick={onCancel} autoFocus>
          Annuler
        </button>
        <button className="primary" disabled={busy} onClick={onValidate}>
          Valider et enregistrer
        </button>
      </div>
    </dialog>
  );
}

export function Corrections({
  findings,
  onFix,
}: {
  findings: Finding[];
  onFix: (f: Finding) => void;
}) {
  return (
    <section className="corrections" aria-labelledby="h-corr">
      <h2 id="h-corr">Corrections</h2>
      {findings.length === 0 ? (
        <p className="hint">
          Aucun écart sur {rules.length} règles : {rules.map((r) => r.label.toLowerCase()).join(', ')}.
        </p>
      ) : (
        <ul>
          {findings.map((f, i) => (
            <li key={`${f.rule}-${f.key}-${f.mode}-${i}`}>
              <p>
                <code>{f.key}</code> {f.mode && <small>{f.mode}</small>}
                <br />
                {f.message}
              </p>
              {f.fix ? (
                <button onClick={() => onFix(f)}>Essayer {f.fixLabel}</button>
              ) : (
                f.fixLabel && <small className="hint">Piste : {f.fixLabel}</small>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HistoryPanel({
  state,
  versions,
  onClose,
  onUndo,
}: {
  state: State;
  versions: VersionSummary[];
  onClose: () => void;
  onUndo: (id: string) => void;
}) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" aria-label="Historique" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Historique</h2>
          <button onClick={onClose} aria-label="Fermer l’historique">
            Fermer
          </button>
        </header>
        <h3>Versions acceptées</h3>
        {versions.length ? (
          <ul className="versions">
            {versions.map((v) => (
              <li key={v.file}>
                <strong>v{v.revision}</strong> · {new Date(v.acceptedAt).toLocaleString('fr-FR')} ·{' '}
                <code>{v.hash.slice(0, 8)}</code>
                {v.findings > 0 && <small> · {v.findings} écart(s)</small>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Aucune version acceptée.</p>
        )}
        <h3>Révisions</h3>
        <ol className="revisions" reversed>
          {[...state.history].reverse().map((r) => (
            <li key={r.id}>
              <p>
                <strong>r{r.revision}</strong> · {sourceLabel[r.source]} ·{' '}
                {new Date(r.date).toLocaleString('fr-FR')}
              </p>
              <p className="keys">
                {r.patches
                  .slice(0, 4)
                  .map((p) => p.key)
                  .join(', ')}
                {r.patches.length > 4 && ` +${r.patches.length - 4}`}
              </p>
              <button onClick={() => onUndo(r.id)}>Annuler cette révision</button>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
