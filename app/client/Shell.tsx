import { useEffect, useState, type FormEvent } from 'react';
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

const sections = [
  ['h-colors', 'Primitives'],
  ['h-tokens', 'Tokens sémantiques'],
  ['h-type', 'Typographie'],
  ['h-scales', 'Échelles'],
  ['h-components', 'Composants'],
  ['h-names', 'Nomenclature'],
] as const;

export function Sidebar({
  current,
  multi,
  onOpen,
  onHistory,
  onWall,
  onSite,
  onCompare,
  onBoard,
  view,
}: {
  current: string;
  multi: boolean;
  onOpen: (slug?: string) => void;
  onHistory: () => void;
  onWall: () => void;
  // Absent : le projet n'a pas de site configuré (ou relais arrêté).
  onSite?: () => void;
  onCompare: () => void;
  onBoard: () => void;
  view: 'board' | 'wall' | 'site' | 'compare';
}) {
  const { projects } = useProjects();
  return (
    <nav className="sidebar" aria-label="Projets et sections">
      <button className="logo" onClick={() => multi && onOpen()} disabled={!multi}>
        DS-Studio
      </button>
      {multi && (
        <>
          <p className="side-label">Projets</p>
          <ul className="nav-list">
            {projects?.map((p) => (
              <li key={p.slug}>
                <button aria-current={p.slug === current ? 'page' : undefined} onClick={() => onOpen(p.slug)}>
                  {p.name}
                </button>
              </li>
            ))}
            <li>
              <button className="nav-new" onClick={() => onOpen('')}>
                + Nouveau projet
              </button>
            </li>
          </ul>
        </>
      )}
      <p className="side-label">Ce projet</p>
      <ul className="nav-list">
        <li>
          <button aria-current={view === 'wall' ? 'page' : undefined} onClick={onWall}>
            Mur des DA
          </button>
        </li>
        {onSite && (
          <li>
            <button aria-current={view === 'site' ? 'page' : undefined} onClick={onSite}>
              Site en direct
            </button>
          </li>
        )}
        <li>
          <button aria-current={view === 'compare' ? 'page' : undefined} onClick={onCompare}>
            Comparer
          </button>
        </li>
        {sections.map(([id, label]) => (
          <li key={id}>
            <button
              onClick={() => {
                onBoard();
                setTimeout(() => void document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
            >
              {label}
            </button>
          </li>
        ))}
        <li>
          <button onClick={onHistory}>Historique</button>
        </li>
      </ul>
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
