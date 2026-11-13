// Océan de l'accueil (cadrage navigation et UX du 2026-11-14) : simulation
// pure, sans DOM, en « pixels d'océan » (un pixel = un carré de PX px à
// l'écran). Deux requins traversent à deux profondeurs ; un banc de
// poissons suit trois règles de groupe (séparation, alignement, cohésion) et
// fuit les requins. Écrit pour DS-Studio, rien n'est repris d'un autre dépôt.

// Silhouettes vues de profil, tournées vers la droite. # corps, b ventre,
// e œil, g ouïes, . vide.
export const SHARK = [
  '...............#..............',
  '..............##..............',
  '.............###..............',
  '#...........#####.............',
  '##.....##################.....',
  '.##..#############g#g####e##..',
  '..###############g#g#########.',
  '..##bbbbbbbbbbbbbbbbbbbbbbb##.',
  '.##...bbbbbbbbbbbbbbbbbbbb....',
  '##..........###...............',
  '..............##..............',
];
export const FISH = ['#.##.', '.####', '#.##.'];

export type Rand = () => number;
export interface Shark {
  x: number;
  y: number;
  vx: number;
  // Lointain : plus petit pas, plus sombre (parallaxe).
  far: boolean;
  phase: number;
  // Taille d'un pixel du sprite en pixels d'océan (proche 2, lointain 1).
  scale: number;
}
export interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
}
export interface Bubble {
  x: number;
  y: number;
}
export interface Ocean {
  w: number;
  h: number;
  t: number;
  // Point que le banc suit sans hâte, dans la moitié basse (sous le contenu).
  lure: { x: number; y: number };
  sharks: Shark[];
  fish: Fish[];
  bubbles: Bubble[];
}

// Réglages du banc, en pixels d'océan par pas (un pas = 1/20 s).
export const SCHOOL = {
  count: 26,
  view: 20,
  personal: 8,
  maxSpeed: 1.1,
  minSpeed: 0.35,
  fear: 26,
  margin: 6,
};

export function createOcean(w: number, h: number, rand: Rand = Math.random): Ocean {
  const cx = w * (0.25 + rand() * 0.5);
  const cy = h * (0.6 + rand() * 0.2);
  return {
    w,
    h,
    t: 0,
    lure: { x: cx, y: cy },
    sharks: [
      { x: w * 0.15, y: h * 0.62, vx: 0.45, far: false, phase: 0, scale: 2 },
      { x: w * 0.8, y: h * 0.3, vx: -0.25, far: true, phase: 2, scale: 1 },
    ],
    fish: Array.from({ length: SCHOOL.count }, () => {
      const a = rand() * Math.PI * 2;
      return { x: cx + (rand() - 0.5) * 20, y: cy + (rand() - 0.5) * 12, vx: Math.cos(a) * 0.6, vy: Math.sin(a) * 0.3 };
    }),
    bubbles: Array.from({ length: 10 }, () => ({ x: rand() * w, y: rand() * h })),
  };
}

// Redimensionnement : on garde les créatures, ramenées dans le nouveau cadre.
export function resizeOcean(o: Ocean, w: number, h: number) {
  const sx = w / o.w;
  const sy = h / o.h;
  for (const s of o.sharks) {
    s.x *= sx;
    s.y *= sy;
  }
  for (const f of o.fish) {
    f.x = Math.min(Math.max(f.x * sx, 0), w);
    f.y = Math.min(Math.max(f.y * sy, 0), h);
  }
  for (const b of o.bubbles) {
    b.x *= sx;
    b.y *= sy;
  }
  o.w = w;
  o.h = h;
}

const sharkW = SHARK[0].length;
const sharkH = SHARK.length;

export function step(o: Ocean, rand: Rand = Math.random) {
  o.t++;
  // Requins : traversée lente, ondulation verticale, retour de l'autre côté.
  for (const s of o.sharks) {
    const sw = sharkW * s.scale;
    s.x += s.vx;
    s.y += Math.sin((o.t + s.phase * 40) / 60) * (s.far ? 0.04 : 0.08);
    if (s.vx > 0 && s.x > o.w + 8) s.x = -sw - 8;
    if (s.vx < 0 && s.x < -sw - 8) s.x = o.w + 8;
    s.y = Math.min(Math.max(s.y, 2), Math.max(2, o.h - sharkH * s.scale - 2));
  }
  // Leurre : une boucle lente (lissajous) dans la moitié basse de l'écran.
  o.lure.x = o.w * (0.5 + 0.38 * Math.sin(o.t / 420));
  o.lure.y = o.h * (0.72 + 0.14 * Math.sin(o.t / 260));
  // Banc : séparation, alignement, cohésion, fuite des requins, bords mous.
  const next = o.fish.map((f) => {
    let ax = 0;
    let ay = 0;
    let n = 0;
    let cx = 0;
    let cy = 0;
    let avx = 0;
    let avy = 0;
    for (const g of o.fish) {
      if (g === f) continue;
      const dx = g.x - f.x;
      const dy = g.y - f.y;
      const d = Math.hypot(dx, dy);
      if (d > SCHOOL.view) continue;
      n++;
      cx += g.x;
      cy += g.y;
      avx += g.vx;
      avy += g.vy;
      if (d < SCHOOL.personal && d > 0) {
        ax -= (dx / d) * (SCHOOL.personal - d) * 0.06;
        ay -= (dy / d) * (SCHOOL.personal - d) * 0.06;
      }
    }
    if (n) {
      ax += (cx / n - f.x) * 0.0015 + (avx / n - f.vx) * 0.05;
      ay += (cy / n - f.y) * 0.0015 + (avy / n - f.vy) * 0.05;
    }
    ax += (o.lure.x - f.x) * 0.0006;
    ay += (o.lure.y - f.y) * 0.0006;
    for (const s of o.sharks) {
      if (s.far) continue;
      const dx = f.x - (s.x + (sharkW * s.scale) / 2);
      const dy = f.y - (s.y + (sharkH * s.scale) / 2);
      const d = Math.hypot(dx, dy);
      if (d < SCHOOL.fear && d > 0) {
        ax += (dx / d) * (SCHOOL.fear - d) * 0.012;
        ay += (dy / d) * (SCHOOL.fear - d) * 0.012;
      }
    }
    const m = SCHOOL.margin;
    if (f.x < m) ax += 0.05;
    if (f.x > o.w - m) ax -= 0.05;
    if (f.y < m) ay += 0.05;
    if (f.y > o.h - m) ay -= 0.05;
    let vx = f.vx + ax + (rand() - 0.5) * 0.02;
    let vy = (f.vy + ay) * 0.98;
    const v = Math.hypot(vx, vy);
    if (v > SCHOOL.maxSpeed) {
      vx = (vx / v) * SCHOOL.maxSpeed;
      vy = (vy / v) * SCHOOL.maxSpeed;
    } else if (v < SCHOOL.minSpeed && v > 0) {
      vx = (vx / v) * SCHOOL.minSpeed;
      vy = (vy / v) * SCHOOL.minSpeed;
    }
    return {
      x: Math.min(Math.max(f.x + vx, 0), o.w),
      y: Math.min(Math.max(f.y + vy, 0), o.h),
      vx,
      vy,
    };
  });
  o.fish = next;
  // Bulles : montent d'un pixel tous les deux pas, repartent du fond.
  if (o.t % 2 === 0)
    for (const b of o.bubbles) {
      b.y -= 1;
      if (b.y < 0) {
        b.y = o.h;
        b.x = rand() * o.w;
      }
    }
}

// Pixels d'un requin à dessiner : [x, y, caractère] (carrés de `scale` de
// côté), miroir s'il nage à gauche,
// queue relevée d'un pixel une image sur deux (battement).
export function sharkPixels(s: Shark, t: number): [number, number, string][] {
  const out: [number, number, string][] = [];
  const flap = Math.floor(t / 6) % 2 === 1;
  SHARK.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === '.') return;
      const tail = x < 5 && flap ? 1 : 0;
      const px = s.vx < 0 ? sharkW - 1 - x : x;
      out.push([Math.round(s.x) + px * s.scale, Math.round(s.y) + (y + tail) * s.scale, c]);
    }),
  );
  return out;
}
