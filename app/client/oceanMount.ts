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

// Machine trop lente : après un temps de chauffe, on mesure 2 s d'animation
// (moteur visible seulement) ; le moteur s'arrête et une image fixe reste
// affichée si l'intervalle médian entre deux images dépasse 1/28 s, ou, pour
// un canvas monté avec `maxBusy`, si le moteur passe plus que cette part du
// temps à simuler et dessiner. Retenu pour la session. Seuil sous 1/30 s :
// un écran bridé à 30 Hz (économie d'énergie) n'est pas une machine lente.
// Part du temps mesurée le 2026-11-15 (Chromium, PC de Romain) : pied de
// page (demi-largeur) 18 à 27 % à CPU ×1, 70 % à ×2, 82 % à ×3 et ×4, où
// l'intervalle (33 ms) restait sous le seuil ; section interactive du site
// (pleine largeur) 84 à 88 % dès ×1 : le coût suit la surface (un fillText
// par case). D'où `maxBusy` réservé au décor du pied de page.
const WARMUP_MS = 500;
const PROBE_MS = 2000;
const SLOW_MS = 1000 / 28;
const PAUSE_MS = 250; // au-delà : onglet masqué ou pause, pas une image lente
const SETTLE_MS = 200; // image fixe : temps laissé au moteur pour dessiner
const FONT_MS = 1500; // police Google injoignable : on fige sans elle
const GROW = 0.15; // écart de taille au-delà duquel l'océan est repeuplé
// Retenu pour la session : lenteur d'intervalle → tous les océans figés ;
// part du temps de dessin dépassée → seuls ceux qui ont un `maxBusy` (le
// pied de page à CPU ×2 ne doit pas figer la section interactive).
const STILL = 'ds-ocean-still';
const STILL_BUSY = 'ds-ocean-still-busy';

/** `busy` : part du temps mesuré passée par le moteur à simuler et dessiner. */
export function tooSlow(gaps: number[], busy = 0, maxBusy = Infinity) {
  if (gaps.length === 0) return false;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] > SLOW_MS || busy > maxBusy;
}

const remembered = (key: string) => {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};
const remember = (key: string) => {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // stockage indisponible : on remesurera à la prochaine visite
  }
};

/**
 * Lance l'océan dans `el` ; renvoie la fonction qui l'arrête. `maxBusy` :
 * part du temps de dessin au-delà de laquelle on fige (sans : intervalle
 * entre images seulement).
 */
export function mountOcean(el: HTMLCanvasElement, { maxBusy = Infinity } = {}): () => void {
  let engine = new OceanEngine(el, SHARKS);
  let probeRaf = 0; // sonde de lenteur
  let probeWait = 0; // sonde en attente : moteur en pause
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

  if (remembered(STILL) || (maxBusy < Infinity && remembered(STILL_BUSY))) {
    keepStill();
    stillSoon();
  } else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Mouvement réduit : le moteur dessine déjà une image fixe, rien à sonder.
    let last = 0;
    let warm = 0;
    let measured = 0;
    let gaps: number[] = [];
    let probed = engine;
    let busyFrom = 0;
    const probe = (now: number) => {
      const gap = last ? now - last : 0;
      last = now;
      if (engine !== probed) {
        // Moteur neuf (fenêtre redimensionnée) : son compteur repart de zéro.
        probed = engine;
        warm = measured = 0;
        gaps = [];
      }
      // Mesure seulement quand le moteur anime : le pied de page est hors
      // écran au chargement, moteur en pause, il n'y a rien à juger. En
      // attendant, un coup d'œil toutes les 250 ms, pas une boucle d'images ;
      // le premier intervalle à la reprise (pause comprise) n'est pas compté.
      if (!engine.running) {
        last = 0;
        probeWait = window.setTimeout(() => (probeRaf = requestAnimationFrame(probe)), PAUSE_MS);
        return;
      }
      if (gap > 0 && gap < PAUSE_MS) {
        if (warm < WARMUP_MS) {
          warm += gap;
          busyFrom = engine.busyMs;
        } else {
          gaps.push(gap);
          measured += gap;
        }
      }
      if (measured < PROBE_MS) probeRaf = requestAnimationFrame(probe);
      else if (tooSlow(gaps, (engine.busyMs - busyFrom) / measured, maxBusy)) {
        remember(tooSlow(gaps) ? STILL : STILL_BUSY);
        engine.destroy(); // l'image en cours reste affichée
        keepStill();
      }
    };
    probeRaf = requestAnimationFrame(probe);
  }
  return () => {
    closed = true;
    cancelAnimationFrame(probeRaf);
    clearTimeout(probeWait);
    cancelAnimationFrame(stillRaf);
    clearTimeout(timer);
    clearTimeout(regrow);
    observer?.disconnect();
    engine.destroy();
  };
}
