import { useEffect, useMemo, useRef, useState } from 'react';
import { applyChanges, resolve, type Change, type TokenSet } from '../shared/model.js';
import { runRules } from '../shared/rules.js';
import {
  addLink,
  addImage,
  getWall,
  proposeDirections,
  removeInspiration,
  wallFileUrl,
  type Direction,
  type WallState,
} from './api.js';
import { fontFamilies, loadFonts } from './fonts.js';

// Image fournie : réduite dans le navigateur (1280 px, JPEG) avant envoi.
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

const swatchKeys = ['bg/canvas', 'bg/surface', 'bg/brand', 'bg/brand-subtle', 'text/primary', 'text/danger'];

// Preview d'une DA : la même page que la preview principale, avec le jeu candidat.
function DirectionPreview({ set }: { set: TokenSet }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const push = () => frame.current?.contentWindow?.postMessage({ type: 'ds-set', set }, location.origin);
    const onReady = (e: MessageEvent) => {
      if (e.origin === location.origin && e.source === frame.current?.contentWindow && e.data?.type === 'ds-ready') push();
    };
    window.addEventListener('message', onReady);
    push();
    return () => window.removeEventListener('message', onReady);
  }, [set]);
  return <iframe ref={frame} className="direction-frame" title="Preview de la DA" src="/?preview=1" />;
}

function Planche({
  direction,
  index,
  base,
  onChoose,
}: {
  direction: Direction;
  index: number;
  base: TokenSet;
  onChoose: (changes: Change[]) => void;
}) {
  const candidate = useMemo(() => {
    try {
      return applyChanges(base, direction.changes);
    } catch {
      return undefined;
    }
  }, [base, direction]);
  useEffect(() => {
    if (candidate) loadFonts(fontFamilies(candidate));
  }, [candidate]);
  if (!candidate)
    return (
      <article className="planche">
        <h3>
          {index + 1} · {direction.name}
        </h3>
        <p className="add-error">Le jeu a changé depuis la génération : cette DA ne s’applique plus. Relance.</p>
      </article>
    );
  const findings = runRules(candidate);
  const heading = candidate.tokens['font/family/heading'] ? String(resolve(candidate, 'font/family/heading')) : undefined;
  const body = candidate.tokens['font/family/base'] ? String(resolve(candidate, 'font/family/base')) : undefined;
  return (
    <article className="planche" aria-label={`DA ${index + 1} : ${direction.name}`}>
      <h3 style={{ fontFamily: heading ?? body }}>
        {index + 1} · {direction.name}
      </h3>
      <p className="intention">{direction.intention}</p>
      <div className="palette" aria-label="Palette">
        {swatchKeys
          .filter((k) => candidate.tokens[k])
          .map((k) => (
            <span key={k} title={`${k} ${String(resolve(candidate, k))}`} style={{ background: String(resolve(candidate, k)) }} />
          ))}
      </div>
      <p className="fonts mono">
        {[direction.fonts.heading, direction.fonts.body].filter(Boolean).join(' + ') || 'Polices inchangées'} ·{' '}
        {direction.changes.length} changements
      </p>
      <p className={findings.length ? 'planche-flag warn' : 'planche-flag ok'}>
        {findings.length ? `${findings.length} écart(s) des règles` : '0 écart'}
        {direction.dropped ? (
          <span> · {direction.dropped} proposition(s) écartée(s)</span>
        ) : null}
      </p>
      {direction.droppedReasons?.length ? (
        <details className="dropped">
          <summary>Pourquoi écartées</summary>
          <ul>
            {direction.droppedReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <DirectionPreview set={candidate} />
      <p className="rationale">{direction.rationale}</p>
      <button className="primary" onClick={() => onChoose(direction.changes)}>
        Choisir la DA {index + 1} → brouillon
      </button>
    </article>
  );
}

export default function Wall({
  project,
  base,
  onChoose,
  onBack,
}: {
  project: string;
  base: TokenSet;
  onChoose: (changes: Change[]) => void;
  onBack: () => void;
}) {
  const [wall, setWall] = useState<WallState>();
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => getWall().then(setWall).catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const result = wall?.result;
  return (
    <div className="wall">
      <header className="wall-head">
        <div>
          <h2>Mur des DA</h2>
          <p className="hint">
            Dépose tes inspirations, l’assistant propose 1 à 3 directions. Tu en choisis une : elle devient un brouillon,
            validé par le diff.
          </p>
        </div>
        <button onClick={onBack}>Retour à la planche</button>
      </header>

      <section className="inspirations" aria-label="Inspirations">
        <ul>
          {wall?.inspirations.map((i, n) => (
            <li key={i.id} className="inspiration">
              <img src={wallFileUrl(project, i.id)} alt={i.name} />
              <span className="mono">
                {n + 1}. {i.kind === 'capture' ? i.name : i.name.slice(0, 24)}
              </span>
              <button
                className="remove"
                aria-label={`Retirer ${i.name}`}
                onClick={() => run('remove', async () => setWall(await removeInspiration(i.id)))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="inspiration-add">
          <button onClick={() => file.current?.click()} disabled={!!busy}>
            + Images
          </button>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void run('image', async () => {
                for (const f of files) await addImage(f.name, await shrink(f));
                await refresh();
              });
            }}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!link.trim()) return;
              void run('link', async () => {
                await addLink(link.trim());
                setLink('');
                await refresh();
              });
            }}
          >
            <input
              aria-label="Lien d’inspiration"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://… (capture automatique)"
            />
            <button type="submit" disabled={!!busy || !link.trim()}>
              {busy === 'link' ? 'Capture…' : 'Ajouter le lien'}
            </button>
          </form>
        </div>
      </section>

      <section className="wall-ask" aria-label="Demande">
        <textarea
          aria-label="Précisions pour l’assistant"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Précisions : ambiance, ce que tu veux éviter… (la doctrine du projet est déjà envoyée)"
        />
        <label>
          DA
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <button
          className="primary"
          disabled={!!busy || !wall?.enabled}
          title={wall?.enabled ? '' : 'Assistant désactivé : clé OpenRouter absente'}
          onClick={() => run('directions', async () => setWall({ ...wall!, result: await proposeDirections(note, count) }))}
        >
          {busy === 'directions' ? 'L’assistant compose…' : `Proposer ${count} DA`}
        </button>
      </section>
      {busy === 'directions' && <p className="hint">Environ 20 à 60 s : l’assistant lit les inspirations et compose chaque DA.</p>}
      {error && (
        <p className="add-error" role="alert">
          {error}
          {result && ' La dernière génération enregistrée reste affichée ci-dessous.'}
        </p>
      )}

      {result && (
        <>
          <p className="hint mono">
            Génération enregistrée du {new Date(result.date).toLocaleString('fr-FR')} · {result.model}
            {result.usage ? ` · ${result.usage.prompt} + ${result.usage.completion} tokens` : ''}
          </p>
          <div className="planches">
            {result.directions.map((d, i) => (
              <Planche key={d.name + i} direction={d} index={i} base={base} onChoose={onChoose} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
