// Types de scripts/plugin-assets.mjs pour les tests TypeScript (tsc --noEmit).
export interface Png {
  width: number;
  height: number;
  /** Pixels RGBA, 4 octets par pixel, ligne par ligne. */
  pixels: Buffer;
}
export interface SpriteRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}
/** Grille du sprite : '' pour une case transparente, sinon '#rrggbb'. */
export type Sprite = string[][];

export const GRID: number;
export const ICON: string;
export const UI: string;
export const OUT: string;
export const ICON_128: string;
export const COVER: string;

export function decodePng(buf: Buffer): Png;
export function encodePng(png: Png): Buffer;
export function resample(png: Png, width: number, height: number): Png;
export function spriteOf(png: Png): Sprite;
export function runsOf(grid: Sprite): SpriteRect[];
export function spriteSvg(grid: Sprite, size: number): string;
export function renderCover(grid: Sprite, out: string): Promise<void>;
