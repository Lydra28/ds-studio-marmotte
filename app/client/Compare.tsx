import { useEffect, useMemo, useRef, useState } from 'react';
import { setsByRevision, type State, type TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import type { VersionSummary } from './api.js';
import { devices, SiteFrame, type Device } from './Site.js';
import { PreviewGap, previewSrc, ScreenPicker, type Screen } from './DesignSystem.js';

// Comparer (vue Versions, refondue le 2026-11-14 avec Romain) : deux rendus
// côte à côte, en grand. « Après » = ce que tu modifies (brouillon, sinon
// l'état enregistré) ; « Avant » se choisit au curseur, qui remonte le temps
// révision par révision (versions acceptées marquées), avec lecture
// automatique. Rendu seulement : la liste des valeurs changées est dans
// Historique. Lecture seule : rien n'est écrit depuis cette vue.

// Écran générique du DS (même page que la preview latérale), pour un jeu donné.
export function DsFrame({
  set,
  screen = 'ds',
  width,
  height,
  scale,
  title,
  onScroll,
  follow,
}: {
  set: TokenSet;
  screen?: Screen;
  width: number;
  height: number;
  scale: number;
  title: string;
  onScroll?: (y: number) => void;
  follow?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const push = () => frame.current?.contentWindow?.postMessage({ type: 'ds-set', set }, location.origin);
  useEffect(() => {
    push();
  }, [set]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'ds-ready') push();
      if (e.data?.type === 'ds-scroll' && typeof e.data.y === 'number') onScroll?.(e.data.y);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [set, onScroll]);
  useEffect(() => {
    if (follow !== undefined) frame.current?.contentWindow?.postMessage({ type: 'ds-scroll-to', y: follow }, location.origin);
  }, [follow]);
  return (
    <div className="site-frame" style={{ width: width * scale, height: height * scale }}>
      <iframe ref={frame} title={title} src={previewSrc(screen)} style={{ width, height, transform: `scale(${scale})` }} />
    </div>
  );
}

// Cran -1 : le site tel qu'en ligne, sans DS-Studio (projet lu dans un dépôt,
// G4). Cran 0 : départ du projet. Crans 1 à N : révisions enregistrées.
const SITE = -1;
const STEP_MS = 1400;

// « Avant » par défaut : l'état enregistré quand un brouillon est en cours,
// sinon la dernière version acceptée d'avant, sinon la révision précédente.
export function defaultBefore(state: State, versions: VersionSummary[], draft: boolean) {
  if (draft) return state.revision;
  return versions.find((v) => v.revision < state.revision)?.revision ?? Math.max(0, state.revision - 1);
}

export default function CompareView({
  slug,
  relay,
  config,
  state,
  versions,
  draftSet,
  draft,
  initial,
}: {
  slug: string;
  relay: number | null;
  config: Config;
  state: State;
  versions: VersionSummary[];
  draftSet: TokenSet;
  draft: boolean;
  // Révision « Avant » imposée (Historique, frise de la barre) ; sinon le défaut.
  initial?: number;
}) {
  const sets = useMemo(() => setsByRevision(state), [state]);
  const site = relay && config.site ? config.site : null;
  const repo = config.github?.source === 'repo';
  const min = site && repo ? SITE : 0;
  const max = state.revision;
  const clampAt = (n: number) => Math.max(min, Math.min(max, n));
  const [at, setAt] = useState(() => clampAt(initial ?? defaultBefore(state, versions, draft)));
  useEffect(() => {
    setAt((a) => clampAt(a));
  }, [min, max]);

  // Lecture automatique : repart du départ si le curseur est au bout.
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (at >= max) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setAt((a) => a + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, at, max]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (at >= max) setAt(min);
    setPlaying(true);
  };

  const accepted = new Map(versions.map((v) => [v.revision, v]));
  const name = (i: number) => (i === SITE ? 'Site actuel' : i === 0 ? 'Départ' : accepted.has(i) ? `v${i}` : `r${i}`);
  const when = (i: number) => {
    const r = i >= 1 ? state.history[i - 1] : undefined;
    return r ? new Date(r.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '';
  };
  const beforeLabel =
    at === SITE ? 'Site actuel, sans DS-Studio' : at === 0 ? 'Départ du projet' : `${name(at)} · ${when(at)}`;
  const afterLabel = draft ? 'Modifications en cours' : `Enregistré · ${name(state.revision)}`;
  const before = at === SITE ? state.set : sets[at];
  const after = draft ? draftSet : state.set;
  const same = at === state.revision && !draft;
  // Historique long : étiquettes aux bouts, aux versions et au cran courant.
  const crowded = max - min > 12;

  const [content, setContent] = useState<Screen | 'site'>(site ? 'site' : 'ds');
  const [device, setDevice] = useState<Device>('desktop');
  const [page, setPage] = useState(site?.pages[0] ?? '/');
  const [linked, setLinked] = useState(true);
  const [follow, setFollow] = useState<{ left?: number; right?: number }>({});
  // Chaque cadre suit l'autre ; l'écho est coupé dans le cadre lui-même.
  const fromLeft = useMemo(() => (y: number) => linked && setFollow((f) => ({ ...f, right: y })), [linked]);
  const fromRight = useMemo(() => (y: number) => linked && setFollow((f) => ({ ...f, left: y })), [linked]);

  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 1100, h: window.innerHeight });
  useEffect(() => {
    if (!box.current) return;
    // Haut du cadre mesuré dans le document, pas dans la fenêtre : page
    // défilée, la mesure suivrait le défilement et les cadres grandiraient
    // sans fin (ancrage du défilement).
    const measure = () =>
      box.current &&
      setRoom({
        w: box.current.clientWidth,
        h: window.innerHeight - (box.current.getBoundingClientRect().top + window.scrollY) - 72,
      });
    measure(); // sans attendre le premier rappel de l'observateur
    const observer = new ResizeObserver(measure);
    observer.observe(box.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
    // Le bandeau « identiques » et les outils du contenu déplacent le haut
    // des cadres sans changer leur taille : on remesure quand ils changent.
  }, [same, content]);
  const gap = 24;
  const { width } = devices[device];
  const scale = Math.min(1, (room.w - gap) / 2 / width);
  const height = Math.max(360, room.h) / scale;

  const frame = (side: 'left' | 'right') => {
    const set = side === 'left' ? before : after;
    const label = side === 'left' ? beforeLabel : afterLabel;
    const raw = side === 'left' && at === SITE;
    const title = `${side === 'left' ? 'Gauche' : 'Droite'} : ${label}`;
    const props = { width, height, scale, title, onScroll: side === 'left' ? fromLeft : fromRight, follow: follow[side] };
    return (
      <figure className={`compare__side compare__side--${side === 'left' ? 'before' : 'after'}`}>
        <figcaption>
          <span className="compare__tag">{side === 'left' ? 'Avant' : 'Après'}</span>
          <span className="compare__what">{label}</span>
        </figcaption>
        {raw && content !== 'site' ? (
          <p className="hint" style={{ width: width * scale }}>
            Le site actuel se compare sur le contenu « Site » seulement.
          </p>
        ) : content === 'site' && site ? (
          <SiteFrame key={`${device}-${page}-${raw}`} slug={slug} relay={relay!} config={config} set={set} page={page} raw={raw} {...props} />
        ) : (
          <DsFrame key={device} set={set} screen={content === 'site' ? 'ds' : content} {...props} />
        )}
      </figure>
    );
  };

  return (
    <section className="site-view compare" aria-label="Comparaison côte à côte">
      <div className="compare__time">
        <span className="compare__time-label" aria-hidden="true">
          Avant
        </span>
        <button className="timeline__play" onClick={play} aria-label={playing ? 'Mettre en pause' : 'Rejouer l’historique'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="timeline__track">
          <input
            type="range"
            min={min}
            max={max}
            step={1}
            value={at}
            aria-label="Version avant"
            aria-valuetext={beforeLabel}
            disabled={max === min}
            onChange={(e) => {
              setPlaying(false);
              setAt(Number(e.target.value));
            }}
          />
          <ol className="timeline__marks" aria-hidden="true">
            {Array.from({ length: max - min + 1 }, (_, k) => k + min).map((i) => (
              <li
                key={i}
                style={{ left: `${max > min ? ((i - min) / (max - min)) * 100 : 0}%` }}
                className={`${i === at ? 'is-current' : ''} ${accepted.has(i) ? 'is-version' : ''}`}
              >
                {(!crowded || i === min || i === max || i === at || accepted.has(i)) && <span>{name(i)}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
      {same && (
        <p className="hint compare__same" role="status">
          Avant et après sont identiques : faire glisser le curseur vers une version plus ancienne.
        </p>
      )}
      <div className="compare__tools">
        <ScreenPicker value={content} onChange={setContent} site={!!site} label="Contenu comparé" />
        <div className="devices" role="group" aria-label="Appareil">
          {(Object.keys(devices) as Device[]).map((d) => (
            <button key={d} aria-pressed={device === d} onClick={() => setDevice(d)}>
              {devices[d].label}
            </button>
          ))}
        </div>
        {content === 'site' && site && (
          <label>
            Page
            <select value={page} onChange={(e) => setPage(e.target.value)}>
              {site.pages.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} /> Défilement lié
        </label>
        {content !== 'site' && <PreviewGap set={after} site={!!site} />}
      </div>
      <div className="site-view__frames compare__frames" ref={box}>
        {frame('left')}
        {frame('right')}
      </div>
    </section>
  );
}
