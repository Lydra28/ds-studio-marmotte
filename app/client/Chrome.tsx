import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getAccount, getGithub, type AccountStatus, type GithubStatus } from './api.js';

// Habillage commun (cadrage navigation et UX du 2026-11-14) : logos GitHub et
// Figma en couleur, icônes pixel (engrenage, profil, « ⋯ »), bouton Compte
// avec badge Pro en verre, menu des actions rangées. SVG en ligne : aucun
// appel externe, CSP inchangée.

// Logo GitHub (marque officielle, une couleur : celle du texte).
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

// Logo Figma, ses cinq couleurs.
export function FigmaMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="mark" width={(size * 38) / 57} height={size} viewBox="0 0 38 57" aria-hidden="true" focusable="false">
      <path fill="#1ABCFE" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
      <path fill="#0ACF83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
      <path fill="#FF7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
      <path fill="#F24E1E" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
      <path fill="#A259FF" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
    </svg>
  );
}

// Icônes pixel sur une grille de 12 : un trait = un pixel.
function Pixel({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg className="pixel-icon" width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={d} />
    </svg>
  );
}
// Engrenage : corps carré percé (trou en sens inverse), huit dents.
const GEAR =
  'M3 3h6v6H3z M5 5v2h2V5z M5 1h2v2H5z M5 9h2v2H5z M1 5h2v2H1z M9 5h2v2H9z M2 2h2v2H2z M8 2h2v2H8z M2 8h2v2H2z M8 8h2v2H8z';
const USER = 'M4 1h4v1h1v3H8v1H4V5H3V2h1z M2 8h8v1h1v2H1V9h1z';
const MORE = 'M1 5h2v2H1z M5 5h2v2H5z M9 5h2v2H9z';
export const GearIcon = () => <Pixel d={GEAR} />;
export const UserIcon = ({ size }: { size?: number }) => <Pixel d={USER} size={size} />;
export const MoreIcon = () => <Pixel d={MORE} />;

// Badge en verre (« Pro », « Bientôt disponible ») : il signale, il ne pousse pas.
export function GlassBadge({ children }: { children: ReactNode }) {
  return <span className="glass-badge">{children}</span>;
}

// Compte relu au montage, au retour sur la fenêtre et après chaque changement
// annoncé par `accountChanged()` (connexion, achat, déconnexion).
const EVENT = 'ds-account';
export const accountChanged = () => window.dispatchEvent(new Event(EVENT));
export function useAccount() {
  const [account, setAccount] = useState<AccountStatus>();
  useEffect(() => {
    let live = true;
    const load = () =>
      getAccount()
        .then((a) => live && setAccount(a))
        .catch(() => {
          /* Hors ligne : le bouton reste neutre. */
        });
    void load();
    window.addEventListener(EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener(EVENT, load);
      window.removeEventListener('focus', load);
    };
  }, []);
  return account;
}

// État GitHub relu au montage, au retour sur la fenêtre et après `accountChanged()`.
export function useGithub() {
  const [github, setGithub] = useState<GithubStatus>();
  useEffect(() => {
    let live = true;
    const load = () =>
      getGithub()
        .then((g) => live && setGithub(g))
        .catch(() => {
          /* Hors ligne : l'état d'avant reste. */
        });
    void load();
    window.addEventListener(EVENT, load);
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener(EVENT, load);
      window.removeEventListener('focus', load);
    };
  }, []);
  return github;
}

export const ACCOUNT_HASH = '#/compte';
export const SETTINGS_HASH = '#/reglages';
export const openAccount = () => {
  location.hash = ACCOUNT_HASH.slice(1);
};
export const openSettings = () => {
  location.hash = SETTINGS_HASH.slice(1);
};

// Avatar : initiale de l'adresse en police pixel, silhouette sans compte.
export function Avatar({ account, large = false }: { account: AccountStatus | undefined; large?: boolean }) {
  const email = account?.status === 'connected' ? account.email : null;
  return (
    <span className={`avatar${large ? ' avatar--large' : ''}${account?.tier === 'pro' && email ? ' is-pro' : ''}`} aria-hidden="true">
      {email ? email[0].toUpperCase() : <UserIcon size={large ? 28 : 16} />}
    </span>
  );
}

// Engrenage puis profil : en haut à droite de chaque écran.
export function AppLinks() {
  const account = useAccount();
  const connected = account?.status === 'connected';
  const pro = connected && account.tier === 'pro';
  return (
    <div className="app-links">
      <button className="icon-btn" onClick={openSettings} aria-label="Réglages" title="Réglages">
        <GearIcon />
      </button>
      <button
        className="icon-btn account-btn"
        onClick={openAccount}
        aria-label="Compte"
        title={connected ? `${account.email}${pro ? ' · Pro' : ''}` : 'Se connecter'}
      >
        <Avatar account={account} />
        {pro && <GlassBadge>Pro</GlassBadge>}
      </button>
    </div>
  );
}

// Menu des actions rangées : s'ouvre au clic, se ferme au clic dehors, à
// Échap ou après une action.
export function MoreMenu({ items }: { items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="more" ref={root}>
      <button
        className="icon-btn"
        aria-label="Plus d’actions"
        title="Plus d’actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="more-menu" role="menu" aria-label="Plus d’actions">
          {items.map((it, i) => (
            <button
              key={it.label}
              autoFocus={i === 0}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
