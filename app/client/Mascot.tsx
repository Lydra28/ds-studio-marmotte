import { useEffect, useRef, useState } from 'react';
import { resolve, type TokenSet } from '../shared/model.js';
import type { Mood, Pastille } from './pastille.js';

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

// La pastille 3D. Pendant le chargement de Three.js, ou sans WebGL, un rond
// de la même couleur la remplace.
export function Mascot({ color, mood = 'idle', cheer = 0 }: { color: string; mood?: Mood; cheer?: number }) {
  const scene = useRef<HTMLDivElement>(null);
  const pastille = useRef<Pastille | null>(null);
  const wanted = useRef({ color, mood });
  wanted.current = { color, mood };
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import('./pastille.js').then(
      ({ createPastille }) => {
        if (cancelled || !scene.current) return;
        try {
          pastille.current = createPastille(scene.current, wanted.current.color);
          pastille.current.setMood(wanted.current.mood);
          setReady(true);
        } catch {
          // Pas de WebGL : le rond reste.
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
      pastille.current?.dispose();
      pastille.current = null;
    };
  }, []);
  useEffect(() => {
    pastille.current?.setColor(color);
  }, [color, ready]);
  useEffect(() => {
    pastille.current?.setMood(mood);
  }, [mood, ready]);
  useEffect(() => {
    if (cheer) pastille.current?.celebrate();
  }, [cheer]);
  return (
    <span className="mascot" aria-hidden="true">
      {!ready && <span className="mascot__fallback" style={{ background: color }} />}
      <span className="mascot__scene" ref={scene} />
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
        <span key={i} style={{ '--angle': `${-120 + (150 / (CONFETTI.length - 1)) * i}deg` } as React.CSSProperties}>
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
