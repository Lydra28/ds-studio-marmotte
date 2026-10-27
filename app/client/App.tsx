import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyChanges,
  referrers,
  type Change,
  type Proposal,
  type State,
  type Token,
  type TokenSet,
  type TokenValue,
} from '../shared/model.js';
import { runRules } from '../shared/rules.js';
import {
  accept,
  bootstrap,
  commit,
  exportSet,
  getState,
  getVersions,
  propose,
  proposeImport,
  proposeUndo,
  type Bootstrap,
  type VersionSummary,
} from './api.js';
import Board from './Board.js';
import { Corrections, DiffDialog, HistoryPanel } from './Panels.js';

const devices = [
  { label: '320', width: 320 },
  { label: '375', width: 375 },
  { label: '430', width: 430 },
  { label: '1024', width: 1024 },
];
const draftKey = (k: string, m: string) => `${k}@${m}`;
function stored<V>(name: string): Map<string, V> {
  try {
    return new Map(JSON.parse(sessionStorage.getItem(name) || '[]'));
  } catch {
    return new Map();
  }
}

function useCommittedState() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const s = await getState();
        if (live) {
          setState((c) => (!c || s.revision >= c.revision ? s : c));
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    const channel = new BroadcastChannel('ds-studio');
    channel.onmessage = refresh;
    return () => {
      live = false;
      clearInterval(timer);
      channel.close();
    };
  }, []);
  return { state, setState, error };
}
function announce() {
  const c = new BroadcastChannel('ds-studio');
  c.postMessage('updated');
  c.close();
}

export default function App() {
  const { state, setState, error: stateError } = useCommittedState();
  const [boot, setBoot] = useState<Bootstrap>();
  // Brouillon : valeurs changées (clé@mode) et structure (token ajouté, ou
  // null pour un token retiré).
  const [drafts, setDrafts] = useState<Map<string, TokenValue>>(() => stored('ds-drafts'));
  const [structure, setStructure] = useState<Map<string, Token | null>>(() =>
    stored('ds-structure'),
  );
  const [proposal, setProposal] = useState<Proposal>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [device, setDevice] = useState(1);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bootstrap().then(setBoot).catch((e) => setError(e.message));
    getVersions().then(setVersions).catch(() => {});
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem('ds-drafts', JSON.stringify([...drafts]));
      sessionStorage.setItem('ds-structure', JSON.stringify([...structure]));
    } catch {
      /* Stockage navigateur facultatif : brouillon en mémoire seulement. */
    }
  }, [drafts, structure]);

  const changes: Change[] = [
    ...[...structure].map(([key, token]): Change =>
      token ? { op: 'add', key, token } : { op: 'remove', key },
    ),
    ...[...drafts].map(([id, value]) => {
      const at = id.lastIndexOf('@');
      return { key: id.slice(0, at), mode: id.slice(at + 1), value };
    }),
  ];
  const draftCount = drafts.size + structure.size;
  const clearDrafts = () => {
    setDrafts(new Map());
    setStructure(new Map());
  };
  const { draftSet, draftError } = useMemo(() => {
    if (!state) return { draftSet: undefined, draftError: '' };
    if (!changes.length) return { draftSet: state.set, draftError: '' };
    try {
      return { draftSet: applyChanges(state.set, changes), draftError: '' };
    } catch (e) {
      return { draftSet: state.set, draftError: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, drafts, structure]);
  const findings = useMemo(() => (draftSet ? runRules(draftSet) : []), [draftSet]);

  // La preview reçoit le jeu courant, brouillon compris, à chaque changement.
  const pushPreview = (set: TokenSet | undefined) =>
    set && frame.current?.contentWindow?.postMessage({ type: 'ds-set', set }, location.origin);
  useEffect(() => pushPreview(draftSet), [draftSet]);
  useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (e.origin === location.origin && e.data?.type === 'ds-ready') pushPreview(draftSet);
    };
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [draftSet]);

  const run = async (action: () => Promise<void>) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const edit = (key: string, mode: string, value: TokenValue) => {
    const added = structure.get(key);
    if (added) {
      // Token ajouté dans ce brouillon : sa valeur vit dans le token lui-même.
      setStructure((s) =>
        new Map(s).set(key, { ...added, $values: { ...added.$values, [mode]: value } }),
      );
      return;
    }
    setDrafts((d) => {
      const next = new Map(d);
      const committed = state?.set.tokens[key]?.$values[mode];
      if (committed === value) next.delete(draftKey(key, mode));
      else next.set(draftKey(key, mode), value);
      return next;
    });
  };
  const add = (key: string, token: Token) =>
    setStructure((s) => {
      const next = new Map(s);
      // Retiré puis rajouté sous le même nom : on remplace l'ancien.
      if (s.get(key) === null) next.delete(key);
      return next.set(key, token);
    });
  const remove = (key: string) => {
    const users = draftSet ? referrers(draftSet, key) : [];
    if (users.length) {
      setNotice('');
      setError(`${key} est utilisé par ${users.join(', ')} : change ces alias avant de le retirer.`);
      return;
    }
    setError('');
    setDrafts((d) => new Map([...d].filter(([id]) => !id.startsWith(`${key}@`))));
    setStructure((s) => {
      const next = new Map(s);
      if (s.get(key)) next.delete(key);
      else next.set(key, null);
      return next;
    });
  };
  const reviewDrafts = () =>
    run(async () => setProposal(await propose(state!.revision, changes)));
  const validate = () =>
    run(async () => {
      const next = await commit(proposal!);
      setState(next);
      if (proposal!.source !== 'undo' && proposal!.source !== 'import') clearDrafts();
      setProposal(undefined);
      announce();
      setNotice(`Révision ${next.revision} enregistrée. Annulable depuis l’historique.`);
    });
  const acceptVersion = () =>
    run(async () => {
      const v = await accept(state!.revision);
      setVersions(await getVersions());
      setNotice(
        `Version v${v.revision} acceptée (empreinte ${v.hash.slice(0, 8)})` +
          (v.findings ? `, ${v.findings} écart(s) encore signalé(s)` : '') +
          '. Pour l’envoyer dans Figma, dis « transfère » à ton agent.',
      );
    });
  const importFile = (f: File) =>
    run(async () => {
      const json = JSON.parse(await f.text());
      setProposal(await proposeImport(state!.revision, json));
    });

  if (!state || !draftSet)
    return <p className="loading" role="alert">{stateError || error || 'Chargement…'}</p>;
  const name = boot?.config.name ?? '…';
  const accepted = versions.find((v) => v.revision === state.revision);
  return (
    <div className="studio">
      <header className="bar">
        <div className="brand">
          <strong>DS-Studio</strong>
          <span className="project">{name}</span>
          <span className="rev" title="Révision enregistrée">r{state.revision}</span>
        </div>
        <div className="actions">
          <span className={`count ${findings.length ? 'warn' : 'ok'}`}>
            {findings.length ? `${findings.length} écart(s)` : 'Aucun écart'}
          </span>
          <button onClick={() => setHistoryOpen(true)}>Historique</button>
          <button onClick={() => file.current?.click()}>Importer</button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = '';
            }}
          />
          <button onClick={() => run(() => exportSet(name))}>Exporter</button>
          <button
            className="primary"
            disabled={busy || draftCount > 0 || !!accepted}
            title={
              draftCount
                ? 'Valide ou abandonne le brouillon avant d’accepter.'
                : accepted
                  ? `Déjà acceptée : v${accepted.revision}`
                  : 'Fige cette révision pour le transfert Figma'
            }
            onClick={acceptVersion}
          >
            {accepted ? `v${accepted.revision} acceptée` : 'Accepter cette version'}
          </button>
        </div>
      </header>
      {(error || notice || stateError || draftError) && (
        <p className={`message ${error || stateError || draftError ? 'error' : 'ok'}`} role={error ? 'alert' : 'status'}>
          {error || stateError || (draftError && `Brouillon invalide : ${draftError}`) || notice}
        </p>
      )}
      <main className="layout">
        <Board
          set={draftSet}
          drafts={drafts}
          added={structure}
          findings={findings}
          onEdit={edit}
          onAdd={add}
          onRemove={remove}
        />
        <aside className="side">
          <section className="preview" aria-label="Preview en direct">
            <div className="preview-head">
              <span>Preview {draftCount ? '· brouillon' : '· enregistrée'}</span>
              <div className="devices" role="group" aria-label="Largeur d’écran">
                {devices.map((d, i) => (
                  <button key={d.width} aria-pressed={device === i} onClick={() => setDevice(i)}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="frame-wrap">
              <iframe
                ref={frame}
                title="Preview du design system"
                src="/?preview=1"
                style={{ width: devices[device].width }}
              />
            </div>
          </section>
          <Corrections
            findings={findings}
            onFix={(f) => f.fix && edit(f.fix.key, f.fix.mode, f.fix.value)}
          />
        </aside>
      </main>
      {draftCount > 0 && (
        <div className="draft-bar" role="region" aria-label="Brouillon">
          <span>
            {draftCount} changement(s) en brouillon, rien n’est encore enregistré.
          </span>
          <button onClick={clearDrafts}>Abandonner</button>
          <button className="primary" disabled={busy || !!draftError} onClick={reviewDrafts}>
            Voir le diff et valider
          </button>
        </div>
      )}
      {proposal && (
        <DiffDialog
          proposal={proposal}
          busy={busy}
          onCancel={() => setProposal(undefined)}
          onValidate={validate}
        />
      )}
      {historyOpen && (
        <HistoryPanel
          state={state}
          versions={versions}
          onClose={() => setHistoryOpen(false)}
          onUndo={(id) =>
            run(async () => {
              setHistoryOpen(false);
              setProposal(await proposeUndo(state.revision, id));
            })
          }
        />
      )}
    </div>
  );
}
