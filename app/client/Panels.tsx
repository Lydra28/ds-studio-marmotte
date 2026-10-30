import { useEffect, useRef, useState } from 'react';
import type { Patch, Proposal, State, TokenSet, TokenValue } from '../shared/model.js';
import { exportCss, exportTailwind } from '../shared/export.js';
import { downloadText } from './api.js';
import { rules, type Finding } from '../shared/rules.js';
import type { ComponentDoc } from '../shared/components.js';
import type { VersionSummary } from './api.js';
import type { Config } from '../shared/project.js';

export const sourceLabel: Record<string, string> = {
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

// Résumé d'un diff : ce qui est ajouté, modifié ou retiré, tokens et fiches à part.
export function diffSummary(patches: Patch[]) {
  const count = (kind: 'token' | 'component', what: 'added' | 'changed' | 'removed') =>
    patches.filter(
      (p) =>
        (p.kind === 'component') === (kind === 'component') &&
        (what === 'added' ? !p.before : what === 'removed' ? !p.after : p.before && p.after),
    ).length;
  const part = (kind: 'token' | 'component', noun: string) => {
    const [a, c, r] = (['added', 'changed', 'removed'] as const).map((w) => count(kind, w));
    const bits = [a && `${a} ajouté(s)`, c && `${c} modifié(s)`, r && `${r} retiré(s)`].filter(Boolean);
    return bits.length ? `${noun} : ${bits.join(', ')}` : '';
  };
  return [part('token', 'Tokens'), part('component', 'Fiches')].filter(Boolean).join(' · ') || 'Aucun changement';
}

// Tableau avant / après d'une liste de patchs : diff d'une proposition,
// comparaison de deux versions, ou de l'état courant avec la dernière version.
export function ChangesDialog({
  title,
  hint,
  patches,
  busy,
  cancelLabel = 'Annuler',
  onCancel,
  confirmLabel,
  onConfirm,
}: {
  title: string;
  hint: string;
  patches: Patch[];
  busy?: boolean;
  cancelLabel?: string;
  onCancel: () => void;
  confirmLabel?: string;
  onConfirm?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="diff" aria-labelledby="diff-title" onCancel={onCancel}>
      <h2 id="diff-title">{title}</h2>
      <p className="diff-summary">{diffSummary(patches)}</p>
      <p className="hint">{hint}</p>
      {patches.length > 0 && (
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
              {patches.map((p) => (
                <PatchRows key={`${p.kind ?? 'token'}:${p.key}`} patch={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="dialog-actions">
        <button onClick={onCancel} autoFocus>
          {cancelLabel}
        </button>
        {onConfirm && (
          <button className="primary" disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </button>
        )}
      </div>
    </dialog>
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
  return (
    <ChangesDialog
      title={`Diff · ${sourceLabel[proposal.source]} · ${proposal.patches.length} changement(s)`}
      hint="Rien n’est écrit tant que tu n’as pas validé."
      patches={proposal.patches}
      busy={busy}
      onCancel={onCancel}
      confirmLabel="Valider et enregistrer"
      onConfirm={onValidate}
    />
  );
}

export function Corrections({
  findings,
  onFix,
  onFixAll,
}: {
  findings: Finding[];
  onFix: (f: Finding) => void;
  onFixAll: (list: Finding[]) => void;
}) {
  const fixable = findings.filter((f) => f.fix);
  return (
    <section className="corrections" id="corrections" aria-labelledby="h-corr">
      <div className="corrections-head">
        <h2 id="h-corr">Corrections</h2>
        {fixable.length > 0 && (
          <button className="primary" onClick={() => onFixAll(fixable)}>
            Tout corriger ({fixable.length})
          </button>
        )}
      </div>
      {findings.length > 0 && (
        <p className="hint">
          {fixable.length
            ? 'Chaque correction rejoint le brouillon : rien n’est enregistré avant le diff.'
            : 'Aucune correction automatique : ces écarts se règlent à la main (piste indiquée), ou avec l’assistant.'}
        </p>
      )}
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

export function History({
  state,
  versions,
  onUndo,
  onCompare,
  onSideBySide,
}: {
  state: State;
  versions: VersionSummary[];
  onUndo: (id: string) => void;
  onCompare: (revision: number, previous?: number) => void;
  onSideBySide: (revision: number, previous?: number) => void;
}) {
  return (
    <div className="history" role="region" aria-label="Historique">
      <section>
        <h3>Versions acceptées</h3>
        {versions.length ? (
          <ul className="versions">
            {versions.map((v, i) => (
              <li key={v.file}>
                <strong>v{v.revision}</strong> · {new Date(v.acceptedAt).toLocaleString('fr-FR')} ·{' '}
                <code>{v.hash.slice(0, 8)}</code>
                {v.findings > 0 && <small> · {v.findings} écart(s)</small>}
                <button onClick={() => onCompare(v.revision, versions[i + 1]?.revision)}>
                  {versions[i + 1] !== undefined ? `Comparer avec v${versions[i + 1].revision}` : 'Voir le contenu'}
                </button>
                <button onClick={() => onSideBySide(v.revision, versions[i + 1]?.revision)}>Côte à côte</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Aucune version acceptée.</p>
        )}
      </section>
      <section>
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
      </section>
    </div>
  );
}

// Plugin Figma DS-Studio : où l'installer, le code d'appairage, la cible du projet.
export function FigmaDialog({
  code,
  config,
  onClose,
}: {
  code: string | null;
  config: Config | undefined;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const target = config?.figma;
  return (
    <dialog ref={dialog} className="diff figma-dialog" aria-labelledby="figma-title" onCancel={onClose}>
      <h2 id="figma-title">Plugin Figma DS-Studio</h2>
      <p className="hint">
        {target ? (
          <>
            Fichier cible : <code>{target.fileKey}</code>, page « {target.page} ». Le plugin refuse tout autre fichier.
          </>
        ) : (
          'Ce projet n’a pas de fichier Figma cible : le plugin peut lire ses composants, pas y transférer.'
        )}
      </p>
      <p>
        Code d’appairage : <code className="pair">{code ?? 'plugin désactivé'}</code>
      </p>
      <ol>
        <li>
          Figma → Plugins → rechercher « DS-Studio » dans la Community (une seule fois). En développement : Figma
          Desktop → Plugins → Développement → Importer un plugin depuis un manifeste… →{' '}
          <code>studio/figma-plugin/manifest.json</code>.
        </li>
        <li>Ouvre le fichier cible, lance DS-Studio, colle le code. Fichier non identifié : colle son lien (Partager → Copier le lien).</li>
        <li>
          « Transférer » écrit la dernière version acceptée ; « Envoyer les composants » les renvoie ici, à relire par
          diff.
        </li>
      </ol>
      <div className="dialog-actions">
        <button onClick={onClose} autoFocus>
          Fermer
        </button>
      </div>
    </dialog>
  );
}

// Export du code en un clic : l'état enregistré, avec les noms du code du
// projet (`github.rename`) comme la PR. JSON : le jeu de l'atelier, réimportable.
const formats = [
  ['css', 'CSS', 'tokens.css', 'text/css'],
  ['tailwind', 'Tailwind v4', 'tailwind.css', 'text/css'],
  ['json', 'JSON', 'tokens.json', 'application/json'],
] as const;
export function ExportDialog({
  set,
  name,
  revision,
  config,
  drafts,
  onClose,
}: {
  set: TokenSet;
  name: string;
  revision: number;
  config: Config | undefined;
  drafts: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<(typeof formats)[number][0]>('css');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const naming = { rename: config?.github?.rename ?? {}, mobileQuery: config?.github?.mobileQuery ?? '(max-width: 767.98px)' };
  const header = `DS-Studio · ${name} · r${revision}`;
  const code =
    format === 'css'
      ? exportCss(set, naming, header)
      : format === 'tailwind'
        ? exportTailwind(set, naming, header)
        : JSON.stringify(set, null, 2) + '\n';
  const [, label, file, type] = formats.find(([id]) => id === format)!;
  const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ds';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Presse-papiers refusé (app desktop, contexte non sûr) : ancienne méthode.
      const area = Object.assign(document.createElement('textarea'), { value: code, readOnly: true });
      dialog.current?.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <dialog ref={dialog} className="diff export-dialog" aria-labelledby="export-title" onCancel={onClose}>
      <h2 id="export-title">Exporter le code</h2>
      <p className="hint">
        État enregistré r{revision}
        {drafts > 0 && ` · ${drafts} changement(s) en brouillon non inclus`}
        {Object.keys(naming.rename).length > 0 && ' · noms des variables du code du projet'}
      </p>
      <div className="export-tabs" role="tablist" aria-label="Format">
        {formats.map(([id, text]) => (
          <button
            key={id}
            role="tab"
            aria-selected={format === id}
            onClick={() => {
              setFormat(id);
              setCopied(false);
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <pre className="export-code" role="tabpanel" aria-label={`Code ${label}`} tabIndex={0}>
        <code>{code}</code>
      </pre>
      <div className="dialog-actions">
        <button onClick={onClose}>Fermer</button>
        <button onClick={() => downloadText(`${slug}.${file}`, code, type)}>Télécharger</button>
        <button className="primary" onClick={() => void copy()} autoFocus>
          {copied ? 'Copié ✓' : 'Copier'}
        </button>
      </div>
    </dialog>
  );
}
