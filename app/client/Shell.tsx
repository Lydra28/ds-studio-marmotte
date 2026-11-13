import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createProject, getGithub, githubAction, listProjects, type GithubRepo, type ProjectSummary } from './api.js';
import { ACCOUNT_HASH, AppLinks, GithubMark, GlassBadge, rememberStart, SETTINGS_HASH, useAccount, useGithub, WELCOME_HASH } from './Chrome.js';
import { Onboarding, onboardingSeen, type Step } from './Onboarding.js';

// Route dans le hash : `#/p/<projet>` ouvre un projet, `#/reglages` les
// réglages de l'application, `#/compte` le compte, sinon l'accueil.
const slugOf = (hash: string) => /^#\/p\/([a-z0-9-]+)$/.exec(hash)?.[1];
export type Page = 'settings' | 'account' | null;
export function useRoute(): [string | undefined, (slug?: string) => void, Page] {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (slug?: string) => {
    location.hash = slug ? `/p/${slug}` : slug === undefined ? '/' : '/nouveau';
  };
  return [slugOf(hash), go, hash === SETTINGS_HASH ? 'settings' : hash === ACCOUNT_HASH ? 'account' : null];
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

export type View = 'wall' | 'board' | 'versions';
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
  versions,
  onVersion,
  boardBadge,
  children,
}: {
  current: string;
  name: string;
  revision: number;
  multi: boolean;
  onOpen: (slug?: string) => void;
  view: View;
  onView: (view: View) => void;
  // Révisions des versions acceptées : une marche de « chaleur » chacune.
  versions: number[];
  onVersion: (revision: number) => void;
  // Écarts du projet, en badge sur l'onglet Design system (plus de pastille à part).
  boardBadge?: ReactNode;
  children: ReactNode;
}) {
  const { projects } = useProjects();
  const steps: [View, string][] = [
    ['wall', 'Mur des DA'],
    ['board', 'Design system'],
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
              {v === 'board' && boardBadge}
            </li>
          ))}
        </ol>
        {versions.length > 0 && <Stairs versions={versions} onVersion={onVersion} />}
      </nav>
      <div className="actions">
        {children}
        <AppLinks />
      </div>
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

// Création : `#/nouveau` (formulaire complet) ou `#/nouveau/depot` (depuis
// un dépôt GitHub, bouton GitHub de l'accueil).
const NEW_REPO_HASH = '#/nouveau/depot';
const creatingOf = (hash: string) => (hash === '#/nouveau' ? 'blank' : hash === NEW_REPO_HASH ? 'repo' : null);

export function Home({ onOpen, plugin }: { onOpen: (slug?: string) => void; plugin: string | null }) {
  const { projects, error } = useProjects();
  const account = useAccount();
  const github = useGithub();
  const [creating, setCreating] = useState(() => creatingOf(location.hash));
  // Pop-in d'accueil : rouverte par `#/bienvenue` (page Compte), ouverte d'office
  // au premier lancement, ou à l'étape GitHub par le bouton GitHub.
  const [welcome, setWelcome] = useState<Step | null>(() => (location.hash === WELCOME_HASH ? 'account' : null));
  useEffect(() => {
    const on = () => {
      setCreating(creatingOf(location.hash));
      if (location.hash === WELCOME_HASH) setWelcome('account');
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const status = account?.status;
  useEffect(() => {
    if (status === 'none' && !onboardingSeen()) setWelcome((w) => w ?? 'account');
  }, [status]);
  const closeWelcome = () => {
    setWelcome(null);
    if (location.hash === WELCOME_HASH) location.replace('#/');
  };
  const linked = !!github?.pro && github.status === 'connected';
  // Le plus récemment modifié d'abord : c'est celui qu'on rouvre.
  const sorted = projects && [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="home">
      <div className="home-top">
        <AppLinks />
      </div>
      <header className="home-hero">
        <div>
          <p className="home-kicker">Atelier de design system</p>
          <h1>DS-Studio</h1>
          <p className="home-lead">Un atelier par projet : essais en direct, règles, versions, transfert Figma.</p>
        </div>
        {github && (
          <div className="home-github">
            <button
              className="github-btn"
              onClick={() => (linked ? (location.hash = NEW_REPO_HASH.slice(1)) : setWelcome('github'))}
            >
              <GithubMark size={18} />
              {linked ? 'Nouveau projet depuis un dépôt' : 'Connecter GitHub'}
              {!github.pro && <GlassBadge>Pro</GlassBadge>}
            </button>
            <p className={`home-github-state${linked ? ' is-on' : ''}`}>
              {linked ? (
                <>
                  Connecté en tant que <strong className="mono">{github.login}</strong>
                </>
              ) : github.status === 'pending' ? (
                'Connexion GitHub en attente…'
              ) : (
                'GitHub non connecté'
              )}
            </p>
          </div>
        )}
      </header>
      <div className="home-section-head">
        <h2>Projets</h2>
        {sorted && <span className="count">{sorted.length}</span>}
      </div>
      {error && <p className="message error" role="alert">{error}</p>}
      {!sorted && !error && <p className="home-loading">Chargement des projets…</p>}
      <ul className="project-grid" aria-label="Projets">
        {sorted?.map((p) => (
          <li key={p.slug}>
            <button className="project-card" onClick={() => onOpen(p.slug)}>
              <Cover cover={p.cover} />
              <span className="project-card__body">
                <strong>{p.name}</strong>
                <span className="mono">
                  r{p.revision}
                  {p.accepted !== null ? ` · v${p.accepted} acceptée` : ' · aucune version'}
                </span>
                <small>{p.updatedAt ? `Modifié le ${new Date(p.updatedAt).toLocaleDateString('fr-FR')}` : 'Jamais modifié'}</small>
                {p.versions > 0 && (
                  <span className="card-stairs" aria-hidden="true">
                    {Array.from({ length: Math.min(5, p.versions) }, (_, i) => (
                      <i key={i} style={{ height: 4 + 4 * (i + 1), background: `var(--c-heat-${i + 1})` }} />
                    ))}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
        <li>
          <button className="project-card new" onClick={() => onOpen('')}>
            <span className="cover cover--new" aria-hidden="true">
              +
            </span>
            <span className="project-card__body">
              <strong>Nouveau projet</strong>
              <small>Jeu de départ neutre, l’assistant aide pour la DA</small>
            </span>
          </button>
        </li>
      </ul>
      {creating && <NewProject key={creating} fromRepo={creating === 'repo'} onCreated={onOpen} onCancel={() => onOpen()} />}
      {welcome && (
        <Onboarding
          start={welcome}
          plugin={plugin}
          onClose={closeWelcome}
          onProject={(slug) => {
            setWelcome(null);
            onOpen(slug);
          }}
        />
      )}
    </div>
  );
}

// Couverture : un échantillon du projet à ses propres couleurs et police.
function Cover({ cover }: { cover: ProjectSummary['cover'] }) {
  return (
    <span
      className="cover"
      aria-hidden="true"
      style={{
        background: cover.canvas ?? undefined,
        color: cover.text ?? undefined,
        fontFamily: cover.font ? `${cover.font}, system-ui, sans-serif` : undefined,
      }}
    >
      <span className="cover__sample">
        <span className="cover__aa">Aa</span>
        <span className="cover__card" style={{ background: cover.surface ?? undefined }}>
          <span className="cover__line" style={{ background: cover.text ?? undefined }} />
          <span className="cover__line short" style={{ background: cover.text ?? undefined }} />
          <span className="cover__button" style={{ background: cover.brand ?? undefined, color: cover.onBrand ?? undefined }}>
            Bouton
          </span>
        </span>
        {cover.accent && <span className="cover__dot" style={{ background: cover.accent }} />}
      </span>
      {cover.palette.length > 0 && (
        <span className="cover__palette">
          {cover.palette.map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </span>
      )}
    </span>
  );
}

function NewProject({
  fromRepo = false,
  onCreated,
  onCancel,
}: {
  // Depuis le bouton GitHub de l'accueil : le dépôt d'abord, le nom en découle.
  fromRepo?: boolean;
  onCreated: (slug: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [doctrine, setDoctrine] = useState('');
  const [ideas, setIdeas] = useState('');
  const [figmaUrl, setFigmaUrl] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  // Plan GitHub, G3 : dépôts proposés seulement si GitHub est connecté (Pro).
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [repo, setRepo] = useState('');
  const [subdir, setSubdir] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    getGithub()
      .then((g) => (g.pro && g.status === 'connected' ? githubAction('repos') : null))
      .then((r) => {
        if (live && r?.repos) {
          setRepos(r.repos);
          if (fromRepo && r.repos[0]) {
            setRepo(r.repos[0].fullName);
            setName((n) => n || (r.repos![0].fullName.split('/')[1] ?? ''));
          }
        }
      })
      .catch(() => {
        /* Facultatif : le formulaire reste sans dépôt. */
      });
    return () => {
      live = false;
    };
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Donne un nom au projet.');
    const site = siteUrl.trim();
    if (site) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(site);
      } catch {
        /* Message ci-dessous. */
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol))
        return setError('Adresse du site attendue : https://… (page publique).');
    }
    setBusy(true);
    setError('');
    try {
      const chosen = repos.find((r) => r.fullName === repo);
      const { slug } = await createProject({
        name,
        doctrine,
        ideas,
        figmaUrl,
        siteUrl: site,
        ...(chosen ? { repo: chosen.fullName, base: chosen.defaultBranch, subdir: subdir.trim() } : {}),
      });
      // Projet neuf : il s'ouvre sur le Mur des DA, première étape du parcours ;
      // depuis un site (lot 5) ou un dépôt (G3), sur la planche avec la lecture
      // lancée (le dépôt prime : ses tokens sont déclarés, ceux du site devinés).
      rememberStart(slug, { repo: !!chosen, site });
      onCreated(slug);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="new-project" onSubmit={submit} aria-label="Nouveau projet">
      <h2>{fromRepo ? 'Nouveau projet depuis un dépôt' : 'Nouveau projet'}</h2>
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
      <label>
        Adresse du site (facultatif)
        <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://exemple.fr" inputMode="url" />
      </label>
      <p className="hint">
        Avec une adresse, DS-Studio lit les styles de la page sur ton poste et propose un premier jeu de tokens, à valider par le
        diff. Jamais un site client ou d’Enov.
      </p>
      {repos.length > 0 && (
        <>
          <label>
            Dépôt GitHub (facultatif)
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">Aucun</option>
              {repos.map((r) => (
                <option key={r.fullName} value={r.fullName}>
                  {r.fullName}
                  {r.private ? ' (privé)' : ''}
                </option>
              ))}
            </select>
          </label>
          {repo && (
            <label>
              Sous-dossier du dépôt (facultatif, monorepo)
              <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="apps/web" />
            </label>
          )}
          <p className="hint">
            Avec un dépôt, DS-Studio lit ses tokens sur ton poste (rien n’est exécuté ni écrit dans le dépôt) et les propose en
            brouillon à la place du gabarit.
          </p>
        </>
      )}
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
