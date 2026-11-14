import { memo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { resolve, type TokenSet } from '../shared/model.js';
import { ASSISTANT_64, type Rect } from './sprites.js';

// Couleur de marque du projet, brouillon compris : `bg/brand`, sinon le
// premier token de couleur « brand », « primary » ou « accent ».
export function brandColor(set: TokenSet) {
  const keys = Object.keys(set.tokens).filter((k) => set.tokens[k].$type === 'color');
  const key = ['bg/brand', ...[/brand/, /primary/, /accent/].flatMap((r) => keys.filter((k) => r.test(k)))].find((k) =>
    keys.includes(k),
  );
  try {
    const value = key && String(resolve(set, key));
    if (value && /^#[0-9a-f]{6}$/i.test(value)) return value;
  } catch {
    /* Alias cassé dans le brouillon : couleur par défaut. */
  }
  return '#7C5CFF';
}

// Mascotte de l'assistant : requin marteau de face en pixel art, 64 × 64
// (choix de Romain du 2026-11-14), grille générée par scripts/logo.mjs
// (sprites.ts). Teintée par la couleur de marque du projet, ombre assombrie ;
// les traits du visage passent en clair sur une marque sombre.
export type Mood = 'idle' | 'thinking' | 'worried';

// Plages de même caractère fusionnées en rectangles.
const runs = (char: string): Rect[] =>
  ASSISTANT_64.flatMap((row, y) => [...row.matchAll(new RegExp(`${char}+`, 'g'))].map((m): Rect => [m.index!, y, m[0].length, 1]));
const OUTLINE = runs('#');
const FILL = runs('Y');
const SHADE = runs('s');

// Yeux au bout du marteau (3 × 3), bouche sous le marteau ; coordonnées 0..64.
// Sourire sans dents (demande de Romain du 2026-11-14).
type Face = 'idle' | 'thinking' | 'worried' | 'joy';
const FACES: Record<Face, { eyes: Rect[]; mouth: Rect[] }> = {
  idle: {
    eyes: [[3, 28, 3, 3], [58, 28, 3, 3]],
    mouth: [[25, 35, 2, 2], [37, 35, 2, 2], [27, 37, 10, 2]],
  },
  // Regard en haut, bouche pincée, bulles de réflexion.
  thinking: {
    eyes: [[3, 27, 3, 2], [58, 27, 3, 2]],
    mouth: [[30, 37, 7, 2]],
  },
  // Yeux plissés, bouche à l'envers, goutte.
  worried: {
    eyes: [[3, 29, 3, 2], [58, 29, 3, 2]],
    mouth: [[27, 35, 10, 2], [25, 37, 2, 2], [37, 37, 2, 2]],
  },
  // Yeux en ^, grande bouche ouverte.
  joy: {
    eyes: [[2, 30, 1, 1], [3, 29, 3, 1], [6, 30, 1, 1], [57, 30, 1, 1], [58, 29, 3, 1], [61, 30, 1, 1]],
    mouth: [[24, 35, 16, 2], [26, 37, 12, 2], [29, 39, 6, 2]],
  },
};

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
// Ombre : la couleur de marque à 70 %.
const darker = (hex: string) =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.7).toString(16).padStart(2, '0')).join('');
const rects = (list: Rect[], fill: string, className?: string) =>
  list.map(([x, y, w, h]) => <rect key={`${x}-${y}-${w}`} className={className} x={x} y={y} width={w} height={h} fill={fill} />);
// Corps (environ 300 plages) : ne se redessine que si la teinte change.
const Body = memo(function Body({ color }: { color: string }) {
  return (
    <>
      {rects(OUTLINE, '#07080a')}
      {rects(FILL, color)}
      {rects(SHADE, darker(color))}
    </>
  );
});

export function Mascot({ color, mood = 'idle', cheer = 0 }: { color: string; mood?: Mood; cheer?: number }) {
  // Fête : visage de joie et saut, puis retour à l'humeur.
  const [joy, setJoy] = useState(false);
  useEffect(() => {
    if (!cheer) return;
    setJoy(true);
    const timer = setTimeout(() => setJoy(false), 1600);
    return () => clearTimeout(timer);
  }, [cheer]);
  const face: Face = joy ? 'joy' : mood;
  const ink = luminance(color) > 0.3 ? '#07080a' : '#f3f4ef';
  return (
    <span className={`mascot mascot--${face}`} aria-hidden="true">
      <svg viewBox="-8 -16 80 88" shapeRendering="crispEdges">
        <rect className="mascot__shadow" x={16} y={60} width={32} height={3} />
        <g className="mascot__body">
          <Body color={color} />
          <g className="mascot__eyes">{rects(FACES[face].eyes, ink)}</g>
          {rects(FACES[face].mouth, ink)}
          {face === 'worried' && rects([[50, 14, 3, 6]], '#7cc4ff', 'mascot__drop')}
        </g>
        {face === 'thinking' && (
          <g className="mascot__thought">
            {rects([[48, 4, 4, 4], [53, -4, 7, 7], [60, -14, 12, 8]], '#f3f4ef')}
          </g>
        )}
      </svg>
    </span>
  );
}

// Confettis de fête (repris de Poulpy) : émojis lancés en éventail, vers le
// haut et la gauche puisque la mascotte est dans le coin.
const CONFETTI = ['🎉', '⭐', '🎨', '✨', '🎊', '💚', '⭐', '✨', '🎉'];
function Confetti() {
  return (
    <span className="mascot-confetti" aria-hidden="true">
      {CONFETTI.map((emoji, i) => (
        <span key={i} style={{ '--angle': `${-120 + (150 / (CONFETTI.length - 1)) * i}deg` } as CSSProperties}>
          {emoji}
        </span>
      ))}
    </span>
  );
}

// Mascotte flottante en bas à droite : ouvre l'assistant, réagit aux écarts
// (inquiète, pastille du nombre) et fête les enregistrements.
export function MascotDock({
  color,
  findings,
  cheer,
  raised,
  onOpen,
}: {
  color: string;
  findings: number;
  cheer: { n: number; text: string };
  raised: boolean;
  onOpen: () => void;
}) {
  const [bubble, setBubble] = useState('');
  const [party, setParty] = useState(0);
  const previous = useRef(findings);
  const say = (text: string) => setBubble(text);
  useEffect(() => {
    const before = previous.current;
    previous.current = findings;
    if (findings > before) say(`${findings} écart(s) : regarde « Corrections ».`);
    else if (before > 0 && findings === 0) {
      say('Plus aucun écart !');
      setParty((p) => p + 1);
    }
  }, [findings]);
  useEffect(() => {
    if (!cheer.n) return;
    say(cheer.text);
    setParty((p) => p + 1);
  }, [cheer]);
  useEffect(() => {
    if (!bubble) return;
    const timer = setTimeout(() => setBubble(''), 4000);
    return () => clearTimeout(timer);
  }, [bubble]);
  return (
    <div className={`mascot-dock ${raised ? 'is-raised' : ''}`}>
      {bubble && (
        <p className="mascot-bubble" role="status">
          {bubble}
        </p>
      )}
      <button
        className="mascot-button"
        aria-label="Ouvrir l’assistant"
        title={findings ? `${findings} écart(s) · Demander à l’assistant` : 'Demander à l’assistant'}
        onClick={onOpen}
      >
        <Mascot color={color} mood={findings ? 'worried' : 'idle'} cheer={party} />
        {findings > 0 && <span className="mascot-badge">{findings}</span>}
        {party > 0 && <Confetti key={party} />}
      </button>
    </div>
  );
}
