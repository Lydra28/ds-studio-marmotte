import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyChanges,
  diff,
  referrers,
  sameToken,
  type Change,
  type Patch,
  type Proposal,
  type State,
  type Token,
  type TokenSet,
  type TokenValue,
} from '../shared/model.js';
import { runRules } from '../shared/rules.js';
import type { ComponentDoc } from '../shared/components.js';
import {
  accept,
  bootstrap,
  commit,
  getConfig,
  getState,
  setProject,
  getVersions,
  getVersion,
  getInbox,
  publishGithub,
  type GithubResult,
  clearInbox,
  type Inbox,
  propose,
  proposeImport,
  proposeUndo,
  type Bootstrap,
  type VersionSummary,
} from './api.js';
import type { Config } from '../shared/project.js';
import Board from './Board.js';
import { foldable, Home, openSettings, SectionBar, TopNav, useRoute, type View } from './Shell.js';
import { SettingsPage } from './Settings.js';
import AssistantPanel from './Assistant.js';
import { brandColor, MascotDock } from './Mascot.js';
import Wall from './Wall.js';
import { SiteFrame, SiteFullscreen, SiteView, type Device } from './Site.js';
import { fontFamilies, loadFonts } from './fonts.js';
import { previewSrc, ScreenPicker, type Screen } from './DesignSystem.js';
import CompareView, { type Source } from './Compare.js';
import TimelineView from './Timeline.js';
import { ChangesDialog, Corrections, DiffDialog, ExportDialog, FigmaDialog, History } from './Panels.js';

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

function useCommittedState(slug: string) {
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
    const channel = new BroadcastChannel(`ds-studio:${slug}`);
    channel.onmessage = refresh;
    return () => {
      live = false;
      clearInterval(timer);
      channel.close();
    };
  }, [slug]);
  return { state, setState, error };
}
function announce(slug: string) {
  const c = new BroadcastChannel(`ds-studio:${slug}`);
  c.postMessage('updated');
  c.close();
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [bootError, setBootError] = useState('');
  const [route, go, settings] = useRoute();
  useEffect(() => {
    bootstrap().then(setBoot).catch((e) => setBootError(e.message));
  }, []);
  if (!boot) return <p className="loading" role="alert">{bootError || 'Chargement…'}</p>;
  if (settings) return <SettingsPage onBack={() => (history.length > 1 ? history.back() : go())} />;
  // Instance fixe (--project=) : pas d'accueil, son unique projet s'ouvre.
  const slug = route ?? (boot.multi ? undefined : boot.fallback);
  if (!slug) return <Home onOpen={go} />;
  setProject(slug);
  return (
    <Workspace
      key={slug}
      slug={slug}
      multi={boot.multi}
      plugin={boot.plugin}
      github={boot.github}
      relay={boot.relay}
      desktop={boot.desktop}
      onOpen={go}
    />
  );
}

function Workspace({
  slug,
  multi,
  plugin,
  github,
  relay,
  desktop,
  onOpen,
}: {
  slug: string;
  multi: boolean;
  plugin: string | null;
  github: boolean;
  relay: number | null;
  desktop: boolean;
  onOpen: (slug?: string) => void;
}) {
  const { state, setState, error: stateError } = useCommittedState(slug);
  const [config, setConfig] = useState<Config>();
  const k = (name: string) => `${name}:${slug}`;
  // Brouillon : valeurs changées (clé@mode) et structure (token ajouté, ou
  // null pour un token retiré).
  const [drafts, setDrafts] = useState<Map<string, TokenValue>>(() => stored(k('ds-drafts')));
  const [structure, setStructure] = useState<Map<string, Token | null>>(() =>
    stored(k('ds-structure')),
  );
  const [componentDrafts, setComponentDrafts] = useState<Map<string, ComponentDoc | null>>(() =>
    stored(k('ds-components')),
  );
  const [proposal, setProposal] = useState<Proposal>();
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Dernière publication GitHub (lien de la PR, ou erreur à réessayer).
  const [published, setPublished] = useState<{ revision: number; result: GithubResult }>();
  // Fiches envoyées par le plugin Figma : relues au retour sur l'atelier.
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [fromInbox, setFromInbox] = useState(false);
  useEffect(() => {
    const load = () => {
      getInbox().then(setInbox).catch(() => {});
    };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [slug]);
  // Comparaison affichée : avant d'accepter (état courant / dernière version)
  // ou entre deux versions depuis l'historique.
  const [comparison, setComparison] = useState<{ title: string; hint: string; patches: Patch[]; accept: boolean }>();
  const [view, setView] = useState<View>(() => {
    try {
      return sessionStorage.getItem(k('ds-start')) === 'wall' ? 'wall' : 'board';
    } catch {
      return 'board';
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem(k('ds-start'));
    } catch {
      /* Facultatif. */
    }
  }, []);
  // Vue Versions : onglet ouvert, et révision visée depuis la frise.
  const [versionsTab, setVersionsTab] = useState<'history' | 'timeline' | 'compare'>('history');
  const [timelineAt, setTimelineAt] = useState<number>();
  // Sections repliées de la planche : toutes au lancement (voulu par Romain),
  // puis gardées par projet le temps de la session (sessionStorage).
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const saved = sessionStorage.getItem(k('ds-folds'));
      return new Set(saved ? JSON.parse(saved) : foldable);
    } catch {
      return new Set(foldable);
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(k('ds-folds'), JSON.stringify([...folded]));
    } catch {
      /* Préférence facultative. */
    }
  }, [folded]);
  const toggleFold = (id: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const jump = (id: string) => {
    setView('board');
    setFolded((f) => {
      const next = new Set(f);
      next.delete(id);
      return next;
    });
    setTimeout(() => void document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const openVersions = (tab: 'history' | 'timeline' | 'compare', at?: number) => {
    setVersionsTab(tab);
    setTimelineAt(at);
    setView('versions');
  };
  // Hauteur de la barre du haut (elle passe à la ligne en étroit) : ancres, preview collante.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  });
  // Côtés imposés depuis l'historique ; sinon la vue choisit les siens.
  const [compareFrom, setCompareFrom] = useState<[Source, Source]>();
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try {
      return localStorage.getItem('ds-assistant') === '1';
    } catch {
      return false;
    }
  });
  const toggleAssistant = (open: boolean) => {
    setAssistantOpen(open);
    try {
      localStorage.setItem('ds-assistant', open ? '1' : '0');
    } catch {
      /* Préférence facultative. */
    }
  };
  const [device, setDevice] = useState(1);
  // Preview latérale : un écran d'exemple du DS, ou le vrai site du projet.
  const [previewScreen, setPreviewScreen] = useState<Screen | 'site'>('ds');
  const [siteFull, setSiteFull] = useState<Device>();
  const [sitePage, setSitePage] = useState<string>();
  const siteReady = !!(relay && config?.site);
  const previewSite = siteReady && previewScreen === 'site';
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Les messages de réussite couvrent le haut de la preview : ils s'effacent seuls.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  const frame = useRef<HTMLIFrameElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getConfig().then(setConfig).catch((e) => setError(e.message));
    getVersions().then(setVersions).catch(() => {});
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(k('ds-drafts'), JSON.stringify([...drafts]));
      sessionStorage.setItem(k('ds-structure'), JSON.stringify([...structure]));
      sessionStorage.setItem(k('ds-components'), JSON.stringify([...componentDrafts]));
    } catch {
      /* Stockage navigateur facultatif : brouillon en mémoire seulement. */
    }
  }, [drafts, structure, componentDrafts]);

  const changes: Change[] = [
    ...[...structure].map(([key, token]): Change =>
      token ? { op: 'add', key, token } : { op: 'remove', key },
    ),
    ...[...drafts].map(([id, value]) => {
      const at = id.lastIndexOf('@');
      return { key: id.slice(0, at), mode: id.slice(at + 1), value };
    }),
    ...[...componentDrafts].map(([name, component]): Change => ({ op: 'component', name, component })),
  ];
  const draftCount = drafts.size + structure.size + componentDrafts.size;
  const clearDrafts = () => {
    setDrafts(new Map());
    setStructure(new Map());
    setComponentDrafts(new Map());
  };
  const saveComponent = (name: string, doc: ComponentDoc | null) =>
    setComponentDrafts((d) => {
      const next = new Map(d);
      const committed = state?.set.components?.[name];
      // Retour à l'état enregistré (ou retrait d'une fiche née dans ce brouillon) : plus de brouillon.
      if (doc ? committed && sameToken(doc, committed) : !committed) next.delete(name);
      else next.set(name, doc);
      return next;
    });
  const { draftSet, draftError } = useMemo(() => {
    if (!state) return { draftSet: undefined, draftError: '' };
    if (!changes.length) return { draftSet: state.set, draftError: '' };
    try {
      return { draftSet: applyChanges(state.set, changes), draftError: '' };
    } catch (e) {
      return { draftSet: state.set, draftError: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, drafts, structure, componentDrafts]);
  const findings = useMemo(() => (draftSet ? runRules(draftSet) : []), [draftSet]);
  // Mascotte : couleur de marque du brouillon, fête des enregistrements.
  const mascotColor = useMemo(() => (draftSet ? brandColor(draftSet) : '#7C5CFF'), [draftSet]);
  const [cheer, setCheer] = useState({ n: 0, text: '' });
  const celebrate = (text: string) => setCheer((c) => ({ n: c.n + 1, text }));
  // Polices Google du jeu (brouillon compris) aussi dans l'atelier, pour les spécimens.
  useEffect(() => {
    if (draftSet) loadFonts(fontFamilies(draftSet));
  }, [draftSet]);

  // La preview reçoit le jeu courant, brouillon compris, à chaque changement.
  const pushPreview = (set: TokenSet | undefined) =>
    set && frame.current?.contentWindow?.postMessage({ type: 'ds-set', set }, location.origin);
  useEffect(() => {
    pushPreview(draftSet);
  }, [draftSet]);
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
  // Proposition de l'assistant : chaque changement rejoint le brouillon.
  const draftChanges = (list: Change[]) => {
    for (const c of list) {
      if (!('op' in c)) edit(c.key, c.mode, c.value);
      else if (c.op === 'add') add(c.key, c.token);
      else if (c.op === 'remove') remove(c.key);
      else saveComponent(c.name, c.component);
    }
    setNotice(`${list.length} changement(s) de l’assistant mis en brouillon : relis le diff avant de valider.`);
  };
  const reviewDrafts = () =>
    run(async () => setProposal(await propose(state!.revision, changes)));
  const validate = () =>
    run(async () => {
      const next = await commit(proposal!);
      setState(next);
      if (proposal!.source !== 'undo' && proposal!.source !== 'import') clearDrafts();
      if (fromInbox) {
        await clearInbox();
        setInbox(null);
        setFromInbox(false);
      }
      setProposal(undefined);
      announce(slug);
      setNotice(`Révision ${next.revision} enregistrée. Annulable depuis l’historique.`);
      celebrate('Enregistré, bien joué !');
    });
  // Jeu figé d'une version, ou jeu vide (même modes) pour la toute première.
  const versionSet = async (revision?: number): Promise<TokenSet> =>
    revision !== undefined ? (await getVersion(revision)).set : { modes: state!.set.modes, tokens: {}, components: {} };
  const reviewAcceptance = () =>
    run(async () => {
      const last = versions.find((v) => v.revision < state!.revision);
      const target = config?.figma
        ? `Le transfert appliquera ces changements au fichier Figma (page « ${config.figma.page} »).`
        : 'Aucune cible Figma pour ce projet : accepter fige la version, rien n’est envoyé dans Figma.';
      const code = config?.github
        ? github
          ? ` Une pull request sera ouverte sur ${config.github.repo} (branche ds-studio/v${state!.revision}) ; rien n’arrive sur ${config.github.base} sans ton merge.`
          : desktop
            ? ' Aucun jeton GitHub dans cette installation : la pull request ne sera pas ouverte.'
            : ' GITHUB_TOKEN absent de .env : la pull request ne sera pas ouverte.'
        : '';
      setComparison({
        title: last !== undefined
          ? `Accepter r${state!.revision} · comparée à v${last.revision}`
          : `Accepter r${state!.revision} · première version`,
        hint: target + code,
        patches: diff(await versionSet(last?.revision), state!.set),
        accept: true,
      });
    });
  const compareVersions = (revision: number, previous?: number) =>
    run(async () => {
      setComparison({
        title: previous !== undefined ? `v${revision} comparée à v${previous}` : `v${revision} · première version`,
        hint: previous !== undefined ? `Ce qui a changé entre v${previous} et v${revision}.` : 'Tout le contenu de la première version.',
        patches: diff(await versionSet(previous), await versionSet(revision)),
        accept: false,
      });
    });
  const acceptVersion = () =>
    run(async () => {
      const v = await accept(state!.revision);
      setComparison(undefined);
      if (v.github) setPublished({ revision: v.revision, result: v.github });
      celebrate(`v${v.revision} figée, bravo !`);
      setVersions(await getVersions());
      setNotice(
        `Version v${v.revision} acceptée (empreinte ${v.hash.slice(0, 8)})` +
          (v.findings ? `, ${v.findings} écart(s) encore signalé(s)` : '') +
          '. Pour l’envoyer dans Figma : plugin DS-Studio dans le fichier cible (bouton Figma).',
      );
    });
  const importFile = (f: File) =>
    run(async () => {
      const json = JSON.parse(await f.text());
      setProposal(await proposeImport(state!.revision, json));
    });

  if (!state || !draftSet)
    return <p className="loading" role="alert">{stateError || error || 'Chargement…'}</p>;
  const name = config?.name ?? '…';
  const accepted = versions.find((v) => v.revision === state.revision);
  return (
    <div className={`studio ${assistantOpen ? 'with-assistant' : ''}`}>
      <div className="work">
      <div className="top" ref={top}>
      <TopNav
        current={slug}
        name={name}
        revision={state.revision}
        multi={multi}
        onOpen={onOpen}
        view={view}
        onView={(v) => (v === 'versions' ? openVersions(versionsTab) : setView(v))}
        site={!!(relay && config?.site)}
        versions={versions.map((v) => v.revision)}
        onVersion={(revision) => openVersions('timeline', revision)}
      >
          {findings.length ? (
            <button
              className="count warn"
              title="Voir les corrections proposées"
              onClick={() => {
                setView('board');
                setTimeout(() => void document.getElementById('corrections')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
            >
              {findings.length} écart(s) · Corrections
            </button>
          ) : (
            <span className="count ok">Aucun écart</span>
          )}
          {inbox && (
            <button
              className="inbox"
              onClick={() =>
                run(async () => {
                  setFromInbox(true);
                  setProposal(await proposeImport(state.revision, inbox.file));
                })
              }
            >
              Fiches reçues de Figma ({Object.keys(inbox.file.components).length})
            </button>
          )}
          <button onClick={openSettings} title="Réglages de l’application">
            Réglages
          </button>
          <button onClick={() => setFigmaOpen(true)}>Figma</button>
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
          <button onClick={() => setExportOpen(true)}>Exporter</button>
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
            onClick={reviewAcceptance}
          >
            {accepted ? `v${accepted.revision} acceptée` : 'Accepter cette version'}
          </button>
      </TopNav>
      {view === 'board' && (
        <SectionBar folded={folded} onJump={jump} onFoldAll={(fold) => setFolded(new Set(fold ? foldable : []))} />
      )}
      </div>
      {published && (
        <p className={`message ${published.result.status === 'error' ? 'error' : 'ok'}`} role="status">
          {published.result.status === 'error' ? (
            <>
              GitHub : {published.result.message}{' '}
              <button
                onClick={() =>
                  run(async () => setPublished({ revision: published.revision, result: await publishGithub(published.revision) }))
                }
              >
                Réessayer
              </button>
            </>
          ) : published.result.status === 'unchanged' ? (
            `GitHub : ${config?.github?.repo} est déjà à jour, aucune pull request ouverte.`
          ) : (
            <>
              Pull request {published.result.status === 'opened' ? 'ouverte' : 'mise à jour'} :{' '}
              <a href={published.result.url} target="_blank" rel="noreferrer">
                {published.result.url}
              </a>
            </>
          )}
        </p>
      )}
      {(error || notice || stateError || draftError) && (
        <p className={`message ${error || stateError || draftError ? 'error' : 'ok'}`} role={error ? 'alert' : 'status'}>
          {error || stateError || (draftError && `Brouillon invalide : ${draftError}`) || notice}
          {(error || notice) && (
            <button
              className="message-close"
              aria-label="Fermer le message"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              ×
            </button>
          )}
        </p>
      )}
      {view === 'wall' && (
        <Wall
          project={slug}
          base={state.set}
          onBack={() => setView('board')}
          onChoose={(list) => {
            draftChanges(list);
            setView('board');
          }}
        />
      )}
      {view === 'site' && relay && config?.site && draftSet && (
        <SiteView slug={slug} relay={relay} config={config} set={draftSet} draft={draftCount > 0} onBack={() => setView('board')} />
      )}
      {view === 'versions' && config && (
        <div className="versions-view">
          <div className="tabs" role="tablist" aria-label="Versions">
            {(
              [
                ['history', 'Historique'],
                ['timeline', 'Évolution'],
                ['compare', 'Comparer'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={versionsTab === tab}
                onClick={() => {
                  if (tab === 'compare') setCompareFrom(undefined);
                  openVersions(tab);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {versionsTab === 'history' && (
            <History
              state={state}
              versions={versions}
              onUndo={(id) => run(async () => setProposal(await proposeUndo(state.revision, id)))}
              onCompare={compareVersions}
              onSideBySide={(revision, previous) => {
                setCompareFrom([previous ?? revision, revision]);
                openVersions('compare');
              }}
            />
          )}
          {versionsTab === 'timeline' && (
            <TimelineView
              key={timelineAt ?? 'last'}
              slug={slug}
              relay={relay}
              config={config}
              state={state}
              versions={versions}
              draftSet={draftSet}
              draft={draftCount > 0}
              initial={timelineAt}
            />
          )}
          {versionsTab === 'compare' && (
            <CompareView
              slug={slug}
              relay={relay}
              config={config}
              state={state}
              versions={versions}
              draftSet={draftSet}
              draft={draftCount > 0}
              initial={compareFrom}
            />
          )}
        </div>
      )}
      <main className="layout" hidden={view !== 'board'}>
        <Board
          set={draftSet}
          drafts={drafts}
          added={structure}
          findings={findings}
          onEdit={edit}
          onAdd={add}
          onRemove={remove}
          componentDrafts={componentDrafts}
          onComponent={saveComponent}
          folded={folded}
          onFold={toggleFold}
        />
        <aside className="side">
          <section className="preview" aria-label="Preview en direct">
            <div className="preview-head">
              <span>Preview {draftCount ? '· brouillon' : '· enregistrée'}</span>
              <ScreenPicker value={previewSite ? 'site' : previewScreen === 'site' ? 'ds' : previewScreen} onChange={setPreviewScreen} site={siteReady} />
              {previewSite && (
                <button onClick={() => setSiteFull(devices[device].width >= 1024 ? 'desktop' : 'mobile')}>Plein écran</button>
              )}
              <div className="devices" role="group" aria-label="Largeur d’écran">
                {devices.map((d, i) => (
                  <button key={d.width} aria-pressed={device === i} onClick={() => setDevice(i)}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="frame-wrap">
              {previewSite ? (
                <SiteFrame
                  slug={slug}
                  relay={relay!}
                  config={config!}
                  set={draftSet}
                  page={sitePage ?? config!.site!.pages[0]}
                  width={devices[device].width}
                  height={720}
                  title="Site en direct dans la preview"
                />
              ) : (
                <iframe
                  ref={frame}
                  title="Preview du design system"
                  src={previewSrc(previewScreen === 'site' ? 'ds' : previewScreen)}
                  style={{ width: devices[device].width }}
                />
              )}
            </div>
          </section>
          <Corrections
            findings={findings}
            onFix={(f) => f.fix && edit(f.fix.key, f.fix.mode, f.fix.value)}
            onFixAll={(list) => {
              for (const f of list) if (f.fix) edit(f.fix.key, f.fix.mode, f.fix.value);
              setNotice(`${list.length} correction(s) mises en brouillon : relis le diff avant de valider.`);
            }}
          />
        </aside>
      </main>
      </div>
      {assistantOpen ? (
        <AssistantPanel color={mascotColor} desktop={desktop} onDraft={draftChanges} onClose={() => toggleAssistant(false)} />
      ) : (
        <MascotDock
          color={mascotColor}
          findings={findings.length}
          cheer={cheer}
          raised={draftCount > 0}
          onOpen={() => toggleAssistant(true)}
        />
      )}
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
          onCancel={() => {
            setProposal(undefined);
            setFromInbox(false);
          }}
          onValidate={validate}
        />
      )}
      {figmaOpen && <FigmaDialog code={plugin} config={config} onClose={() => setFigmaOpen(false)} />}
      {exportOpen && state && (
        <ExportDialog
          set={state.set}
          name={name}
          revision={state.revision}
          config={config}
          drafts={draftCount}
          onClose={() => setExportOpen(false)}
        />
      )}
      {siteFull && siteReady && draftSet && (
        <SiteFullscreen
          slug={slug}
          relay={relay!}
          config={config!}
          set={draftSet}
          page={sitePage ?? config!.site!.pages[0]}
          device={siteFull}
          onPage={setSitePage}
          onDevice={setSiteFull}
          onClose={() => setSiteFull(undefined)}
        />
      )}
      {comparison && (
        <ChangesDialog
          title={comparison.title}
          hint={comparison.hint}
          patches={comparison.patches}
          busy={busy}
          cancelLabel={comparison.accept ? 'Annuler' : 'Fermer'}
          onCancel={() => setComparison(undefined)}
          confirmLabel={`Accepter v${state.revision}`}
          onConfirm={comparison.accept ? acceptVersion : undefined}
        />
      )}
    </div>
  );
}
