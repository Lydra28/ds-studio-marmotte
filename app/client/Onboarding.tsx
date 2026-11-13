import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createProject, getGithub, githubAction, type AccountStatus, type GithubRepo, type GithubStatus } from './api.js';
import { accountChanged, ACCOUNT_HASH, Avatar, FigmaMark, GithubMark, GlassBadge, rememberStart, useAccount } from './Chrome.js';
import { LOGO } from './Mascot.js';
import { AccountSection } from './Settings.js';

// Pop-in d'accueil (cadrage navigation et UX du 2026-11-14) : trois étapes,
// Compte DS-Studio, GitHub, Figma, chacune avec son motion ; trois points,
// Retour / Suivant, tout passable. Ouverte au premier lancement (aucun compte
// et pop-in jamais fermée), rouvrable depuis la page Compte (`#/bienvenue`).
// Mouvement en CSS (`steps()` pour l'effet pixel), coupé si l'utilisateur
// réduit les animations : chaque motion montre alors son état final.

export type Step = 'account' | 'github' | 'figma';
const STEPS: { id: Step; label: string }[] = [
  { id: 'account', label: 'Compte DS-Studio' },
  { id: 'github', label: 'GitHub' },
  { id: 'figma', label: 'Figma' },
];

// « Pop-in passée » : gardée dans le navigateur de l'app (origine fixe de
// l'app installée). Stockage indisponible : on ne la réimpose pas.
const SEEN = 'ds-onboarding';
export function onboardingSeen() {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return true;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    /* Rien à garder : elle se rouvre depuis Compte. */
  }
}

export function Onboarding({
  start,
  plugin,
  onClose,
  onProject,
}: {
  start: Step;
  // Code d'appairage du plugin (bootstrap), null si le plugin est fermé.
  plugin: string | null;
  onClose: () => void;
  onProject: (slug: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>(start);
  const [dir, setDir] = useState<'next' | 'back'>('next');
  const account = useAccount();
  // Ouverte : le focus va à « Suivant » (pas à la croix, premier élément).
  useEffect(() => {
    dialog.current?.showModal();
    next.current?.focus();
  }, []);
  // Étape changée : le panneau est remonté, le focus va à son titre (annoncé).
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    panel.current?.querySelector<HTMLElement>('#onb-title')?.focus();
  }, [step]);
  const i = STEPS.findIndex((s) => s.id === step);
  const go = (j: number) => {
    if (j < 0 || j >= STEPS.length) return;
    moved.current = true;
    setDir(j < i ? 'back' : 'next');
    setStep(STEPS[j].id);
  };
  // Une seule fermeture, quel que soit le chemin (croix, Échap, fermeture
  // forcée du dialog par le navigateur, fin).
  const closed = useRef(false);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    markSeen();
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="onboarding"
      aria-labelledby="onb-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={close}
    >
      <button className="icon-btn onb-close" onClick={close} aria-label="Fermer la présentation" title="Fermer">
        <svg width="12" height="12" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
          <path fill="currentColor" d="M1 1h2v2H1z M3 3h2v2H3z M5 5h2v2H5z M7 7h2v2H7z M9 9h2v2H9z M9 1h2v2H9z M7 3h2v2H7z M3 7h2v2H3z M1 9h2v2H1z" />
        </svg>
      </button>
      <div className={`onb-panel onb-panel--${dir}`} key={step} ref={panel}>
        <div className="onb-stage" aria-hidden="true">
          {step === 'account' && <LogoMotion />}
          {step === 'github' && <GithubMotion />}
          {step === 'figma' && <FigmaMotion />}
        </div>
        <div className="onb-body">
          {step === 'account' && <AccountStep account={account} />}
          {step === 'github' && <GithubStep account={account} onProject={(slug) => (markSeen(), onProject(slug))} onAccount={close} />}
          {step === 'figma' && <FigmaStep plugin={plugin} />}
        </div>
      </div>
      <div className="onb-foot">
        <button onClick={() => go(i - 1)} disabled={i === 0}>
          Retour
        </button>
        <div className="onb-dots" role="group" aria-label="Étapes de la présentation">
          {STEPS.map((s, j) => (
            <button
              key={s.id}
              className="onb-dot"
              aria-label={`Étape ${j + 1} sur 3 : ${s.label}`}
              aria-current={j === i ? 'step' : undefined}
              onClick={() => go(j)}
            />
          ))}
        </div>
        {i < STEPS.length - 1 ? (
          <button className="onb-next" ref={next} onClick={() => go(i + 1)}>
            Suivant
          </button>
        ) : (
          <button className="primary" ref={next} onClick={close}>
            C’est parti
          </button>
        )}
      </div>
    </dialog>
  );
}

// Étape 1 : le compte. Connecté : qui ; sinon le formulaire de la page Compte.
function AccountStep({ account }: { account: AccountStatus | undefined }) {
  const connected = account?.status === 'connected';
  return (
    <>
      <h2 id="onb-title" tabIndex={-1}>Ton compte DS-Studio</h2>
      <p className="onb-lead">Il active l’assistant et le Mur des DA. Tes projets restent sur cet ordinateur.</p>
      {connected ? (
        <div className="onb-done" role="status">
          <Avatar account={account} />
          <span>
            Connecté : <strong className="mono">{account.email}</strong>
          </span>
          {account.tier === 'pro' && <GlassBadge>Pro</GlassBadge>}
        </div>
      ) : account ? (
        <AccountSection account={account} onChange={() => accountChanged()} compact />
      ) : (
        <p className="hint">Chargement…</p>
      )}
    </>
  );
}

// Étape 2 : GitHub. Bouton aux couleurs de GitHub qui lance la connexion de
// l'app (code à saisir sur github.com, affiché ici), puis le choix du dépôt,
// qui crée un projet depuis ce dépôt (même flux que « Nouveau projet »).
const openUrl = (url: string) => window.open(url, '_blank', 'noopener');
function GithubStep({
  account,
  onProject,
  onAccount,
}: {
  account: AccountStatus | undefined;
  onProject: (slug: string) => void;
  onAccount: () => void;
}) {
  const [gh, setGh] = useState<GithubStatus>();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connected = account?.status === 'connected';
  const tier = account?.tier;
  // Réponses dans le désordre (sondage, annulation) : seule la dernière compte.
  const seq = useRef(0);
  const set = (g: GithubStatus) => {
    seq.current++;
    setGh(g);
  };
  const load = () => {
    const n = ++seq.current;
    return getGithub()
      .then((g) => {
        if (n !== seq.current) return;
        setGh(g);
        setError('');
      })
      .catch((e) => n === seq.current && setError((e as Error).message));
  };
  useEffect(() => {
    if (connected) void load();
  }, [connected, tier]);
  const pending = gh?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending]);
  const linked = gh?.pro && gh.status === 'connected';
  const readRepos = () => {
    setRepos(null);
    githubAction('repos')
      .then((r) => {
        setRepos(r.repos ?? []);
        if (r.repos?.length) setRepo((cur) => cur || r.repos![0].fullName);
      })
      .catch((e) => {
        setRepos([]);
        setError((e as Error).message);
      });
  };
  // Lié : la barre et l'accueil se relisent, la liste des dépôts arrive.
  useEffect(() => {
    if (!linked) return;
    accountChanged();
    readRepos();
  }, [linked]);
  const cancel = () => {
    setError('');
    githubAction('cancel')
      .then((r) => set(r.github))
      .catch((e) => setError((e as Error).message));
  };
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await githubAction('start');
      set(r.github);
      if (r.github.verificationUri) openUrl(r.github.verificationUri);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const chosen = repos?.find((r) => r.fullName === repo);
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      const { slug } = await createProject({
        name: chosen.fullName.split('/')[1] ?? chosen.fullName,
        doctrine: '',
        ideas: '',
        figmaUrl: '',
        siteUrl: '',
        repo: chosen.fullName,
        base: chosen.defaultBranch,
        subdir: '',
      });
      rememberStart(slug, { repo: true });
      onProject(slug);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <h2 id="onb-title" tabIndex={-1}>Ton dépôt GitHub</h2>
      <p className="onb-lead">
        DS-Studio lit le design system de ton dépôt, tu le modifies ici, et chaque version acceptée part en pull request sur une
        branche. Tu merges toi-même.
      </p>
      {!connected ? (
        <p className="hint">Connecte d’abord ton compte DS-Studio (étape précédente).</p>
      ) : !gh ? (
        error ? (
          <div className="form-actions">
            <button onClick={() => void load()}>Réessayer</button>
          </div>
        ) : (
          <p className="hint">Chargement…</p>
        )
      ) : !gh.pro ? (
        <div className="onb-action">
          <button className="github-btn" disabled>
            <GithubMark size={18} />
            Continuer avec GitHub
          </button>
          <p className="onb-pro">
            <GlassBadge>Pro</GlassBadge>
            <span>
              GitHub fait partie de DS-Studio Pro.{' '}
              <a href={ACCOUNT_HASH} onClick={onAccount}>
                Voir sur ta page Compte
              </a>
            </span>
          </p>
        </div>
      ) : gh.status === 'pending' ? (
        <div className="onb-action">
          {gh.userCode ? (
            <>
              <p>
                Saisis ce code sur <span className="mono">{gh.verificationUri}</span> :
              </p>
              <p className="mono github-user-code" aria-label="Code GitHub">
                {gh.userCode}
              </p>
            </>
          ) : (
            <p className="hint">Connexion GitHub en attente…</p>
          )}
          <div className="form-actions">
            {gh.verificationUri && <button onClick={() => openUrl(gh.verificationUri!)}>Ouvrir GitHub</button>}
            <button disabled={busy} onClick={cancel}>
              Annuler
            </button>
          </div>
        </div>
      ) : linked ? (
        <div className="onb-action">
          <div className="onb-done" role="status">
            <GithubMark size={18} />
            <span>
              Connecté en tant que <strong className="mono">{gh.login}</strong>
            </span>
          </div>
          {repos === null ? (
            <p className="hint">Lecture de tes dépôts…</p>
          ) : repos.length ? (
            <div className="onb-repo">
              <label>
                Dépôt à ouvrir
                <select
                  value={repo}
                  onChange={(e) => {
                    setRepo(e.target.value);
                    setError('');
                  }}
                >
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.private ? ' (privé)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={busy || !repo} onClick={() => void create()}>
                Créer le projet depuis ce dépôt
              </button>
            </div>
          ) : (
            <div className="form-actions">
              <p className="hint">Aucun dépôt accessible : ajoute DS-Studio à un dépôt sur GitHub.</p>
              <button onClick={() => openUrl(gh.installUrl)}>Ajouter un dépôt</button>
              <button onClick={readRepos}>Relire mes dépôts</button>
            </div>
          )}
        </div>
      ) : (
        <div className="onb-action">
          <button className="github-btn" disabled={busy} onClick={() => void start()}>
            <GithubMark size={18} />
            Continuer avec GitHub
          </button>
          <p className="hint">Un code s’affiche ici, à saisir sur github.com. Puis tu choisis les dépôts que DS-Studio peut lire.</p>
        </div>
      )}
      {gh?.message && (
        <p className="message error" role="alert">
          {gh.message}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

// Étape 3 : Figma. Toute l'installation, plugin en revue Community.
function FigmaStep({ plugin }: { plugin: string | null }) {
  return (
    <>
      <h2 id="onb-title" className="with-mark" tabIndex={-1}>
        Le plugin Figma
        <GlassBadge>Bientôt disponible</GlassBadge>
      </h2>
      <p className="onb-lead">
        Il envoie la version acceptée dans ton fichier Figma (variables et styles) et renvoie tes composants ici, à relire par
        diff.
      </p>
      <ol className="onb-list">
        <li>
          Dans Figma : Plugins, rechercher « DS-Studio » dans la Community (en cours de validation par Figma), puis l’ajouter.
        </li>
        <li>
          Ouvre ton fichier, lance DS-Studio et colle le code d’appairage :{' '}
          {plugin ? <code className="pair">{plugin}</code> : 'il s’affiche dans le bouton Figma de chaque projet'}.
        </li>
        <li>« Transférer » écrit la dernière version acceptée ; « Envoyer les composants » les renvoie ici.</li>
      </ol>
    </>
  );
}

// Motion Compte : le logo apparaît pixel par pixel, dans l'ordre d'une trame
// de Bayer 4 × 4 (fondu 1-bit), puis cligne.
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const INK: Record<string, string> = { '#': '#0b0b0c', Y: 'var(--c-accent)', W: '#f2f1ec', b: '#0b0b0c' };
function LogoMotion() {
  return (
    <svg className="onb-logo" viewBox="0 0 16 16" shapeRendering="crispEdges">
      {LOGO.body.flatMap((row, y) =>
        [...row].map((c, x) =>
          c === '.' ? null : (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill={INK[c]}
              style={{ '--d': `${BAYER[y % 4][x % 4] * 55 + (x + y) * 6}ms` } as CSSProperties}
            />
          ),
        ),
      )}
      <g className="onb-logo__eyes">
        {LOGO.eyes.map(([x, y, w, h]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} fill="#0b0b0c" />
        ))}
      </g>
      <g className="onb-logo__mouth">
        {LOGO.mouth.map(([x, y, w, h]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} fill="#0b0b0c" />
        ))}
      </g>
    </svg>
  );
}

// Motion GitHub : un curseur pixel va cliquer le bouton GitHub, une coche lime
// confirme. En boucle.
const CURSOR = 'M0 0h1v1H0z M0 1h2v1H0z M0 2h3v1H0z M0 3h4v1H0z M0 4h5v1H0z M0 5h6v1H0z M0 6h3v1H0z M3 6h1v2H3z M0 7h1v1H0z M4 7h1v2H4z';
function GithubMotion() {
  return (
    <svg className="onb-gh" viewBox="0 0 120 70" shapeRendering="crispEdges">
      <rect x="6" y="6" width="108" height="58" rx="3" className="onb-gh__win" />
      <rect x="6" y="6" width="108" height="8" className="onb-gh__bar" />
      <g className="onb-gh__btn">
        <rect x="28" y="28" width="64" height="16" rx="2" fill="#24292f" stroke="rgb(255 255 255 / 0.2)" strokeWidth="0.5" />
        <g transform="translate(34 32) scale(0.5)">
          <GithubMarkPath />
        </g>
        <rect x="46" y="34" width="38" height="4" fill="#f2f1ec" opacity="0.85" />
      </g>
      <g className="onb-gh__check">
        <rect x="96" y="22" width="12" height="12" fill="var(--c-accent)" />
        <path d="M98 28h2v2h-2z M100 30h2v2h-2z M102 28h2v2h-2z M104 26h2v2h-2z" fill="#0b0b0c" />
      </g>
      <g className="onb-gh__cursor">
        <path d={CURSOR} transform="scale(1.6)" fill="#f2f1ec" stroke="#0b0b0c" strokeWidth="0.4" />
      </g>
    </svg>
  );
}
const GithubMarkPath = () => (
  <path
    fill="#f2f1ec"
    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
  />
);

// Motion Figma : trois tokens partent de l'atelier et se rangent dans le
// fichier Figma, en sauts de pixel.
const CHIPS = ['var(--c-accent)', '#2e6bff', '#ff6a1f'];
function FigmaMotion() {
  return (
    <svg className="onb-fig" viewBox="0 0 120 70" shapeRendering="crispEdges">
      <rect x="6" y="12" width="34" height="46" rx="3" className="onb-gh__win" />
      <rect x="80" y="12" width="34" height="46" rx="3" className="onb-gh__win" />
      <g transform="translate(91 17) scale(0.21)">
        <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
        <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
        <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
        <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
        <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
      </g>
      {CHIPS.map((fill, k) => (
        <g key={k}>
          <rect x="12" y={22 + k * 11} width="22" height="6" rx="1" className="onb-fig__slot" />
          <rect
            x="12"
            y={22 + k * 11}
            width="8"
            height="6"
            fill={fill}
            className="onb-fig__chip"
            style={{ '--k': k } as CSSProperties}
          />
          <rect x="86" y={33 + k * 7} width="22" height="4" className="onb-fig__row" style={{ '--k': k } as CSSProperties} />
        </g>
      ))}
    </svg>
  );
}
