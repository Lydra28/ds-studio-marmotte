import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { resolve, type TokenSet } from '../shared/model.js';

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

// Pastille en pixel art, même sprite que le logo de l'app (desktop/icon.png,
// grille 16 × 16) : nuancier à visage, teinté par la couleur de marque du
// projet. Les traits passent en clair sur une marque sombre.
export type Mood = 'idle' | 'thinking' | 'worried';
type Rect = [x: number, y: number, w: number, h: number];

// # contour, Y teinte du projet, W étiquette, b trait de l'étiquette.
const BODY = [
  '..############..',
  '.#YYYYYYYYYYYY#.',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YYYYYYYYYYYYYY#',
  '#YWWWWWWWWWWWWY#',
  '#YWbbbbbWWWWWWY#',
  '#YWWWWWWWWWWWWY#',
  '.#YYYYYYYYYYYY#.',
  '..############..',
];
// Plages de même caractère fusionnées : une vingtaine de rectangles.
const runs = (char: string): Rect[] =>
  BODY.flatMap((row, y) => [...row.matchAll(new RegExp(`${char}+`, 'g'))].map((m): Rect => [m.index!, y, m[0].length, 1]));
const OUTLINE = runs('#');
const FILL = runs('Y');
const LABEL = runs('W');
const BAR = runs('b');

type Face = 'idle' | 'thinking' | 'worried' | 'joy';
const FACES: Record<Face, { eyes: Rect[]; mouth: Rect[] }> = {
  idle: {
    eyes: [[4, 4, 2, 2], [10, 4, 2, 2]],
    mouth: [[5, 7, 1, 1], [10, 7, 1, 1], [6, 8, 4, 1]],
  },
  // Regard en haut à droite, bouche pincée, bulles de réflexion.
  thinking: {
    eyes: [[5, 3, 2, 2], [11, 3, 2, 2]],
    mouth: [[7, 8, 3, 1]],
  },
  // Sourcils relevés au centre, bouche à l'envers.
  worried: {
    eyes: [[4, 5, 2, 1], [10, 5, 2, 1], [4, 3, 1, 1], [5, 2, 1, 1], [11, 3, 1, 1], [10, 2, 1, 1]],
    mouth: [[6, 7, 4, 1], [5, 8, 1, 1], [10, 8, 1, 1]],
  },
  // Yeux en ^, grande bouche ouverte.
  joy: {
    eyes: [[3, 5, 1, 1], [4, 4, 2, 1], [6, 5, 1, 1], [9, 5, 1, 1], [10, 4, 2, 1], [12, 5, 1, 1]],
    mouth: [[5, 7, 6, 1], [6, 8, 4, 1]],
  },
};

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const rects = (list: Rect[], fill: string, className?: string) =>
  list.map(([x, y, w, h]) => <rect key={`${x}-${y}-${w}`} className={className} x={x} y={y} width={w} height={h} fill={fill} />);

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
  const ink = luminance(color) > 0.3 ? '#0b0b0c' : '#f2f1ec';
  return (
    <span className={`mascot mascot--${face}`} aria-hidden="true">
      <svg viewBox="-2 -4 20 22" shapeRendering="crispEdges">
        <rect className="mascot__shadow" x={2} y={17} width={12} height={1} />
        <g className="mascot__body">
          {rects(OUTLINE, '#0b0b0c')}
          {rects(FILL, color)}
          {rects(LABEL, '#f2f1ec')}
          {rects(BAR, '#0b0b0c')}
          <g className="mascot__eyes">{rects(FACES[face].eyes, ink)}</g>
          {rects(FACES[face].mouth, ink)}
          {face === 'worried' && rects([[13, 2, 1, 2]], '#7cc4ff', 'mascot__drop')}
        </g>
        {face === 'thinking' && (
          <g className="mascot__thought">
            {rects([[15, 0, 1, 1], [16, -2, 2, 2], [17, -4, 3, 2]], '#f2f1ec')}
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
