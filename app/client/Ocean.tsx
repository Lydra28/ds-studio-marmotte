import { useEffect, useRef } from 'react';
import { createOcean, FISH, resizeOcean, sharkPixels, step, type Ocean as Sea } from './ocean-sim.js';

// Fond animé de l'accueil (et de la pop-in, qui le floute) : requins et banc
// de poissons en pixels, discrets derrière le contenu. 20 images par seconde
// (effet pixel, peu de calcul), en pause quand la fenêtre est cachée, figé
// sur une image si l'utilisateur réduit les animations. Jamais sur l'écran
// de travail d'un projet.
const PX = 4;
const FPS = 20;
const COLORS = {
  near: { '#': '#232a33', b: '#313945', g: '#161b21', e: '#bdff2e' } as Record<string, string>,
  far: { '#': '#13171c', b: '#181d23', g: '#101318', e: '#3d5214' } as Record<string, string>,
  // Discrets : le banc passe parfois sous du texte gris (contraste du texte).
  fish: 'rgb(189 255 46 / 0.35)',
  bubble: '#2a313b',
};

function draw(ctx: CanvasRenderingContext2D, o: Sea) {
  ctx.clearRect(0, 0, o.w, o.h);
  for (const b of o.bubbles) {
    ctx.fillStyle = COLORS.bubble;
    ctx.fillRect(Math.round(b.x), Math.round(b.y), 1, 1);
  }
  // Le requin lointain d'abord : le banc et le requin proche passent devant.
  for (const s of [...o.sharks].sort((a, b) => Number(b.far) - Number(a.far))) {
    const palette = s.far ? COLORS.far : COLORS.near;
    for (const [x, y, c] of sharkPixels(s, o.t)) {
      ctx.fillStyle = palette[c];
      ctx.fillRect(x, y, s.scale, s.scale);
    }
  }
  ctx.fillStyle = COLORS.fish;
  for (const f of o.fish) {
    const left = f.vx < 0;
    FISH.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c === '.') return;
        const px = left ? row.length - 1 - x : x;
        ctx.fillRect(Math.round(f.x) + px - 2, Math.round(f.y) + y - 1, 1, 1);
      }),
    );
  }
}

export function Ocean() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const size = () => [Math.max(1, Math.ceil(innerWidth / PX)), Math.max(1, Math.ceil(innerHeight / PX))] as const;
    const [w, h] = size();
    el.width = w;
    el.height = h;
    const sea = createOcean(w, h);
    // Quelques pas d'avance : le banc est déjà formé à la première image.
    for (let i = 0; i < 240; i++) step(sea);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      last = now;
      step(sea);
      draw(ctx, sea);
    };
    const play = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      draw(ctx, sea);
      if (!reduce.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    // Redimensionnement regroupé sur une image, et seulement si la taille change.
    let resizing = 0;
    const onResize = () => {
      cancelAnimationFrame(resizing);
      resizing = requestAnimationFrame(() => {
        const [nw, nh] = size();
        if (nw === el.width && nh === el.height) return;
        el.width = nw;
        el.height = nh;
        resizeOcean(sea, nw, nh);
        draw(ctx, sea);
      });
    };
    play();
    document.addEventListener('visibilitychange', play);
    reduce.addEventListener('change', play);
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizing);
      document.removeEventListener('visibilitychange', play);
      reduce.removeEventListener('change', play);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return <canvas ref={canvas} className="ocean" aria-hidden="true" />;
}
