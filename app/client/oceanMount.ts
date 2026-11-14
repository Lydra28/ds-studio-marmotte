// Océan des requins (moteur ascii-sharks, app/client/ocean/, © 2026 drewdi,
// MIT) branché sur un canvas, sans framework : utilisé par Ocean.tsx (accueil
// de l'app) et par le site vitrine (section interactive, site/src/scripts/
// ocean.ts). Garde-fous communs : 60 i/s (moteur), machine lente → image
// fixe, mouvement réduit → image fixe (moteur), canvas redimensionné.
import { OceanEngine } from './ocean/engine.js';
import type { SharkSpec } from './ocean/world.js';

// Deux requins classiques du moteur (les « requins d'avant ») et deux requins
// marteaux plus gros, pour Lenny (voulu par Romain le 2026-11-14). Taille
// relative à la longueur de base du moteur ; au-delà de 1, l'éclat du requin
// dépasse à peine le plein (0,7 + 0,3 × taille). Quatre requins, comme le
// moteur par défaut (mesure de lenteur faite avec quatre).
export const SHARKS: SharkSpec[] = [
  { kind: 'greathammer', size: 1.15 },
  { kind: 'hammerhead', size: 1.08 },
  { kind: 'classic', size: 1 },
  { kind: 'classic', size: 0.84 },
];

// Machine trop lente (mesuré le 2026-11-14 : CPU bridé ×4, 19 à 25 i/s et
// thread principal plein) : après un temps de chauffe, on mesure 2 s
// d'animation ; si l'intervalle médian entre deux images dépasse 1/28 s, le
// moteur s'arrête et une image fixe reste affichée. Retenu pour la session.
// Seuil sous 1/30 s : un écran bridé à 30 Hz (économie d'énergie) n'est pas
// une machine lente.
const WARMUP_MS = 500;
const PROBE_MS = 2000;
const SLOW_MS = 1000 / 28;
const PAUSE_MS = 250; // au-delà : onglet masqué ou pause, pas une image lente
const SETTLE_MS = 200; // image fixe : temps laissé au moteur pour dessiner
const FONT_MS = 1500; // police Google injoignable : on fige sans elle
const GROW = 0.15; // écart de taille au-delà duquel l'océan est repeuplé
const STILL = 'ds-ocean-still';

export function tooSlow(gaps: number[]) {
  if (gaps.length === 0) return false;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] > SLOW_MS;
}

const remembered = () => {
  try {
    return sessionStorage.getItem(STILL) === '1';
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    sessionStorage.setItem(STILL, '1');
  } catch {
    // stockage indisponible : on remesurera à la prochaine visite
  }
};

/** Lance l'océan dans `el` ; renvoie la fonction qui l'arrête. */
export function mountOcean(el: HTMLCanvasElement): () => void {
  let engine = new OceanEngine(el, SHARKS);
  let probeRaf = 0; // sonde de lenteur
  let stillRaf = 0; // image fixe
  let closed = false;
  let observer: ResizeObserver | undefined;

  // Image fixe complète : police chargée (ou abandonnée après FONT_MS, hors
  // ligne), puis 200 ms de moteur (le canvas a pris sa taille ; sa mise à
  // taille l'efface, il faut une image après), puis arrêt au deuxième rAF :
  // onglet en arrière-plan, les rAF attendent son retour, et le moteur, dont
  // le rAF passe avant, dessine d'abord.
  let timer = 0;
  let seq = 0; // seul le dernier appel compte (rafale de redimensionnements)
  const stillSoon = () => {
    const id = ++seq;
    const font = `600 16px ${getComputedStyle(el).fontFamily}`;
    const loaded = document.fonts ? document.fonts.load(font).catch(() => undefined) : Promise.resolve();
    const ready = Promise.race([loaded, new Promise((done) => setTimeout(done, FONT_MS))]);
    void ready.then(() => {
      if (closed || id !== seq) return;
      clearTimeout(timer);
      cancelAnimationFrame(stillRaf);
      timer = window.setTimeout(() => {
        stillRaf = requestAnimationFrame(() => (stillRaf = requestAnimationFrame(() => engine.destroy())));
      }, SETTLE_MS);
    });
  };
  // Taille du canvas. Le moteur peuple le monde à sa première taille et ne
  // fait ensuite que recaler poissons et requins au bord : fenêtre élargie
  // après le chargement (app maximisée, panneau élargi), tout restait à
  // gauche. Écart de plus de GROW sur un côté : moteur neuf à la nouvelle
  // taille, une fois la fenêtre stable. Figé : le canvas ne suit plus la
  // fenêtre, moteur neuf le temps d'une image fixe à chaque changement,
  // une fois la fenêtre stable aussi. La sonde de lenteur continue.
  let still = false;
  let regrow = 0;
  const sizeOf = () => ({ w: el.clientWidth, h: el.clientHeight });
  let born = sizeOf();
  let shown = born;
  const renew = () => {
    seq++;
    clearTimeout(timer);
    cancelAnimationFrame(stillRaf);
    engine.destroy();
    engine = new OceanEngine(el, SHARKS);
    born = sizeOf();
    if (still) stillSoon();
  };
  const off = (a: number, b: number) => Math.abs(a - b) / Math.max(b, 1) > GROW;
  observer = new ResizeObserver(() => {
    const now = sizeOf();
    if (closed || (now.w === shown.w && now.h === shown.h)) return;
    shown = now;
    if (!still && !off(now.w, born.w) && !off(now.h, born.h)) return;
    clearTimeout(regrow);
    regrow = window.setTimeout(renew, SETTLE_MS);
  });
  observer.observe(el);
  const keepStill = () => {
    still = true;
    clearTimeout(regrow);
  };

  if (remembered()) {
    keepStill();
    stillSoon();
  } else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Mouvement réduit : le moteur dessine déjà une image fixe, rien à sonder.
    let last = 0;
    let warm = 0;
    let measured = 0;
    const gaps: number[] = [];
    const probe = (now: number) => {
      const gap = last ? now - last : 0;
      last = now;
      if (gap > 0 && gap < PAUSE_MS) {
        if (warm < WARMUP_MS) warm += gap;
        else {
          gaps.push(gap);
          measured += gap;
        }
      }
      if (measured < PROBE_MS) probeRaf = requestAnimationFrame(probe);
      else if (tooSlow(gaps)) {
        remember();
        engine.destroy(); // l'image en cours reste affichée
        keepStill();
      }
    };
    probeRaf = requestAnimationFrame(probe);
  }
  return () => {
    closed = true;
    cancelAnimationFrame(probeRaf);
    cancelAnimationFrame(stillRaf);
    clearTimeout(timer);
    clearTimeout(regrow);
    observer?.disconnect();
    engine.destroy();
  };
}
