import { useEffect, useMemo, useState } from 'react';
import { applyChanges, type Change, type TokenSet } from '../shared/model.js';
import { proposeFromInventory, type PageInventory } from '../shared/extract.js';
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

// Teintes candidates (marque possible) toujours listées, même peu étendues (logo).
function colourShares(page: PageInventory, keep: Set<string>) {
  const text = page.colors.reduce((n, c) => n + c.text, 0) || 1;
  // Surfaces peintes : fonds (dégradés compris) et formes SVG (logos, pictos).
  const area = page.colors.reduce((n, c) => n + c.area + c.graphic, 0) || 1;
  const role = (c: PageInventory['colors'][number]) =>
    c.canvas ? 'fond' : c.button ? 'boutons' : c.interactive ? 'liens' : c.graphic > c.area ? 'logo, pictos' : c.text > 0 ? 'texte' : c.border ? 'bordure' : '';
  return page.colors
    .map((c) => ({ hex: c.hex, share: (c.text / text + (c.area + c.graphic) / area) / 2, role: role(c) }))
    .filter((c) => c.share >= 0.005 || keep.has(c.hex))
    .sort((a, b) => b.share - a.share)
    .slice(0, 16);
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

export default function ExtractPanel({
  url,
  set,
  onDraft,
  onClose,
}: {
  url: string;
  // Jeu enregistré du projet : la proposition est recalculée dessus quand
  // Romain choisit une autre teinte de marque (aucune relecture du site).
  set: TokenSet | undefined;
  onDraft: (changes: Change[]) => void;
  onClose: () => void;
}) {
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
      {phase.status === 'done' && <Result result={phase.result} set={set} onDraft={onDraft} />}
    </section>
  );
}

function Result({ result, set, onDraft }: { result: ExtractResult; set: TokenSet | undefined; onDraft: (changes: Change[]) => void }) {
  const { inventory } = result;
  const [brand, setBrand] = useState(result.report.brand);
  const proposal = useMemo(
    () => (!set || brand === result.report.brand || !brand ? result : proposeFromInventory(inventory, set, { brand })),
    [result, set, brand, inventory],
  );
  const { changes, rejected, report } = proposal;
  const { desktop, mobile } = inventory;
  // Gamme de marque telle qu'elle sera mise en brouillon.
  const ramp = useMemo(() => {
    if (!set) return [];
    let next = set;
    try {
      next = applyChanges(set, changes);
    } catch {
      // Rejets déjà listés par la proposition.
    }
    return Object.entries(next.tokens)
      .filter(([k]) => /^color\/brand\/\d+$/.test(k))
      .map(([k, t]) => ({ step: k.slice('color/brand/'.length), hex: String(Object.values(t.$values)[0]) }))
      .sort((a, b) => Number(a.step) - Number(b.step));
  }, [set, changes]);
  return (
    <>
      <div className="extract-brand" role="group" aria-label="Marque proposée">
        <h3>Marque {report.brand ? <code>{report.brand}</code> : 'non trouvée'}</h3>
        {ramp.length > 0 && (
          <ul className="extract-ramp" aria-label="Gamme de marque proposée">
            {ramp.map((s) => (
              <li key={s.step}>
                <span className="chip" style={{ background: s.hex }} aria-hidden="true" />
                <span>{s.step}</span> <code>{s.hex}</code>
              </li>
            ))}
          </ul>
        )}
        {report.candidates.length > 1 && (
          <>
            <p className="hint">Pas la bonne teinte ? Choisis la marque parmi celles du site :</p>
            <div className="extract-picks">
              {report.candidates.map((c) => (
                <button
                  key={c.hex}
                  aria-pressed={c.hex === report.brand}
                  disabled={!set}
                  onClick={() => setBrand(c.hex)}
                  title={`Poids dans la page : ${percent(c.share)}`}
                >
                  <span className="chip" style={{ background: c.hex }} aria-hidden="true" />
                  <code>{c.hex}</code>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="extract-grid">
        <div>
          <h3>Couleurs</h3>
          <ul className="extract-colours" aria-label="Couleurs du site">
            {colourShares(desktop, new Set(report.candidates.map((c) => c.hex))).map((c) => (
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
