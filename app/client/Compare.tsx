import { useEffect, useMemo, useRef, useState } from 'react';
import { diff, type State, type TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import { getVersion, type VersionSummary } from './api.js';
import { ChangesDialog, diffSummary } from './Panels.js';
import { devices, SiteFrame, type Device } from './Site.js';

// Comparaison côte à côte : deux états du jeu (version acceptée, état
// enregistré ou brouillon) rendus dans deux cadres identiques, défilement lié.
// Lecture seule : rien n'est écrit depuis cette vue.

export type Source = 'draft' | 'state' | number;

// Écran générique du DS (même page que la preview latérale), pour un jeu donné.
export function DsFrame({
  set,
  width,
  height,
  scale,
  title,
  onScroll,
  follow,
}: {
  set: TokenSet;
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
      <iframe ref={frame} title={title} src="/?preview=1" style={{ width, height, transform: `scale(${scale})` }} />
    </div>
  );
}

// Par défaut : le brouillon face à l'état enregistré (l'essai en cours), sinon
// l'état enregistré face à la version acceptée qui le précède.
export function defaultSources(state: State, versions: VersionSummary[], draft: boolean): [Source, Source] {
  if (draft) return ['state', 'draft'];
  return [versions.find((v) => v.revision < state.revision)?.revision ?? 'state', 'state'];
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
  initial?: [Source, Source];
}) {
  const [[left, right], setSources] = useState<[Source, Source]>(() => initial ?? defaultSources(state, versions, draft));
  useEffect(() => {
    if (initial) setSources(initial);
  }, [initial]);
  const [loaded, setLoaded] = useState<Record<number, TokenSet>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    for (const s of [left, right])
      if (typeof s === 'number' && !loaded[s])
        getVersion(s)
          .then((v) => setLoaded((l) => ({ ...l, [s]: v.set })))
          .catch((e) => setError((e as Error).message));
  }, [left, right]);

  const accepted = versions.some((v) => v.revision === state.revision);
  const label = (s: Source) =>
    s === 'draft'
      ? 'Brouillon en cours'
      : s === 'state'
        ? `Enregistré · r${state.revision}${accepted ? ` (= v${state.revision})` : ''}`
        : `v${s} · ${new Date(versions.find((v) => v.revision === s)?.acceptedAt ?? '').toLocaleDateString('fr-FR')}`;
  const options: Source[] = [...(draft ? (['draft'] as Source[]) : []), 'state', ...versions.map((v) => v.revision)];
  const resolve = (s: Source) => (s === 'draft' ? draftSet : s === 'state' ? state.set : loaded[s]);
  const before = resolve(left);
  const after = resolve(right);
  const patches = useMemo(() => (before && after ? diff(before, after) : []), [before, after]);
  const [detail, setDetail] = useState(false);

  const site = relay && config.site ? config.site : null;
  const [content, setContent] = useState<'site' | 'ds'>(site ? 'site' : 'ds');
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
    const measure = () =>
      box.current &&
      setRoom({ w: box.current.clientWidth, h: window.innerHeight - box.current.getBoundingClientRect().top - 48 });
    const observer = new ResizeObserver(measure);
    observer.observe(box.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const gap = 24;
  const { width } = devices[device];
  const scale = Math.min(1, (room.w - gap) / 2 / width);
  const height = Math.max(360, room.h) / scale;

  const frame = (s: Source, side: 'left' | 'right') => {
    const set = resolve(s);
    const title = `${side === 'left' ? 'Gauche' : 'Droite'} : ${label(s)}`;
    const props = { width, height, scale, title, onScroll: side === 'left' ? fromLeft : fromRight, follow: follow[side] };
    return (
      <figure>
        <figcaption>
          <strong>{side === 'left' ? 'Avant' : 'Après'}</strong> · {label(s)}
        </figcaption>
        {!set ? (
          <p className="hint" style={{ width: width * scale }}>
            Chargement de la version…
          </p>
        ) : content === 'site' && site ? (
          <SiteFrame key={`${device}-${page}`} slug={slug} relay={relay!} config={config} set={set} page={page} {...props} />
        ) : (
          <DsFrame key={device} set={set} {...props} />
        )}
      </figure>
    );
  };

  return (
    <section className="site-view compare" aria-label="Comparaison côte à côte">
      <div className="site-view__head">
        <h2>Comparer côte à côte</h2>
        <label>
          Avant
          <select aria-label="Version avant" value={String(left)} onChange={(e) => setSources([parse(e.target.value), right])}>
            {options.map((o) => (
              <option key={o} value={String(o)}>
                {label(o)}
              </option>
            ))}
          </select>
        </label>
        <button aria-label="Inverser avant et après" title="Inverser" onClick={() => setSources([right, left])}>
          ⇄
        </button>
        <label>
          Après
          <select aria-label="Version après" value={String(right)} onChange={(e) => setSources([left, parse(e.target.value)])}>
            {options.map((o) => (
              <option key={o} value={String(o)}>
                {label(o)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="site-view__head">
        {site && (
          <div className="devices" role="group" aria-label="Contenu comparé">
            <button aria-pressed={content === 'site'} onClick={() => setContent('site')}>
              Site
            </button>
            <button aria-pressed={content === 'ds'} onClick={() => setContent('ds')}>
              DS
            </button>
          </div>
        )}
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
        <span className="compare__summary">
          {before && after ? diffSummary(patches) : '…'}
          {patches.length > 0 && <button onClick={() => setDetail(true)}>Détail</button>}
        </span>
      </div>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="site-view__frames compare__frames" ref={box}>
        {frame(left, 'left')}
        {frame(right, 'right')}
      </div>
      {detail && (
        <ChangesDialog
          title={`${label(left)} → ${label(right)}`}
          hint="Lecture seule : cette vue ne modifie rien."
          patches={patches}
          cancelLabel="Fermer"
          onCancel={() => setDetail(false)}
        />
      )}
    </section>
  );
}

const parse = (v: string): Source => (v === 'draft' || v === 'state' ? v : Number(v));
