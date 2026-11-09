import { useEffect, useMemo, useRef, useState } from 'react';
import type { TokenSet } from '../shared/model.js';
import type { Config } from '../shared/project.js';
import { exportCss } from '../shared/export.js';

// « Site en direct » : le vrai site du projet, servi par le relais local
// (site-relay.ts), reçoit le CSS des tokens en cours, brouillon compris, avec
// les noms de variables du code (`github.rename`), comme la PR GitHub.
// Projet rattaché à un dépôt (G4) : le relais remplace aussi les valeurs en
// dur par les tokens du plan. `raw` : le site tel qu'en ligne, sans DS-Studio.

export const siteOrigin = (slug: string, relay: number, raw = false) => `http://${raw ? 'brut.' : ''}${slug}.localhost:${relay}`;

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
  onScroll,
  follow,
  raw = false,
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
  // Défilement lié : position remontée par le site, position à suivre (fraction).
  onScroll?: (y: number) => void;
  follow?: number;
  raw?: boolean;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const origin = siteOrigin(slug, relay, raw);
  const css = useMemo(
    () =>
      exportCss(
        set,
        { rename: config.github?.rename ?? {}, mobileQuery: config.github?.mobileQuery ?? '(max-width: 767.98px)' },
        'DS-Studio · aperçu en direct',
      ),
    [set, config],
  );
  const push = () => !raw && frame.current?.contentWindow?.postMessage({ type: 'ds-css', css }, origin);
  useEffect(() => {
    push();
  }, [css]);
  useEffect(() => {
    // Chaque page chargée dans le cadre (navigation comprise) redemande le CSS.
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'ds-site-ready') push();
      if (e.data?.type === 'ds-scroll' && typeof e.data.y === 'number') onScroll?.(e.data.y);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [css, origin, onScroll]);
  useEffect(() => {
    if (follow !== undefined) frame.current?.contentWindow?.postMessage({ type: 'ds-scroll-to', y: follow }, origin);
  }, [follow]);
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

export const devices = {
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

