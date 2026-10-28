import { useEffect, useMemo, useRef, useState } from 'react';
import type { TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import { exportCss } from '../shared/export.js';

// « Site en direct » : le vrai site du projet, servi par le relais local
// (site-relay.ts), reçoit le CSS des tokens en cours, brouillon compris, avec
// les noms de variables du code (`github.rename`), comme la PR GitHub.

export const siteOrigin = (slug: string, relay: number) => `http://${slug}.localhost:${relay}`;

export function SiteFrame({
  slug,
  relay,
  config,
  set,
  page,
  width,
  height,
  scale = 1,
  title,
}: {
  slug: string;
  relay: number;
  config: Config;
  set: TokenSet;
  page: string;
  width: number;
  height: number;
  scale?: number;
  title: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = siteOrigin(slug, relay);
  const css = useMemo(
    () =>
      exportCss(
        set,
        { rename: config.github?.rename ?? {}, mobileQuery: config.github?.mobileQuery ?? '(max-width: 767.98px)' },
        'DS-Studio · aperçu en direct',
      ),
    [set, config],
  );
  const push = () => frame.current?.contentWindow?.postMessage({ type: 'ds-css', css }, origin);
  useEffect(() => {
    push();
  }, [css]);
  useEffect(() => {
    // Chaque page chargée dans le cadre (navigation comprise) redemande le CSS.
    const onReady = (e: MessageEvent) => {
      if (e.origin === origin && e.source === frame.current?.contentWindow && e.data?.type === 'ds-site-ready') push();
    };
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, [css, origin]);
  return (
    <div className="site-frame" style={{ width: width * scale, height: height * scale }}>
      <iframe
        ref={frame}
        title={title}
        src={origin + page}
        style={{ width, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}

const devices = {
  desktop: { label: 'Desktop · 1440', width: 1440, height: 900 },
  mobile: { label: 'Mobile · 375', width: 375, height: 812 },
};
export type Device = keyof typeof devices;

// Popin plein écran : un seul cadre à sa vraie largeur, mis à l'échelle de la
// fenêtre et aussi haut qu'elle, pour consulter le site sans double défilement.
export function SiteFullscreen({
  slug,
  relay,
  config,
  set,
  page,
  device,
  onPage,
  onDevice,
  onClose,
}: {
  slug: string;
  relay: number;
  config: Config;
  set: TokenSet;
  page: string;
  device: Device;
  onPage: (page: string) => void;
  onDevice: (device: Device) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    dialog.current?.showModal();
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const head = 56;
  const { width } = devices[device];
  const scale = Math.min(1, (view.w - 32) / width);
  const height = (view.h - head - 16) / scale;
  return (
    <dialog ref={dialog} className="site-full" aria-label="Site en direct, plein écran" onClose={onClose}>
      <div className="site-full__head">
        <div className="devices" role="group" aria-label="Appareil">
          {(Object.keys(devices) as Device[]).map((d) => (
            <button key={d} aria-pressed={device === d} onClick={() => onDevice(d)}>
              {devices[d].label}
            </button>
          ))}
        </div>
        <select value={page} onChange={(e) => onPage(e.target.value)} aria-label="Page du site">
          {config.site!.pages.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="hint">Échelle {Math.round(scale * 100)} %</span>
        <button className="site-full__close" onClick={() => dialog.current?.close()}>
          Fermer (Échap)
        </button>
      </div>
      <SiteFrame
        key={device}
        slug={slug}
        relay={relay}
        config={config}
        set={set}
        page={page}
        width={width}
        height={height}
        scale={scale}
        title={`Site en direct plein écran, ${devices[device].label}`}
      />
    </dialog>
  );
}

// Vue pleine largeur : desktop (1440) et mobile (375) côte à côte, même hauteur.
export function SiteView({
  slug,
  relay,
  config,
  set,
  draft,
  onBack,
}: {
  slug: string;
  relay: number;
  config: Config;
  set: TokenSet;
  draft: boolean;
  onBack: () => void;
}) {
  const site = config.site!;
  const [page, setPage] = useState(site.pages[0]);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(1100);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  const [full, setFull] = useState<Device>();
  const gap = 24;
  const desktop = { width: 1440, height: 900 };
  const mobile = { width: 375, height: 812 };
  // Hauteur commune : les deux cadres remplissent la largeur disponible.
  const h = Math.max(240, (room - gap) / (desktop.width / desktop.height + mobile.width / mobile.height));
  return (
    <section className="site-view" aria-label="Site en direct">
      <div className="site-view__head">
        <button onClick={onBack}>← Atelier</button>
        <h2>
          Site en direct · <a href={site.url} target="_blank" rel="noreferrer">{new URL(site.url).host}</a>
        </h2>
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
        <span className={`site-view__state ${draft ? 'is-draft' : ''}`}>{draft ? 'Tokens du brouillon' : 'Tokens enregistrés'}</span>
      </div>
      <p className="hint">
        Le vrai site, avec les tokens de l’atelier à la place des siens. Rien n’est écrit sur le site : pour le publier, accepte une version (pull request).
      </p>
      <div className="site-view__frames" ref={box}>
        <figure>
          <SiteFrame slug={slug} relay={relay} config={config} set={set} page={page} {...desktop} scale={h / desktop.height} title="Site en direct, desktop 1440 px" />
          <figcaption>
            Desktop · 1440 <button onClick={() => setFull('desktop')}>Plein écran</button>
          </figcaption>
        </figure>
        <figure>
          <SiteFrame slug={slug} relay={relay} config={config} set={set} page={page} {...mobile} scale={h / mobile.height} title="Site en direct, mobile 375 px" />
          <figcaption>
            Mobile · 375 <button onClick={() => setFull('mobile')}>Plein écran</button>
          </figcaption>
        </figure>
      </div>
      {full && (
        <SiteFullscreen
          slug={slug}
          relay={relay}
          config={config}
          set={set}
          page={page}
          device={full}
          onPage={setPage}
          onDevice={setFull}
          onClose={() => setFull(undefined)}
        />
      )}
    </section>
  );
}
