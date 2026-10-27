import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { fontFamilies, loadFonts } from './fonts.js';
import {
  cssName,
  cssValue,
  resolve,
  tokenCss,
  type TokenSet,
} from '../shared/model.js';

// Composants partagés du DS : ils ne lisent que des variables CSS issues des
// tokens sémantiques. Le chrome de l'atelier n'en dépend pas.
export function DSScope({
  set,
  children,
  className = '',
}: {
  set: TokenSet;
  children: ReactNode;
  className?: string;
}) {
  // Typographie : mode desktop par défaut, mode mobile sous 768 px.
  const [first, ...others] = set.modes.typography;
  const mobile = others.length
    ? Object.entries(set.tokens)
        .filter(([, t]) => t.$collection === 'typography')
        .map(
          ([key, t]) =>
            `${cssName(key)}:${cssValue(t.$type, resolve(set, key, { typography: others[0] }))};`,
        )
        .join('')
    : '';
  return (
    <div
      className={`ds ${className}`}
      style={tokenCss(set, { typography: first }) as CSSProperties}
    >
      {mobile && (
        <style>{`@media (max-width: 767px){.ds{${mobile}}}`}</style>
      )}
      {children}
    </div>
  );
}

export function Button({
  variant = 'primary',
  state,
  disabled = false,
  children,
  onClick,
}: {
  variant?: 'primary' | 'secondary' | 'ghost';
  state?: 'hover' | 'focus';
  disabled?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className={`ds-button ${variant} ${state ? `is-${state}` : ''}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Input({
  label,
  placeholder,
  error,
  disabled = false,
  type = 'text',
}: {
  label: string;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  type?: string;
}) {
  const id = `input-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div className={`ds-field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p className="ds-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({
  kicker,
  title,
  children,
  action,
}: {
  kicker: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="ds-card">
      <p className="ds-kicker">{kicker}</p>
      <h3>{title}</h3>
      <p className="ds-text">{children}</p>
      {action}
    </article>
  );
}

// Écran générique de la preview : textes, actions, cartes, saisie.
export function PreviewScreen({ set }: { set: TokenSet }) {
  const [sent, setSent] = useState(false);
  return (
    <DSScope set={set} className="ds-screen">
      <header className="ds-top">
        <strong>Projet</strong>
        <nav aria-label="Navigation de démonstration">
          <a href="#accueil" aria-current="page">
            Accueil
          </a>
          <a href="#suivi">Suivi</a>
          <a href="#profil">Profil</a>
        </nav>
      </header>
      <main>
        <p className="ds-kicker">Aperçu appliqué</p>
        <h1>Les tokens en situation.</h1>
        <p className="ds-lead">
          Chaque valeur essayée dans l’atelier s’applique ici avant d’être
          enregistrée.
        </p>
        <div className="ds-row">
          <Button>Action principale</Button>
          <Button variant="secondary">Secondaire</Button>
          <Button variant="ghost">Discrète</Button>
          <Button disabled>Indisponible</Button>
        </div>
        <div className="ds-grid">
          <Card
            kicker="Statut"
            title="Tout est sous contrôle"
            action={<Button variant="secondary">Voir le détail</Button>}
          >
            Une carte regroupe une information et son action.
          </Card>
          <Card
            kicker="Historique"
            title="Trois changements cette semaine"
            action={<Button variant="ghost">Ouvrir</Button>}
          >
            Le texte secondaire doit rester lisible sur la surface.
          </Card>
        </div>
        <form
          className="ds-form"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <Input label="Nom" placeholder="Camille" />
          <Input
            label="E-mail"
            type="email"
            placeholder="camille@"
            error="Ajoute une adresse complète pour recevoir les alertes."
          />
          <Input label="Champ désactivé" placeholder="Non disponible" disabled />
          <Button>{sent ? 'Enregistré ✓' : 'Enregistrer'}</Button>
        </form>
        <section className="ds-states" aria-label="États du bouton">
          <p className="ds-kicker">Button · State</p>
          <div className="ds-row">
            <Button>default</Button>
            <Button state="hover">hover</Button>
            <Button state="focus">focus</Button>
            <Button disabled>disabled</Button>
          </div>
        </section>
      </main>
    </DSScope>
  );
}

// Page chargée dans l'iframe : elle reçoit le jeu de tokens (brouillon
// compris) par postMessage, même origine uniquement.
export function PreviewPage() {
  const [set, setSet] = useState<TokenSet>();
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.data?.type !== 'ds-set') return;
      setSet(e.data.set);
      loadFonts(fontFamilies(e.data.set));
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ type: 'ds-ready' }, location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return set ? <PreviewScreen set={set} /> : <p>Chargement de l’aperçu…</p>;
}
