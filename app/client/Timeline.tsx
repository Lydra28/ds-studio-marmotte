import { useEffect, useMemo, useRef, useState } from 'react';
import { setsByRevision, type State, type TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import type { VersionSummary } from './api.js';
import { DsFrame } from './Compare.js';
import { sourceLabel } from './Panels.js';
import { devices, SiteFrame, type Device } from './Site.js';

// Curseur dans l'historique : un seul cadre (site en direct ou écran DS) qui
// rejoue le design system révision après révision, brouillon en dernier cran.
// Lecture seule : revenir en arrière passe par « Annuler cette révision ».

const STEP_MS = 1400;

export default function TimelineView({
  slug,
  relay,
  config,
  state,
  versions,
  draftSet,
  draft,
  onBack,
}: {
  slug: string;
  relay: number | null;
  config: Config;
  state: State;
  versions: VersionSummary[];
  draftSet: TokenSet;
  draft: boolean;
  onBack: () => void;
}) {
  const sets = useMemo(() => setsByRevision(state), [state]);
  const last = state.revision + (draft ? 1 : 0);
  const [at, setAt] = useState(last);
  useEffect(() => {
    setAt((a) => Math.min(a, last));
  }, [last]);
  const set = at > state.revision ? draftSet : sets[at];

  // Lecture automatique : repart du début si le curseur est au bout.
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setAt((a) => a + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, at, last]);
  const play = () => {
    if (playing) return setPlaying(false);
    if (at >= last) setAt(0);
    setPlaying(true);
  };

  const accepted = new Map(versions.map((v) => [v.revision, v]));
  const revision = at >= 1 && at <= state.revision ? state.history[at - 1] : undefined;
  const keys = revision?.patches.map((p) => p.key) ?? [];
  const caption =
    at === 0
      ? 'Départ du projet (jeu de départ)'
      : at > state.revision
        ? 'Brouillon en cours, pas encore enregistré'
        : `${new Date(revision!.date).toLocaleString('fr-FR')} · ${sourceLabel[revision!.source]} · ${keys.length} changement(s)`;
  // Historique long : étiquettes seulement aux bouts, aux versions et au cran courant.
  const crowded = last > 12;
  const name = (i: number) => (i === 0 ? 'Départ' : i > state.revision ? 'Brouillon' : `r${i}`);

  const site = relay && config.site ? config.site : null;
  const [content, setContent] = useState<'site' | 'ds'>(site ? 'site' : 'ds');
  const [device, setDevice] = useState<Device>('desktop');
  const [page, setPage] = useState(site?.pages[0] ?? '/');
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ w: 1100, h: 600 });
  useEffect(() => {
    if (!box.current) return;
    const measure = () =>
      box.current &&
      setRoom({ w: box.current.clientWidth, h: window.innerHeight - box.current.getBoundingClientRect().top - 32 });
    const observer = new ResizeObserver(measure);
    observer.observe(box.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const { width } = devices[device];
  const scale = Math.min(1, room.w / width);
  const height = Math.max(360, room.h) / scale;

  return (
    <section className="site-view timeline" aria-label="Évolution du design system">
      <div className="site-view__head">
        <button onClick={onBack}>← Atelier</button>
        <h2>Évolution</h2>
        {site && (
          <div className="devices" role="group" aria-label="Contenu rejoué">
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
      </div>

      <div className="timeline__bar">
        <button className="timeline__play" onClick={play} aria-label={playing ? 'Mettre en pause' : 'Rejouer l’historique'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="timeline__track">
          <input
            type="range"
            min={0}
            max={last}
            step={1}
            value={at}
            aria-label="Révision affichée"
            aria-valuetext={name(at)}
            onChange={(e) => {
              setPlaying(false);
              setAt(Number(e.target.value));
            }}
          />
          <ol className="timeline__marks" aria-hidden="true">
            {Array.from({ length: last + 1 }, (_, i) => (
              <li
                key={i}
                style={{ left: `${last ? (i / last) * 100 : 0}%` }}
                className={`${i === at ? 'is-current' : ''} ${accepted.has(i) ? 'is-version' : ''} ${i > state.revision ? 'is-draft' : ''}`}
              >
                {(!crowded || i === 0 || i === last || i === at || accepted.has(i)) && (
                  <span>{accepted.has(i) ? `v${i}` : name(i)}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="timeline__caption" role="status">
        <strong>{name(at)}</strong>
        {accepted.has(at) && <span className="timeline__badge">version v{at} acceptée</span>} · {caption}
        {keys.length > 0 && (
          <span className="timeline__keys">
            {' '}
            · {keys.slice(0, 4).join(', ')}
            {keys.length > 4 && ` +${keys.length - 4}`}
          </span>
        )}
      </p>

      <div className="timeline__frame" ref={box}>
        {content === 'site' && site ? (
          <SiteFrame
            key={`${device}-${page}`}
            slug={slug}
            relay={relay!}
            config={config}
            set={set}
            page={page}
            width={width}
            height={height}
            scale={scale}
            title={`Site en direct à ${name(at)}`}
          />
        ) : (
          <DsFrame key={device} set={set} width={width} height={height} scale={scale} title={`Écran DS à ${name(at)}`} />
        )}
      </div>
    </section>
  );
}
