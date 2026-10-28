import { contrast } from './model.js';

// Générateur de gamme : une couleur et son palier (ex. 600) donnent tous les
// paliers d'une rampe, calculés en OKLCH (clarté perçue régulière, teinte
// gardée). La couleur donnée reste exacte à son palier. Sans IA.

export const STANDARD_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

// Clarté OKLCH visée par palier quand la couleur n'impose rien : de 0 (blanc)
// à 1000 (noir), proche des gammes usuelles (Tailwind, Radix).
const CURVE: [number, number][] = [
  [0, 1],
  [50, 0.97],
  [100, 0.935],
  [200, 0.88],
  [300, 0.8],
  [400, 0.71],
  [500, 0.63],
  [600, 0.55],
  [700, 0.47],
  [800, 0.39],
  [900, 0.3],
  [950, 0.22],
  [1000, 0],
];
function curve(step: number) {
  const i = CURVE.findIndex(([s]) => s >= step);
  if (i <= 0) return CURVE[Math.max(i, 0)][1];
  const [s0, l0] = CURVE[i - 1];
  const [s1, l1] = CURVE[i];
  return l0 + ((step - s0) / (s1 - s0)) * (l1 - l0);
}

// --- sRGB ↔ OKLab (Björn Ottosson).
const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const toGamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

export function hexToOklch(hex: string): [number, number, number] {
  const [r, g, b] = hex
    .slice(1)
    .match(/../g)!
    .map((x) => toLinear(parseInt(x, 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI];
}

function oklchToLinear(L: number, C: number, h: number): [number, number, number] {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb: number[]) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

// Couleur affichable la plus proche : même clarté et même teinte, saturation
// réduite jusqu'à entrer dans le sRGB.
export function oklchToHex(L: number, C: number, h: number) {
  let lo = 0;
  let hi = C;
  let rgb = oklchToLinear(L, C, h);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToLinear(L, lo, h);
  }
  return (
    '#' +
    rgb
      .map((x) =>
        Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, x))))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

export interface RampStep {
  step: number;
  hex: string;
  // Contraste d'un texte blanc et d'un texte noir sur ce palier (WCAG).
  onWhite: number;
  onBlack: number;
}

// Clarté des autres paliers : la courbe par défaut, étirée pour passer
// exactement par la couleur donnée (vers le blanc au-dessus, le noir en dessous).
export function generateRamp(hex: string, anchor: number, steps: number[]): RampStep[] {
  const [Lb, Cb, h] = hexToOklch(hex);
  const La = curve(anchor);
  const peak = Lb * (1 - Lb);
  return [...new Set(steps)]
    .sort((a, b) => a - b)
    .map((step) => {
      let color = hex.toUpperCase();
      if (step !== anchor) {
        const Ld = curve(step);
        const L =
          step < anchor
            ? Lb + ((Ld - La) * (1 - Lb)) / Math.max(1 - La, 1e-6)
            : Lb - ((La - Ld) * Lb) / Math.max(La, 1e-6);
        // Saturation : maximale vers le milieu, réduite vers le blanc et le noir.
        const C = Cb * Math.min(1, peak > 1e-6 ? ((L * (1 - L)) / peak) ** 0.8 : 0);
        color = oklchToHex(Math.min(1, Math.max(0, L)), C, h);
      }
      return { step, hex: color, onWhite: contrast(color, '#FFFFFF'), onBlack: contrast(color, '#000000') };
    });
}
