import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createProject, listProjects, type ProjectSummary } from './api.js';

// Route dans le hash : `#/p/<projet>` ouvre un projet, sinon l'accueil.
const read = () => /^#\/p\/([a-z0-9-]+)$/.exec(location.hash)?.[1];
export function useRoute(): [string | undefined, (slug?: string) => void] {
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (slug?: string) => {
    location.hash = slug ? `/p/${slug}` : slug === undefined ? '/' : '/nouveau';
  };
  return [route, go];
}

function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    listProjects().then(setProjects).catch((e) => setError(e.message));
  }, []);
  return { projects, error };
}

// Sections de la planche dans la sous-barre, numérotées comme les étapes d'un DS.
export const sections = [
  ['h-colors', 'Primitives'],
  ['h-tokens', 'Tokens sémantiques'],
  ['h-type', 'Typographie'],
  ['h-scales', 'Échelles'],
  ['h-components', 'Composants'],
  ['h-names', 'Nomenclature'],
] as const;
// Sections repliables : celles de la sous-barre et « Autres primitives ».
export const foldable = ['h-colors', 'h-tokens', 'h-type', 'h-scales', 'h-others', 'h-components', 'h-names'];

export type View = 'wall' | 'board' | 'site' | 'versions';
const NEW = '__new';

// Barre du haut, dans l'ordre du travail : s'inspirer, construire, voir, versionner.
export function TopNav({
  current,
  name,
  revision,
  multi,
  onOpen,
  view,
  onView,
  site,
  versions,
  onVersion,
  children,
}: {
  current: string;
  name: string;
  revision: number;
  multi: boolean;
  onOpen: (slug?: string) => void;
  view: View;
  onView: (view: View) => void;
  // Faux : pas de site configuré (ou relais arrêté), l'étape est masquée.
  site: boolean;
  // Révisions des versions acceptées : une marche de « chaleur » chacune.
  versions: number[];
  onVersion: (revision: number) => void;
  children: ReactNode;
}) {
  const { projects } = useProjects();
  const steps: [View, string][] = [
    ['wall', 'Mur des DA'],
    ['board', 'Design system'],
    ...(site ? [['site', 'Site en direct'] as [View, string]] : []),
    ['versions', 'Versions'],
  ];
  return (
    <header className="bar">
      <div className="brand">
        <button className="logo" onClick={() => multi && onOpen()} disabled={!multi} aria-label="DS-Studio, accueil">
          DS-Studio
        </button>
        {/* Sélecteur natif sous le nom : accessible, et le nom garde le style des titres. */}
        <label className={`project-pick ${multi ? '' : 'is-fixed'}`}>
          <span className="project">{name}</span>
          {multi && (
            <select
              aria-label="Projet"
              value={current}
              onChange={(e) => onOpen(e.target.value === NEW ? '' : e.target.value)}
            >
              {!projects?.some((p) => p.slug === current) && <option value={current}>{name}</option>}
              {projects?.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
              <option value={NEW}>+ Nouveau projet</option>
            </select>
          )}
        </label>
        <span className="rev" title="Révision enregistrée">r{revision}</span>
      </div>
      <nav className="steps" aria-label="Étapes du projet">
        <ol>
          {steps.map(([v, label]) => (
            <li key={v}>
              <button aria-current={view === v ? 'page' : undefined} onClick={() => onView(v)}>
                {label}
              </button>
            </li>
          ))}
        </ol>
        {versions.length > 0 && <Stairs versions={versions} onVersion={onVersion} />}
      </nav>
      <div className="actions">{children}</div>
    </header>
  );
}

// Frise des versions (DA « Atelier 8-bit ») : une marche par version acceptée,
// gamme « chaleur », les six dernières ; une marche ouvre l'évolution à sa révision.
function Stairs({ versions, onVersion }: { versions: number[]; onVersion: (revision: number) => void }) {
  const shown = [...versions].sort((a, b) => a - b).slice(-6);
  return (
    <div className="stairs" role="group" aria-label={`${versions.length} version(s) acceptée(s)`}>
      {shown.map((v, i) => (
        <button
          key={v}
          style={{ height: 6 + 4 * (i + 1), background: `var(--c-heat-${Math.min(5, i + 1)})` }}
          aria-label={`Voir v${v} dans l’évolution`}
          title={`v${v}`}
          onClick={() => onVersion(v)}
        />
      ))}
      <small>v{shown[shown.length - 1]}</small>
    </div>
  );
}

// Sous-barre de la planche : sections numérotées, celle à l'écran surlignée.
export function SectionBar({
  folded,
  onJump,
  onFoldAll,
}: {
  folded: Set<string>;
  onJump: (id: string) => void;
  onFoldAll: (fold: boolean) => void;
}) {
  const [active, setActive] = useState<string>(sections[0][0]);
  useEffect(() => {
    let frame = 0;
    const on = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Dernière section dont le haut est passé sous la barre.
        const top = (document.querySelector('.top') as HTMLElement | null)?.offsetHeight ?? 0;
        let current: string = sections[0][0];
        for (const [id] of sections) {
          const el = document.getElementById(id);
          if (el && el.getBoundingClientRect().top <= top + 24) current = id;
        }
        setActive(current);
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', on);
    };
  }, []);
  const anyOpen = foldable.some((id) => !folded.has(id));
  return (
    <nav className="section-bar" aria-label="Sections du design system">
      <ol>
        {sections.map(([id, label], i) => (
          <li key={id}>
            <button aria-current={active === id ? 'location' : undefined} onClick={() => onJump(id)}>
              {i < 5 && <span className="nav-num">0{i + 1}</span>}
              {label}
            </button>
          </li>
        ))}
      </ol>
      <button className="fold-all" onClick={() => onFoldAll(anyOpen)}>
        {anyOpen ? 'Tout replier' : 'Tout déplier'}
      </button>
    </nav>
  );
}

export function Home({ onOpen }: { onOpen: (slug?: string) => void }) {
  const { projects, error } = useProjects();
  const [creating, setCreating] = useState(location.hash === '#/nouveau');
  useEffect(() => {
    const on = () => setCreating(location.hash === '#/nouveau');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="home">
      <header className="home-head">
        <h1>DS-Studio</h1>
        <p>Un atelier de design system par projet : essais en direct, règles, versions, transfert Figma.</p>
      </header>
      {error && <p className="message error" role="alert">{error}</p>}
      <ul className="project-grid" aria-label="Projets">
        {projects?.map((p) => (
          <li key={p.slug}>
            <button className="project-card" onClick={() => onOpen(p.slug)}>
              <strong>{p.name}</strong>
              <span className="mono">
                r{p.revision}
                {p.accepted !== null ? ` · v${p.accepted} acceptée` : ' · aucune version'}
              </span>
              <small>{p.updatedAt ? `Modifié le ${new Date(p.updatedAt).toLocaleDateString('fr-FR')}` : 'Jamais modifié'}</small>
            </button>
          </li>
        ))}
        <li>
          <button className="project-card new" onClick={() => onOpen('')}>
            <strong>+ Nouveau projet</strong>
            <small>Jeu de départ neutre, aucune fiche</small>
          </button>
        </li>
      </ul>
      {creating && <NewProject onCreated={onOpen} onCancel={() => onOpen()} />}
    </div>
  );
}

function NewProject({ onCreated, onCancel }: { onCreated: (slug: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [doctrine, setDoctrine] = useState('');
  const [ideas, setIdeas] = useState('');
  const [figmaUrl, setFigmaUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Donne un nom au projet.');
    setBusy(true);
    setError('');
    try {
      onCreated((await createProject({ name, doctrine, ideas, figmaUrl })).slug);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="new-project" onSubmit={submit} aria-label="Nouveau projet">
      <h2>Nouveau projet</h2>
      <label>
        Nom
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Atelier céramique" autoFocus />
      </label>
      <label>
        Doctrine du projet
        <textarea
          rows={4}
          value={doctrine}
          onChange={(e) => setDoctrine(e.target.value)}
          placeholder="À qui il s'adresse, ce qu'il doit faire ressentir, ce qu'il refuse."
        />
      </label>
      <label>
        Premières idées
        <textarea rows={3} value={ideas} onChange={(e) => setIdeas(e.target.value)} placeholder="Tons terre, typo à empattements, beaucoup d'air." />
      </label>
      <label>
        Fichier Figma cible (facultatif)
        <input value={figmaUrl} onChange={(e) => setFigmaUrl(e.target.value)} placeholder="https://www.figma.com/design/…" />
      </label>
      <p className="hint">
        Projets perso seulement : l'assistant envoie la doctrine et les images à OpenRouter. Rien d'Enov ni de BRiiK.
      </p>
      {error && <p className="add-error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          Annuler
        </button>
        <button type="submit" className="primary" disabled={busy}>
          Créer le projet
        </button>
      </div>
    </form>
  );
}
