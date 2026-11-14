import { useEffect, useRef } from 'react';
import { mountOcean } from './oceanMount.js';

// La logique (requins, sonde de lenteur, image fixe) est dans oceanMount.ts,
// partagée avec le site vitrine.
export { tooSlow } from './oceanMount.js';

export function Ocean() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    return mountOcean(el);
  }, []);
  return <canvas ref={canvas} className="ocean" aria-hidden="true" />;
}
