// Types de scripts/logo.mjs pour les tests TypeScript (tsc --noEmit).
export const SPRITES: string;
export const LOGO_SMALL: string;
export const ICON_512: string;
export const PALETTE: Record<string, string>;
export function logoPng(rows: string[], eyes: [number, number, number, number][], scale: number): Buffer;
