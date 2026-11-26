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

// Rang d'un bloc dans l'apparition en cascade (styles.css, .ds-rise).
const rank = (i: number) => ({ '--i': i }) as CSSProperties;

// Écran Composants de la preview : chaque composant du DS dans une mise en
// page de produit (parti pris « calme et précis », 2026-11-26).
export function PreviewScreen({ set }: { set: TokenSet }) {
  const [sent, setSent] = useState(false);
  const week = [38, 52, 46, 64, 58, 76, 88];
  return (
    <DSScope set={set} className="ds-screen">
      <DemoTop current="Accueil" />
      <main>
        <section className="ds-hero ds-rise" style={rank(0)}>
          <h1>Les tokens en situation.</h1>
          <p className="ds-lead">
            Chaque valeur essayée dans l’atelier s’applique ici avant d’être enregistrée.
          </p>
          <div className="ds-row">
            <Button>Action principale</Button>
            <Button variant="secondary">Secondaire</Button>
            <Button variant="ghost">Discrète</Button>
            <Button disabled>Indisponible</Button>
          </div>
        </section>
        <div className="ds-bento">
          <section className="ds-panel is-lift ds-rise" style={rank(1)} aria-labelledby="ds-progress">
            <div className="ds-panel-head">
              <h2 id="ds-progress">Avancement</h2>
              <span className="ds-trend">+12 % en 7 jours</span>
            </div>
            <p className="ds-figure">
              86<small> %</small>
            </p>
            <p className="ds-text">des composants documentés et vérifiés.</p>
            <div className="ds-bars" aria-hidden="true">
              {week.map((h, i) => (
                <span key={i} style={{ height: `${h}%`, ...rank(i) }} />
              ))}
            </div>
            <div className="ds-axis" aria-hidden="true">
              {['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
          </section>
          <section className="ds-panel ds-list is-lift ds-rise" style={rank(2)} aria-labelledby="ds-activity">
            <div className="ds-panel-head">
              <h2 id="ds-activity">Activité</h2>
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
          <form
            className="ds-panel ds-form ds-rise"
            style={rank(3)}
            aria-labelledby="ds-profile"
            onSubmit={(e) => {
              e.preventDefault();
              setSent(true);
            }}
          >
            <h2 id="ds-profile">Profil</h2>
            <Input label="Nom" placeholder="Camille" />
            <Input
              label="E-mail"
              type="email"
              placeholder="camille@"
              error="Ajouter une adresse complète pour recevoir les alertes."
            />
            <Input label="Champ désactivé" placeholder="Non disponible" disabled />
            <Button>{sent ? 'Enregistré' : 'Enregistrer'}</Button>
          </form>
          <section className="ds-panel ds-states ds-rise" style={rank(4)} aria-labelledby="ds-button-states">
            <h2 id="ds-button-states">États du bouton</h2>
            <div className="ds-row">
              <Button>default</Button>
              <Button state="hover">hover</Button>
              <Button state="focus">focus</Button>
              <Button disabled>disabled</Button>
            </div>
            <p className="ds-text">
              Survol, focus clavier et désactivé suivent les tokens de marque, de focus et d’interaction.
            </p>
            <h2>Statuts</h2>
            <div className="ds-row">
              <span className="ds-badge ok">Validé</span>
              <span className="ds-badge alert">À revoir</span>
              <span className="ds-badge">En cours</span>
              <span className="ds-trend">+12 %</span>
            </div>
          </section>
        </div>
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

// Tokens lus par les écrans d'exemple : noms du gabarit. Un projet lu dans un
// dépôt garde les noms de son code ; les écrans ne suivent alors pas ses tokens.
export const PREVIEW_KEYS = [
  'bg/canvas',
  'bg/surface',
  'bg/brand',
  'text/primary',
  'text/secondary',
  'border/default',
  'radius/control',
  'space/md',
  'font/size/body',
  'font/family/base',
];
// Plus de la moitié manque (un token retiré à la main ou un dépôt qui reprend
// une partie des noms du gabarit ne suffit pas).
export const previewUnfit = (set: TokenSet) =>
  PREVIEW_KEYS.filter((k) => !set.tokens[k]).length * 2 > PREVIEW_KEYS.length;

export function PreviewGap({ set, site = false }: { set: TokenSet; site?: boolean }) {
  if (!previewUnfit(set)) return null;
  return (
    <p className="hint preview-gap" role="note">
      Les écrans d’exemple lisent les noms du gabarit (<code>bg/brand</code>, <code>text/primary</code>…), absents de
      ce projet : ils ne suivent pas vos tokens. Vos tokens sont sur la planche.
      {site ? ' Votre site avec vos tokens : « Site en direct ».' : ''}
    </p>
  );
}

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
      <strong className="ds-brand">Projet</strong>
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
        <div className="ds-head ds-rise" style={rank(0)}>
          <div className="ds-intro">
            <h1>Bonjour Camille</h1>
            <p className="ds-lead">Trois tâches demandent votre attention aujourd’hui.</p>
          </div>
          <Button>Nouvelle tâche</Button>
        </div>
        <div className="ds-bento">
          <section className="ds-panel is-tall is-lift ds-rise" style={rank(1)} aria-labelledby="ds-active">
            <div className="ds-panel-head">
              <h2 id="ds-active">Projets actifs</h2>
              <span className="ds-trend">+2 ce mois-ci</span>
            </div>
            <p className="ds-figure">12</p>
            <p className="ds-text">Dont 4 livrés avant la date prévue.</p>
            <div className="ds-bars" aria-hidden="true">
              {[30, 44, 40, 58, 52, 70, 64, 82].map((h, i) => (
                <span key={i} style={{ height: `${h}%`, ...rank(i) }} />
              ))}
            </div>
          </section>
          {[
            ['Tâches en retard', '3', 'Dont 1 urgente'],
            ['Satisfaction', '94 %', 'Sur 128 avis'],
          ].map(([label, value, note], i) => (
            <article key={label} className="ds-panel ds-stat is-lift ds-rise" style={rank(2 + i)}>
              <p className="ds-label">{label}</p>
              <strong>{value}</strong>
              <p className="ds-text">{note}</p>
            </article>
          ))}
        </div>
        <section className="ds-panel ds-list ds-rise" style={rank(4)} aria-labelledby="ds-recent">
          <div className="ds-panel-head">
            <h2 id="ds-recent">Activité récente</h2>
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
        <div className="ds-banner ds-rise" style={rank(5)}>
          <p>
            <strong>Une alerte demande votre attention.</strong> Le contraste du bouton secondaire est sous 4,5:1.
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
      <main className="ds-narrow">
        <div className="ds-intro ds-rise" style={rank(0)}>
          <h1>Votre espace</h1>
          <p className="ds-lead">Quelques informations pour préparer votre compte.</p>
        </div>
        <div className="ds-steps ds-rise" style={rank(1)}>
          <div className="ds-progress" aria-hidden="true">
            <span className="done" />
            <span className="done" />
            <span />
          </div>
          <p className="ds-label">Étape 2 sur 3</p>
        </div>
        <form
          className="ds-panel ds-form ds-rise"
          style={rank(2)}
          aria-label="Inscription"
          onSubmit={(e) => {
            e.preventDefault();
            setSent(true);
          }}
        >
          <div className="ds-fields">
            <Input label="Prénom" placeholder="Camille" />
            <Input label="Nom" placeholder="Martin" />
          </div>
          <Input label="Adresse e-mail" type="email" placeholder="camille@" error="Ajouter une adresse complète." />
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
            <Button>{sent ? 'Enregistré' : 'Continuer'}</Button>
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
        <header className="ds-intro ds-rise" style={rank(0)}>
          <h1>Construire un design system qui dure</h1>
          <p className="ds-lead">
            Deux couches de tokens, des règles vérifiées à chaque essai, et des versions qu’on peut comparer.
          </p>
          <p className="ds-label">Journal · 6 min de lecture</p>
        </header>
        {/* Couverture : la palette du projet, en aplats. */}
        <div className="ds-cover ds-rise" style={rank(1)} aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="ds-prose ds-rise" style={rank(2)}>
          <p>
            Les primitives décrivent ce qui existe : une gamme de couleurs, une échelle d’espacements. Les tokens
            sémantiques disent à quoi elles servent : le fond d’une carte, le texte d’un bouton.
          </p>
          <h2>Nommer par l’usage</h2>
          <p>Un token nommé par l’usage survit à un changement de marque. On change la valeur, pas les écrans.</p>
          <blockquote>« Le DS n’est pas une palette, c’est un ensemble de décisions. »</blockquote>
          <p>
            Chaque version acceptée devient une référence : on la transfère dans Figma, et le code la reçoit par une
            pull request.
          </p>
        </div>
        <aside className="ds-cta ds-rise" style={rank(3)}>
          <div>
            <strong>Prêt à essayer ?</strong>
            <p>Changer une couleur dans l’atelier et regarder cette page suivre.</p>
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
