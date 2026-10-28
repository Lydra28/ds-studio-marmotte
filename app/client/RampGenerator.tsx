import { useState } from 'react';
import { isTokenKey, resolve, type Token, type TokenSet, type TokenValue } from '../shared/model.js';
import { generateRamp, STANDARD_STEPS } from '../shared/palette.js';

type Edit = (key: string, mode: string, value: TokenValue) => void;
type Add = (key: string, token: Token) => void;

const hexPattern = /^#[0-9a-fA-F]{6}$/;
// Paliers numériques d'une rampe ; 0 et 1000 (blanc, noir) ne sont jamais recalculés.
const numericSteps = (set: TokenSet, ramp: string) =>
  Object.keys(set.tokens)
    .filter((k) => k.startsWith(`${ramp}/`) && /^\d+$/.test(k.slice(ramp.length + 1)))
    .map((k) => Number(k.slice(ramp.length + 1)))
    .filter((s) => s > 0 && s < 1000);

// Générateur de gamme : une couleur à son palier → tous les paliers, mis en
// brouillon (valeurs changées ou tokens ajoutés). Rien n'est écrit sans diff.
export function RampGenerator({
  set,
  ramp,
  onEdit,
  onAdd,
  onClose,
}: {
  set: TokenSet;
  ramp?: string; // absente : nouvelle gamme
  onEdit: Edit;
  onAdd: Add;
  onClose: () => void;
}) {
  const existing = ramp ? numericSteps(set, ramp) : [];
  const start = existing.includes(500) ? 500 : existing.includes(600) ? 600 : (existing[Math.floor(existing.length / 2)] ?? 500);
  const [name, setName] = useState(ramp ?? 'color/');
  const [color, setColor] = useState(ramp ? String(resolve(set, `${ramp}/${start}`)).toUpperCase() : '#2F6BFF');
  const [anchor, setAnchor] = useState(start);
  const [complete, setComplete] = useState(!ramp);
  const steps = [...new Set([...existing, ...(complete || !existing.length ? STANDARD_STEPS : [])])].sort((a, b) => a - b);
  const problem = !hexPattern.test(color)
    ? 'couleur #RRGGBB attendue'
    : !ramp && (!isTokenKey(`${name}/500`) || name === 'color/' || !name.startsWith('color/'))
      ? 'nom de gamme : color/nom'
      : !ramp && Object.keys(set.tokens).some((k) => k.startsWith(`${name}/`))
        ? 'cette gamme existe déjà : utilise son bouton « Générer »'
        : '';
  const result = problem ? [] : generateRamp(color, steps.includes(anchor) ? anchor : steps[0], steps);
  const modes = set.modes.primitives;

  const apply = () => {
    for (const { step, hex } of result) {
      const key = `${name}/${step}`;
      const token = set.tokens[key];
      if (!token) onAdd(key, { $type: 'color', $collection: 'primitives', $values: Object.fromEntries(modes.map((m) => [m, hex])) });
      else for (const m of modes) if (String(token.$values[m]).toUpperCase() !== hex) onEdit(key, m, hex);
    }
    onClose();
  };

  return (
    <div className="ramp-gen" role="group" aria-label={ramp ? `Générer la gamme ${ramp}` : 'Nouvelle gamme'}>
      <div className="ramp-gen__controls">
        {!ramp && (
          <label>
            Nom
            <input value={name} onChange={(e) => setName(e.target.value.trim())} aria-label="Nom de la nouvelle gamme" />
          </label>
        )}
        <label>
          Couleur
          <span className="ramp-gen__color">
            <input type="color" value={hexPattern.test(color) ? color : '#000000'} onChange={(e) => setColor(e.target.value.toUpperCase())} aria-label="Couleur de base" />
            <input value={color} onChange={(e) => setColor(e.target.value.trim().toUpperCase())} aria-label="Couleur de base en hexadécimal" />
          </span>
        </label>
        <label>
          Au palier
          <select value={anchor} onChange={(e) => setAnchor(Number(e.target.value))} aria-label="Palier de la couleur de base">
            {steps.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {ramp && existing.length > 0 && (
          <label className="ramp-gen__check">
            <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} />
            Compléter de 50 à 900
          </label>
        )}
      </div>
      {problem ? (
        <p className="add-error">{problem}</p>
      ) : (
        <ol className="ramp-gen__steps">
          {result.map((r) => {
            const key = `${name}/${r.step}`;
            const current = set.tokens[key] ? String(resolve(set, key)).toUpperCase() : null;
            return (
              <li key={r.step} className={r.step === anchor ? 'is-anchor' : ''}>
                <span className="chip" style={{ background: r.hex }} />
                <strong>{r.step}</strong>
                <code>{r.hex}</code>
                <small>{current === null ? 'nouveau' : current === r.hex ? 'inchangé' : `avant ${current}`}</small>
                {/* Texte lisible sur ce palier (AA : 4,5 pour du texte courant). */}
                <small className="ramp-gen__contrast">
                  <span className={r.onWhite >= 4.5 ? 'ok' : ''} title="Contraste d’un texte blanc">
                    blanc {r.onWhite.toFixed(1)}
                  </span>{' '}
                  <span className={r.onBlack >= 4.5 ? 'ok' : ''} title="Contraste d’un texte noir">
                    noir {r.onBlack.toFixed(1)}
                  </span>
                </small>
              </li>
            );
          })}
        </ol>
      )}
      <div className="ramp-gen__actions">
        <button className="primary" disabled={!!problem} onClick={apply}>
          Mettre en brouillon
        </button>
        <button onClick={onClose}>Annuler</button>
        <small className="hint">La couleur donnée reste exacte à son palier ; contraste en vert : texte lisible (AA).</small>
      </div>
    </div>
  );
}
