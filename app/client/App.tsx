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
import { RETAKE_PATH } from '../shared/repo-rewrite.js';
import type { ComponentDoc } from '../shared/components.js';
import {
  accept,
  bootstrap,
  commit,
  getConfig,
  getGithub,
  getState,
  setProject,
  getVersions,
  getVersion,
  getInbox,
  publishGithub,
  type GithubResult,
  type RepoPrSummary,
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
import { foldable, Home, SectionBar, TopNav, useRoute, type View } from './Shell.js';
import { AccountPage, SettingsPage } from './Settings.js';
import { FigmaMark, GithubMark, MoreMenu, openSettings, useGithub } from './Chrome.js';
import AssistantPanel from './Assistant.js';
import { brandColor, MascotDock } from './Mascot.js';
import Wall from './Wall.js';
import ExtractPanel from './Extract.js';
import { proposeSemanticLayer } from '../shared/semantic.js';
import RepoPanel from './Repo.js';
import { SiteFrame, SiteFullscreen, type Device } from './Site.js';
import { fontFamilies, loadFonts } from './fonts.js';
import { PreviewGap, previewSrc, previewUnfit, ScreenPicker, type Screen } from './DesignSystem.js';
import CompareView from './Compare.js';
import History from './History.js';
import { ChangesDialog, Corrections, DiffDialog, ExportDialog, FigmaDialog } from './Panels.js';

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
  // Dernière publication GitHub par projet, gardée au-dessus de Workspace :
  // le message d'erreur renvoie vers Réglages (qui démonte Workspace), le
  // « Réessayer » doit encore être là au retour (recette du 2026-11-17).
  const [published, setPublished] = useState<Record<string, Published>>({});
  const [route, go, page] = useRoute();
  useEffect(() => {
    bootstrap().then(setBoot).catch((e) => setBootError(e.message));
  }, []);
  if (!boot) return <p className="loading" role="alert">{bootError || 'Chargement…'}</p>;
  const back = () => (history.length > 1 ? history.back() : go());
  if (page === 'settings') return <SettingsPage onBack={back} />;
  if (page === 'account') return <AccountPage onBack={back} welcome={boot.multi} />;
  // Instance fixe (--project=) : pas d'accueil, son unique projet s'ouvre.
  const slug = route ?? (boot.multi ? undefined : boot.fallback);
  if (!slug) return <Home onOpen={go} plugin={boot.plugin} />;
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
      published={published[slug]}
      onPublished={(p) => setPublished((all) => ({ ...all, [slug]: p }))}
    />
  );
}

type Published = { revision: number; result: GithubResult };
// `untaken` (variables du dépôt jamais reprises, recette du 2026-11-17).
const untakenText = (summary?: RepoPrSummary) => {
  const n = summary?.untaken ?? 0;
  return n
    ? ` ${n} variable(s) du dépôt jamais reprise(s) dans l’atelier, laissée(s) telle(s) quelle(s) dans le code. Pour les reprendre : ${RETAKE_PATH}.`
    : '';
};

function Workspace({
  slug,
  multi,
  plugin,
  github,
  relay,
  desktop,
  onOpen,
  published,
  onPublished,
}: {
  slug: string;
  multi: boolean;
  plugin: string | null;
  github: boolean;
  relay: number | null;
  desktop: boolean;
  onOpen: (slug?: string) => void;
  published: Published | undefined;
  onPublished: (p: Published) => void;
}) {
  const { state, setState, error: stateError } = useCommittedState(slug);
  // GitHub relu en direct (connexion faite dans Réglages puis retour) ; l'état du démarrage en attendant.
  const gh = useGithub();
  const githubLive = gh ? gh.pro && gh.status === 'connected' : github;
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
  // Dernière publication GitHub (lien de la PR, ou erreur à réessayer) : état de App.
  const setPublished = onPublished;
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
  // Lot 5 : lecture des styles d'un site demandée à la création ou depuis la
  // preview du site ; le panneau s'affiche au-dessus de la planche.
  const [extractUrl, setExtractUrl] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(k('ds-extract'));
    } catch {
      return null;
    }
  });
  // Plan GitHub, G3 : panneau Dépôt, lancé à la création depuis un dépôt
  // (`ds-repo:<slug>` = create) ou par le bouton « Dépôt ».
  const [repoPanel, setRepoPanel] = useState<'create' | 'open' | null>(() => {
    try {
      return sessionStorage.getItem(k('ds-repo')) === 'create' ? 'create' : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.removeItem(k('ds-start'));
      sessionStorage.removeItem(k('ds-extract'));
      sessionStorage.removeItem(k('ds-repo'));
      sessionStorage.removeItem(k('ds-notice'));
    } catch {
      /* Facultatif. */
    }
  }, []);
  // Vue Versions : onglet ouvert, et révision visée depuis la frise.
  const [versionsTab, setVersionsTab] = useState<'compare' | 'history'>('compare');
  // Révision « Avant » de Comparer imposée par Historique ou la frise.
  const [compareAt, setCompareAt] = useState<number>();
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
  const openVersions = (tab: 'compare' | 'history', at?: number) => {
    setVersionsTab(tab);
    setCompareAt(at);
    setView('versions');
    // Arrivée depuis une planche défilée : Versions s'ouvre en haut.
    window.scrollTo(0, 0);
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
  const [previewChoice, setPreviewScreen] = useState<Screen | 'site'>();
  const [siteFull, setSiteFull] = useState<Device>();
  const [sitePage, setSitePage] = useState<string>();
  const siteReady = !!(relay && config?.site);
  const [error, setError] = useState('');
  // Message de la création (adresse http écartée du Site en direct), lu une fois.
  const [notice, setNotice] = useState(() => {
    try {
      return sessionStorage.getItem(k('ds-notice')) ?? '';
    } catch {
      return '';
    }
  });
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
    // Token enregistré remplacé sous le même nom (couche sémantique) : retrait puis ajout.
    ...[...structure].flatMap(([key, token]): Change[] =>
      !token
        ? [{ op: 'remove', key }]
        : state?.set.tokens[key]
          ? [{ op: 'remove', key }, { op: 'add', key, token }]
          : [{ op: 'add', key, token }],
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
  // Écrans d'exemple qui ne lisent pas les tokens du projet (lu dans un dépôt) :
  // le site en direct d'abord, tant que rien n'a été choisi. Décidé sur le jeu
  // enregistré, pas sur le brouillon, pour ne pas basculer pendant l'édition.
  const previewScreen = previewChoice ?? (siteReady && state && previewUnfit(state.set) ? 'site' : 'ds');
  const previewSite = siteReady && previewScreen === 'site';
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
  // `checked` : retrait d'un lot déjà vérifié en entier (draftChanges), où un
  // alias peut partir avec sa cible ; `draftSet` est encore celui d'avant le lot.
  const remove = (key: string, checked = false) => {
    const users = draftSet && !checked ? referrers(draftSet, key) : [];
    if (users.length) {
      setNotice('');
      setError(`${key} est utilisé par ${users.join(', ')} : changer ces alias avant de le retirer.`);
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
  // Le lot est d'abord essayé en entier sur le brouillon (alias, retraits) :
  // refusé, rien n'entre dans le brouillon. Rend false si refusé.
  const draftChanges = (list: Change[], from = 'de Lenny') => {
    if (draftSet) {
      try {
        applyChanges(draftSet, list);
      } catch (e) {
        setNotice('');
        setError(`Changements ${from} refusés sur le brouillon : ${(e as Error).message}`);
        return false;
      }
    }
    for (const c of list) {
      if (!('op' in c)) edit(c.key, c.mode, c.value);
      else if (c.op === 'add') add(c.key, c.token);
      else if (c.op === 'remove') remove(c.key, true);
      else saveComponent(c.name, c.component);
    }
    setNotice(`${list.length} changement(s) ${from} mis en brouillon : relire le diff avant de valider.`);
    return true;
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
      // État relu à l'ouverture : la connexion GitHub a pu changer depuis le lancement.
      const gh = config?.github ? await getGithub().catch(() => null) : null;
      const connected = gh ? gh.pro && gh.status === 'connected' : github;
      const code = config?.github
        ? connected
          ? config.github.source === 'repo'
            ? ` La pull request DS-Studio de ${config.github.repo} (branche ds-studio/design-system) sera ouverte ou mise à jour : le code est réécrit d’après la dernière lecture du dépôt ; rien n’arrive sur ${config.github.base} sans votre merge.`
            : ` Une pull request sera ouverte sur ${config.github.repo} (branche ds-studio/v${state!.revision}) ; rien n’arrive sur ${config.github.base} sans votre merge.`
          : ' GitHub n’est pas connecté (Réglages → GitHub) : la pull request ne sera pas ouverte.'
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
        versions={versions.map((v) => v.revision)}
        onVersion={(revision) => openVersions('compare', revision)}
        correctionsBadge={
          findings.length ? (
            <button
              className="tab-badge warn"
              title="Voir les corrections proposées"
              aria-label={`${findings.length} écart(s) · Corrections`}
              onClick={() => setView('corrections')}
            >
              {findings.length}
            </button>
          ) : null /* aucun écart : rien à côté de l'onglet (puce retirée, demande de Romain du 2026-11-14) */
        }
      >
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
          <button
            className={githubLive ? 'brand-btn' : 'brand-btn is-off'}
            onClick={() => {
              if (!githubLive) return openSettings();
              setView('board');
              setRepoPanel('open');
            }}
            title={githubLive ? 'Lire le dépôt GitHub du projet' : 'Connecter GitHub (Réglages, section GitHub)'}
          >
            <GithubMark />
            {githubLive ? 'GitHub' : 'Connecter GitHub'}
          </button>
          <button className="brand-btn" onClick={() => setFigmaOpen(true)} title="Envoyer le design system dans Figma">
            <FigmaMark />
            Figma
          </button>
          <MoreMenu
            items={[
              { label: 'Importer', onSelect: () => file.current?.click() },
              { label: 'Exporter le code', onSelect: () => setExportOpen(true) },
            ]}
          />
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
          <button
            className="primary"
            disabled={busy || draftCount > 0 || !!accepted}
            title={
              draftCount
                ? 'Valider ou abandonner le brouillon avant d’accepter.'
                : accepted
                  ? `Déjà acceptée : v${accepted.revision}`
                  : 'Figer cette révision pour le transfert Figma'
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
      {/* Pile des messages : le lien de la PR reste visible sous l'avis d'acceptation. */}
      <div className="message-stack">
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
            `GitHub : ${config?.github?.repo} est déjà à jour, aucune pull request ouverte.${untakenText(published.result.summary)}`
          ) : (
            <>
              Pull request {published.result.status === 'opened' ? 'ouverte' : 'mise à jour'} :{' '}
              <a href={published.result.url} target="_blank" rel="noreferrer">
                {published.result.url}
              </a>
              {published.result.summary &&
                ` · ${published.result.summary.files} fichier(s), ${published.result.summary.written} valeur(s) en dur remplacée(s), ${published.result.summary.changed} variable(s) changée(s), ${published.result.summary.added} ajoutée(s) ; ${published.result.summary.skipped} non écrite(s) (détail dans la PR).`}
              {untakenText(published.result.summary)}
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
      </div>
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
      {view === 'corrections' && (
        <div className="corrections-view">
          <Corrections
            findings={findings}
            onFix={(f) => f.fix && edit(f.fix.key, f.fix.mode, f.fix.value)}
            onFixAll={(list) => {
              for (const f of list) if (f.fix) edit(f.fix.key, f.fix.mode, f.fix.value);
              setNotice(`${list.length} correction(s) mises en brouillon : relire le diff avant de valider.`);
            }}
          />
        </div>
      )}
      {view === 'versions' && config && (
        <div className="versions-view">
          <div className="tabs" role="tablist" aria-label="Versions">
            {(
              [
                ['compare', 'Comparer'],
                ['history', 'Historique'],
              ] as const
            ).map(([tab, label]) => (
              <button key={tab} role="tab" aria-selected={versionsTab === tab} onClick={() => openVersions(tab)}>
                {label}
              </button>
            ))}
          </div>
          {versionsTab === 'history' && (
            <History
              state={state}
              versions={versions}
              draft={draftCount > 0}
              onView={(revision) => openVersions('compare', revision)}
              onDetail={compareVersions}
              onRestore={(revision) =>
                run(async () => setProposal(await proposeImport(state.revision, await versionSet(revision))))
              }
              onUndo={(id) => run(async () => setProposal(await proposeUndo(state.revision, id)))}
            />
          )}
          {versionsTab === 'compare' && (
            <CompareView
              key={compareAt ?? 'auto'}
              slug={slug}
              relay={relay}
              config={config}
              state={state}
              versions={versions}
              draftSet={draftSet}
              draft={draftCount > 0}
              initial={compareAt}
              onConfig={setConfig}
            />
          )}
        </div>
      )}
      {view === 'board' && extractUrl && (
        <ExtractPanel
          key={extractUrl}
          url={extractUrl}
          set={state?.set}
          onClose={() => setExtractUrl(null)}
          onDraft={(list) => {
            draftChanges(list, 'lus sur le site');
            setExtractUrl(null);
          }}
        />
      )}
      {view === 'board' && repoPanel && config && (
        <RepoPanel
          config={config}
          draft={draftSet}
          start={repoPanel}
          onConfig={setConfig}
          onClose={() => setRepoPanel(null)}
          onDraft={(list, from) => {
            // Refusé : le panneau reste ouvert, l'erreur dit pourquoi.
            if (draftChanges(list, from ?? 'lus dans le dépôt')) setRepoPanel(null);
          }}
          onSemantic={() => {
            if (!draftSet) return;
            const layer = proposeSemanticLayer(draftSet);
            if (!layer.changes.length) {
              setError('');
              setNotice(layer.notes.join(' '));
              return;
            }
            draftChanges(layer.changes, 'de la couche sémantique');
            setNotice(`${layer.notes.join(' ')} Relire le diff avant de valider.`);
            setRepoPanel(null);
          }}
        />
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
                <>
                  <button onClick={() => setSiteFull(devices[device].width >= 1024 ? 'desktop' : 'mobile')}>Plein écran</button>
                  <button onClick={() => setExtractUrl(config!.site!.url)}>Relire les styles du site</button>
                </>
              )}
              <div className="devices" role="group" aria-label="Largeur d’écran">
                {devices.map((d, i) => (
                  <button key={d.width} aria-pressed={device === i} onClick={() => setDevice(i)}>
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            {!previewSite && draftSet && <PreviewGap set={draftSet} site={siteReady} />}
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
        </aside>
      </main>
      </div>
      {assistantOpen ? (
        <AssistantPanel color={mascotColor} onDraft={draftChanges} onClose={() => toggleAssistant(false)} />
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
