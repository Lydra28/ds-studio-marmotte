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

// Écrans d'exemple : le DS appliqué à des interfaces crédibles, pour tout
// projet (avec ou sans site). Seulement des tokens sémantiques, comme la planche.
export const screens = [
  ['ds', 'Composants'],
  ['dashboard', 'Tableau de bord'],
  ['form', 'Formulaire'],
  ['article', 'Article'],
] as const;
export type Screen = (typeof screens)[number][0];
const isScreen = (v: string | null): v is Screen => screens.some(([id]) => id === v);
export const previewSrc = (screen: Screen) => (screen === 'ds' ? '/?preview=1' : `/?preview=1&screen=${screen}`);

// Choix du contenu d'un cadre : écrans d'exemple, et le site en direct s'il existe.
export function ScreenPicker({
  value,
  onChange,
  site = false,
  label = 'Écran de la preview',
}: {
  value: Screen | 'site';
  onChange: (value: Screen | 'site') => void;
  site?: boolean;
  label?: string;
}) {
  return (
    <select
      className="screen-pick"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as Screen | 'site')}
    >
      {site && <option value="site">Site en direct</option>}
      {screens.map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </select>
  );
}

function DemoTop({ current }: { current: string }) {
  return (
    <header className="ds-top">
      <strong>Projet</strong>
      <nav aria-label="Navigation de démonstration">
        {['Accueil', 'Suivi', 'Profil'].map((n) => (
          <a key={n} href={`#${n.toLowerCase()}`} aria-current={n === current ? 'page' : undefined}>
            {n}
          </a>
        ))}
      </nav>
    </header>
  );
}

const activity = [
  ['Palette mise à jour', 'Il y a 2 h', 'ok', 'Validé'],
  ['Contraste du bouton secondaire', 'Hier', 'alert', 'À revoir'],
  ['Nouvelle typo de titre', 'Lundi', 'ok', 'Validé'],
  ['Espacements mobiles', 'La semaine dernière', 'wait', 'En cours'],
] as const;

function DashboardScreen({ set }: { set: TokenSet }) {
  return (
    <DSScope set={set} className="ds-screen">
      <DemoTop current="Accueil" />
      <main>
        <div className="ds-head">
          <div className="ds-intro">
            <p className="ds-kicker">Tableau de bord</p>
            <h1>Bonjour Camille</h1>
          </div>
          <Button>Nouvelle tâche</Button>
        </div>
        <div className="ds-stats">
          {[
            ['Projets actifs', '12', '+2 ce mois-ci'],
            ['Tâches en retard', '3', 'Dont 1 urgente'],
            ['Satisfaction', '94 %', 'Sur 128 avis'],
          ].map(([label, value, note]) => (
            <article key={label} className="ds-card ds-stat">
              <p className="ds-kicker">{label}</p>
              <strong>{value}</strong>
              <p className="ds-text">{note}</p>
            </article>
          ))}
        </div>
        <section className="ds-card ds-list" aria-label="Activité récente">
          <div className="ds-head">
            <h3>Activité récente</h3>
            <Button variant="ghost">Tout voir</Button>
          </div>
          <ul>
            {activity.map(([title, when, tone, status]) => (
              <li key={title}>
                <span>
                  <strong>{title}</strong>
                  <small>{when}</small>
                </span>
                <span className={`ds-badge ${tone}`}>{status}</span>
              </li>
            ))}
          </ul>
        </section>
        <div className="ds-banner">
          <p>
            <strong>Une alerte demande ton attention.</strong> Le contraste du bouton secondaire est sous 4,5:1.
          </p>
          <Button variant="secondary">Corriger</Button>
        </div>
      </main>
    </DSScope>
  );
}

function FormScreen({ set }: { set: TokenSet }) {
  const [plan, setPlan] = useState('pro');
  const [sent, setSent] = useState(false);
  return (
    <DSScope set={set} className="ds-screen">
      <DemoTop current="Profil" />
      <main>
        <div className="ds-intro">
          <p className="ds-kicker">Inscription · étape 2 sur 3</p>
          <h1>Ton espace</h1>
          <p className="ds-lead">Quelques informations pour préparer ton compte.</p>
        </div>
        <div className="ds-progress" aria-hidden="true">
          <span className="done" />
          <span className="done" />
          <span />
        </div>
        <form
          className="ds-form ds-form--wide"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <div className="ds-fields">
            <Input label="Prénom" placeholder="Camille" />
            <Input label="Nom" placeholder="Martin" />
          </div>
          <Input label="Adresse e-mail" type="email" placeholder="camille@" error="Ajoute une adresse complète." />
          <fieldset className="ds-choices">
            <legend>Formule</legend>
            {[
              ['solo', 'Solo', 'Un projet, gratuit'],
              ['pro', 'Pro', 'Projets illimités'],
              ['team', 'Équipe', 'Jusqu’à 10 personnes'],
            ].map(([id, name, detail]) => (
              <label key={id} className={plan === id ? 'is-selected' : ''}>
                <input type="radio" name="plan" value={id} checked={plan === id} onChange={() => setPlan(id)} />
                <strong>{name}</strong>
                <small>{detail}</small>
              </label>
            ))}
          </fieldset>
          <label className="ds-check">
            <input type="checkbox" defaultChecked /> Recevoir les nouveautés une fois par mois
          </label>
          <div className="ds-row">
            <Button variant="secondary">Retour</Button>
            <Button>{sent ? 'Enregistré ✓' : 'Continuer'}</Button>
          </div>
        </form>
      </main>
    </DSScope>
  );
}

function ArticleScreen({ set }: { set: TokenSet }) {
  return (
    <DSScope set={set} className="ds-screen">
      <DemoTop current="Suivi" />
      <main className="ds-article">
        <p className="ds-kicker">Journal · 6 min de lecture</p>
        <h1>Construire un design system qui dure</h1>
        <p className="ds-lead">
          Deux couches de tokens, des règles vérifiées à chaque essai, et des versions qu’on peut comparer.
        </p>
        <div className="ds-cover" aria-hidden="true" />
        <p>
          Les primitives décrivent ce qui existe : une gamme de couleurs, une échelle d’espacements. Les tokens
          sémantiques disent à quoi elles servent : le fond d’une carte, le texte d’un bouton.
        </p>
        <h3>Nommer par l’usage</h3>
        <p>Un token nommé par l’usage survit à un changement de marque. On change la valeur, pas les écrans.</p>
        <blockquote>« Le DS n’est pas une palette, c’est un ensemble de décisions. »</blockquote>
        <p>
          Chaque version acceptée devient une référence : on la transfère dans Figma, et le code la reçoit par une
          pull request.
        </p>
        <aside className="ds-cta">
          <div>
            <strong>Prêt à essayer ?</strong>
            <p>Change une couleur dans l’atelier et regarde cette page suivre.</p>
          </div>
          <Button variant="secondary">Commencer</Button>
        </aside>
      </main>
    </DSScope>
  );
}

const screenOf: Record<Screen, (props: { set: TokenSet }) => ReactNode> = {
  ds: PreviewScreen,
  dashboard: DashboardScreen,
  form: FormScreen,
  article: ArticleScreen,
};

// Page chargée dans l'iframe : elle reçoit le jeu de tokens (brouillon
// compris) par postMessage, même origine uniquement.
export function PreviewPage() {
  const [set, setSet] = useState<TokenSet>();
  useEffect(() => {
    // Défilement lié (comparaison côte à côte), même protocole que le site en direct.
    let quiet = 0;
    const room = () => Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin) return;
      if (e.data?.type === 'ds-set') {
        setSet(e.data.set);
        loadFonts(fontFamilies(e.data.set));
      }
      if (e.data?.type === 'ds-scroll-to') {
        quiet = Date.now() + 200;
        window.scrollTo(0, Math.min(1, Math.max(0, Number(e.data.y) || 0)) * room());
      }
    };
    const onScroll = () => {
      if (Date.now() > quiet) window.parent.postMessage({ type: 'ds-scroll', y: window.scrollY / room() }, location.origin);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.parent.postMessage({ type: 'ds-ready' }, location.origin);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  const param = new URLSearchParams(location.search).get('screen');
  const Shown = screenOf[isScreen(param) ? param : 'ds'];
  return set ? <Shown set={set} /> : <p>Chargement de l’aperçu…</p>;
}
