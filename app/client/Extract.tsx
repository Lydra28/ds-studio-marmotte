import { useEffect, useState } from 'react';
import type { Change } from '../shared/model.js';
import type { PageInventory } from '../shared/extract.js';
import { extractSite, type ExtractResult } from './api.js';

// Panneau « Extraction » (lot 5) : styles lus sur le site par le Chromium du
// poste, inventaire lisible puis propositions. Rien n'est écrit : « Mettre en
// brouillon » rejoint la boucle habituelle (écarts, diff, validation).
type Phase = { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; result: ExtractResult };

const percent = (n: number) => `${Math.round(n * 100)} %`;
const host = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

function colourShares(page: PageInventory) {
  const text = page.colors.reduce((n, c) => n + c.text, 0) || 1;
  const area = page.colors.reduce((n, c) => n + c.area, 0) || 1;
  return page.colors
    .map((c) => ({ hex: c.hex, share: (c.text / text + c.area / area) / 2, role: c.canvas ? 'fond' : c.interactive ? 'liens, boutons' : c.text > 0 ? 'texte' : c.border ? 'bordure' : '' }))
    .filter((c) => c.share >= 0.005)
    .sort((a, b) => b.share - a.share)
    .slice(0, 12);
}
function bySize(page: PageInventory) {
  const m = new Map<number, number>();
  for (const t of page.texts) m.set(t.size, (m.get(t.size) ?? 0) + t.chars);
  const total = [...m.values()].reduce((n, v) => n + v, 0) || 1;
  return [...m]
    .filter(([, n]) => n / total >= 0.005)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 8)
    .map(([size, n]) => `${size} px (${percent(n / total)})`)
    .join(' · ');
}
function families(page: PageInventory) {
  const m = new Map<string, number>();
  for (const t of page.texts) m.set(t.family || 'non lue', (m.get(t.family || 'non lue') ?? 0) + t.chars);
  const total = [...m.values()].reduce((n, v) => n + v, 0) || 1;
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f, n]) => `${f} (${percent(n / total)})`)
    .join(' · ');
}
const values = (list: { value: number; count: number }[], full = false) =>
  [...list]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((v) => (full && v.value === 999 ? 'plein' : `${v.value} px`))
    .join(' · ') || 'aucun';
const label = (c: Change) =>
  !('op' in c) ? `${c.key} (${c.mode}) → ${c.value}` : c.op === 'add' ? `+ ${c.key}` : c.op === 'remove' ? `− ${c.key}` : c.name;

export default function ExtractPanel({ url, onDraft, onClose }: { url: string; onDraft: (changes: Change[]) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setPhase({ status: 'loading' });
    extractSite(url).then(
      (result) => {
        if (alive) setPhase({ status: 'done', result });
      },
      (e: Error) => {
        if (alive) setPhase({ status: 'error', message: e.message });
      },
    );
    return () => {
      alive = false;
    };
  }, [url, attempt]);

  return (
    <section className="extract" aria-label="Extraction du site">
      <div className="extract-head">
        <div>
          <h2>Styles lus sur {host(url)}</h2>
          <p className="hint">
            Lecture faite sur ton poste, à 1280 et 390 px de large. Inventaire d’usage : les noms et les modes du design system
            d’origine ne sont pas lisibles depuis la page.
          </p>
        </div>
        <button onClick={onClose} aria-label="Fermer l’extraction">
          Fermer
        </button>
      </div>
      {phase.status === 'loading' && (
        <p className="extract-wait" role="status">
          Lecture du site… deux largeurs, 20 à 45 s.
        </p>
      )}
      {phase.status === 'error' && (
        <div className="extract-error">
          <p role="alert">{phase.message}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>Réessayer</button>
        </div>
      )}
      {phase.status === 'done' && <Result result={phase.result} onDraft={onDraft} />}
    </section>
  );
}

function Result({ result, onDraft }: { result: ExtractResult; onDraft: (changes: Change[]) => void }) {
  const { inventory, changes, rejected, report } = result;
  const { desktop, mobile } = inventory;
  return (
    <>
      <div className="extract-grid">
        <div>
          <h3>Couleurs</h3>
          <ul className="extract-colours" aria-label="Couleurs du site">
            {colourShares(desktop).map((c) => (
              <li key={c.hex} title={c.role}>
                <span className="chip" style={{ background: c.hex }} aria-hidden="true" />
                <code>{c.hex}</code> {percent(c.share)}
                {c.hex === report.brand && <strong> marque</strong>}
                {c.hex === report.danger && <strong> danger</strong>}
                {c.hex === report.accent && <strong> seconde teinte</strong>}
              </li>
            ))}
          </ul>
        </div>
        <dl>
          <dt>Polices</dt>
          <dd>{families(desktop) || 'aucune lue'}</dd>
          <dt>Tailles (1280 px)</dt>
          <dd>{bySize(desktop) || 'aucune'}</dd>
          <dt>Tailles (390 px)</dt>
          <dd>{bySize(mobile) || 'aucune'}</dd>
          <dt>Espacements</dt>
          <dd>{values(desktop.spacings)}</dd>
          <dt>Rayons</dt>
          <dd>{values(desktop.radii, true)}</dd>
          <dt>Ombres</dt>
          <dd>{desktop.shadows.length ? `${desktop.shadows.length} relevée(s), non tokenisées` : 'aucune'}</dd>
        </dl>
      </div>
      <ul className="extract-notes">
        {report.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <details className="extract-changes">
        <summary>{changes.length} changement(s) proposé(s) sur le jeu du projet</summary>
        <ul>
          {changes.map((c, i) => (
            <li key={i}>
              <code>{label(c)}</code>
            </li>
          ))}
        </ul>
      </details>
      {rejected.length > 0 && (
        <details className="extract-changes">
          <summary>{rejected.length} proposition(s) écartée(s)</summary>
          <ul>
            {rejected.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="form-actions">
        <button className="primary" disabled={changes.length === 0} onClick={() => onDraft(changes)}>
          Mettre en brouillon
        </button>
      </div>
    </>
  );
}
