import { useEffect, useRef, useState, type FormEvent } from 'react';
import { accountChanged, ACCOUNT_HASH, Avatar, FigmaMark, GithubMark, GlassBadge, WELCOME_HASH } from './Chrome.js';
import {
  accountAction,
  desktopAction,
  getAccount,
  getGithub,
  getSettings,
  githubAction,
  type AccountAction,
  type AccountStatus,
  type DesktopAction,
  type GithubAction,
  type GithubRepo,
  type GithubStatus,
  type Pack,
  type Settings,
  type UpdateState,
} from './api.js';

// Réglages de l'application : compte DS-Studio (lot 3), lecture de ce que
// l'app sait d'elle-même, plus deux actions que seule l'app installée sait
// faire (changer de dossier, mettre à jour). Rien à éditer dans un fichier :
// c'est la page qui remplace le `.env` pour l'utilisateur.
const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
// Coût du modèle compté en centimes de dollar (1 crédit OpenRouter = 1 $) ; crédits et inclus Pro vendus en centimes d'euro (lot 4).
const amount = (cents: number) => (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dollars = (cents: number) => `${amount(cents)} $`;
const euros = (cents: number) => `${amount(cents)} €`;
// Prix et débit moyen d'une génération : catalogue du serveur (lot 7,
// `catalog` de server/billing.ts), jamais recopiés ici.
const euroLabel = (cents: number) => (cents % 100 === 0 ? `${cents / 100} €` : euros(cents));

function updateLabel(u: UpdateState | null) {
  if (!u) return 'Mises à jour gérées hors de l’app (atelier lancé depuis les sources).';
  switch (u.status) {
    case 'disabled':
      return u.reason ?? 'Mises à jour désactivées.';
    case 'idle':
      return 'Pas encore vérifié.';
    case 'checking':
      return 'Vérification…';
    case 'up-to-date':
      return `À jour${u.checkedAt ? ` (vérifié à ${time(u.checkedAt)})` : ''}.`;
    case 'downloading':
      return `Téléchargement de la version ${u.available ?? ''}… ${u.progress ?? 0} %`;
    case 'ready':
      return `Version ${u.available ?? ''} téléchargée : elle s’installera au prochain redémarrage.`;
    case 'error':
      return `Mise à jour impossible : ${u.message ?? 'erreur inconnue'}.`;
  }
}

const tierLabel = (a: AccountStatus) => (a.tier === 'pro' ? (a.gifted ? 'Pro (offert)' : 'Pro') : 'Gratuit');
function licenseLabel(a: AccountStatus) {
  const l = a.license;
  if (!l || l.state === 'none') return 'Pas encore de licence : actualiser une fois en ligne.';
  if (l.state === 'valid' && l.expiresAt) return `Valide jusqu’au ${day(l.expiresAt)}, renouvelée en ligne.`;
  if (l.state === 'grace' && l.graceUntil) return `Expirée : tolérée hors ligne jusqu’au ${day(l.graceUntil)}, se reconnecter au réseau.`;
  if (l.state === 'expired') return 'Expirée : palier Gratuit jusqu’au prochain contact avec le serveur.';
  return 'Illisible : actualiser, ou se déconnecter puis se reconnecter.';
}
function subscriptionLabel(a: AccountStatus) {
  const s = a.subscription;
  if (!s || a.plan !== 'pro') return '';
  if (s.status === 'past_due') return 'Paiement en attente : mettre la carte à jour (Gérer mon abonnement).';
  const end = s.currentPeriodEnd ? `Pro jusqu’au ${day(s.currentPeriodEnd)}` : 'Pro';
  return s.cancelAtPeriodEnd ? `${end}, résiliation programmée à cette date.` : `${end}, renouvelé automatiquement.`;
}

// Formulaire hors connexion : connexion, création, mot de passe oublié (code
// par mail puis nouveau mot de passe). Adresse et mot de passe ne font que
// passer par le serveur local, qui garde le jeton de session pour lui.
type Mode = 'login' | 'signup' | 'forgot' | 'reset';
const TABS: { id: Mode; label: string }[] = [
  { id: 'login', label: 'Connexion' },
  { id: 'signup', label: 'Créer un compte' },
  { id: 'forgot', label: 'Mot de passe oublié' },
];
const SUBMIT: Record<Mode, string> = {
  login: 'Se connecter',
  signup: 'Créer mon compte',
  forgot: 'Recevoir un code',
  reset: 'Changer le mot de passe',
};

// Après l'ouverture d'une page Stripe, le compte change par webhook côté
// serveur : l'app relit le compte toutes les WATCH_EVERY_MS et dès que la
// fenêtre reprend la main, pendant WATCH_MS, jusqu'au changement attendu
// (watchDone). « Actualiser » reste là.
export const WATCH_MS = 3 * 60_000;
// Connexion par le site : l'app demande sa session toutes les LINK_EVERY_MS
// (même valeur que `LINK_INTERVAL` de server/oauth.ts, à changer ensemble).
export const LINK_EVERY_MS = 2000;
export const WATCH_EVERY_MS = 3000;
export type WatchKind = 'credits' | 'pro' | 'portal';
const billingKey = (a: AccountStatus | undefined) =>
  a?.status === 'connected' ? JSON.stringify([a.plan, a.gifted, a.usage?.creditCents ?? null, a.subscription ?? null]) : '';
// Fin de l'attente : seulement le changement que l'achat produit, pour qu'une
// génération qui consomme des crédits pendant ce temps ne passe pas pour un
// paiement. Session perdue : fin aussi (rien à annoncer).
export function watchDone(kind: WatchKind, before: AccountStatus | undefined, a: AccountStatus) {
  if (a.status !== 'connected') return true;
  if (kind === 'pro') return a.plan === 'pro';
  if (kind === 'portal') return JSON.stringify([a.plan, a.subscription ?? null]) !== JSON.stringify([before?.plan, before?.subscription ?? null]);
  const was = before?.usage?.creditCents;
  const now = a.usage?.creditCents;
  // Solde inconnu au départ (hors ligne) : tout changement vaut paiement.
  if (was === undefined) return billingKey(a) !== billingKey(before);
  return now !== undefined && now > was;
}

// `compact` : formulaire seul, sans titre ni texte d'introduction (pop-in d'accueil).
export function AccountSection({
  account,
  onChange,
  compact = false,
}: {
  account: AccountStatus | undefined;
  onChange: (a: AccountStatus) => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Dernière page Stripe demandée : lien de secours si le navigateur n'a rien ouvert.
  const [payUrl, setPayUrl] = useState('');
  const [watch, setWatch] = useState<{ kind: WatchKind; before: AccountStatus | undefined; until: number } | null>(null);
  useEffect(() => {
    if (!watch) return;
    let pending = false;
    // Effet nettoyé (autre action, déconnexion, page quittée) : une réponse
    // encore en route ne touche plus à rien.
    let cancelled = false;
    const poll = async () => {
      if (pending || cancelled) return;
      if (Date.now() > watch.until) {
        setWatch(null);
        setNotice(
          watch.kind === 'portal'
            ? 'Abonnement inchangé pour l’instant : en cas de modification récente, cliquer Actualiser dans un moment.'
            : 'Pas encore de changement sur le compte : cliquer Actualiser dans un moment.',
        );
        return;
      }
      pending = true;
      try {
        const r = await accountAction({ action: 'refresh' });
        if (cancelled || !watchDone(watch.kind, watch.before, r.account)) return;
        onChange(r.account);
        accountChanged();
        setWatch(null);
        setPayUrl('');
        const a = r.account;
        // Session perdue entre-temps : rien à annoncer, le formulaire de connexion revient.
        if (a.status !== 'connected') return;
        setNotice(
          watch.kind === 'portal'
            ? 'Abonnement mis à jour.'
            : watch.kind === 'pro'
              ? 'Paiement reçu : Pro actif.'
              : a.usage
                ? `Paiement reçu : crédits ${euros(a.usage.creditCents)}.`
                : 'Paiement reçu.',
        );
      } catch {
        // Réseau coupé : on réessaie au prochain tour.
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void poll(), WATCH_EVERY_MS);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [watch]);
  // Connexion par le site en attente : l'app demande sa session jusqu'à
  // l'approbation sur la page « Connecter l'app ». Réseau coupé : on
  // réessaie ; lien refusé ou expiré (le serveur local l'a retiré) : arrêt.
  const linkCode = account?.status === 'none' ? (account.link?.userCode ?? null) : null;
  useEffect(() => {
    if (!linkCode) return;
    let pending = false;
    let cancelled = false;
    const poll = async () => {
      if (pending || cancelled) return;
      pending = true;
      try {
        const r = await accountAction({ action: 'link-poll' });
        if (cancelled) return;
        onChange(r.account);
        if (r.account.status === 'connected') {
          accountChanged();
          setNotice('App connectée.');
        }
      } catch (e) {
        if (cancelled) return;
        const now = await getAccount().catch(() => null);
        if (cancelled || !now || now.link) return;
        onChange(now);
        // Connecté entre-temps (autre fenêtre, mot de passe) : rien à signaler.
        if (now.status === 'none') setError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void poll(), LINK_EVERY_MS);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [linkCode]);
  const startLink = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await accountAction({ action: 'link-start' });
      onChange(r.account);
      // Page du site dans le navigateur : l'app installée ouvre les liens externes dehors (desktop/main.mjs).
      if (r.account.link) window.open(r.account.link.url, '_blank', 'noopener');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (action: AccountAction, fields = false, buy?: { kind: 'pro' | 'credits'; pack?: Pack }) => {
    setBusy(true);
    setError('');
    setNotice('');
    // « Actualiser » pendant l'attente ne l'arrête pas ; toute autre action, si.
    if (action !== 'refresh') setWatch(null);
    try {
      const r = await accountAction(fields ? { action, email: email || undefined, password: password || undefined, code: code || undefined } : { action, ...buy });
      onChange(r.account);
      accountChanged();
      setNotice(r.message ?? '');
      setPassword('');
      if (r.url) {
        // Page Stripe dans le navigateur : l'app installée ouvre les liens externes dehors (desktop/main.mjs).
        setPayUrl(r.url);
        window.open(r.url, '_blank', 'noopener');
        // Base de comparaison : le compte que le serveur vient de rendre, pas celui affiché (peut-être relu il y a longtemps).
        setWatch({ kind: action === 'portal' ? 'portal' : buy?.kind === 'pro' ? 'pro' : 'credits', before: r.account, until: Date.now() + WATCH_MS });
        setNotice(
          action === 'portal'
            ? 'Page Compte du site ouverte dans le navigateur : « Gérer mon abonnement » s’y trouve. Le compte se met à jour ici tout seul après un changement (pendant 3 minutes).'
            : 'Page de paiement ouverte dans le navigateur. Le compte se met à jour ici tout seul après le paiement (pendant 3 minutes).',
        );
      } else setPayUrl('');
      if (action === 'signup') setMode('login');
      if (action === 'forgot') setMode('reset');
      if (action === 'reset') {
        setMode('login');
        setCode('');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(mode, true);
  };
  const pick = (m: Mode) => {
    setMode(m);
    setError('');
    setNotice('');
  };
  if (account?.status === 'connected') {
    const a = account;
    const u = a.usage;
    return (
      <section className="settings-block account-block" aria-label="Compte">
        <div className="account-id">
          <Avatar account={a} large />
          <div>
            <p className="mono account-email">{a.email}</p>
            <span className={a.tier === 'pro' ? 'count ok' : 'count'}>{tierLabel(a)}</span>
          </div>
        </div>
        {/* Carte en verre : le solde et ce qu'on peut acheter, rien de technique. */}
        <div className="billing">
          <p className="billing-label">{a.gifted ? 'Compte offert' : 'Solde'}</p>
          <p className="billing-amount">{u ? (a.gifted ? 'Pro' : euros(u.creditCents)) : '—'}</p>
          {u ? (
            <p className="billing-sub">
              {a.gifted ? 'Compte offert : jamais débité.' : a.welcome ? `${euros(u.creditCents)} : une génération offerte` : 'Crédits disponibles.'}
            </p>
          ) : (
            <p className="billing-sub">Solde indisponible hors ligne : actualiser une fois en ligne.</p>
          )}
          {u && a.plan === 'pro' && !a.gifted && (
            <p className="billing-sub">
              {euros(u.includedLeftCents)} encore inclus ce mois
              {a.catalog && a.catalog.generationCents.wall > 0
                ? ` (≈ ${Math.floor(u.includedLeftCents / a.catalog.generationCents.wall)} générations du Mur)`
                : ''}
              .
            </p>
          )}
          {subscriptionLabel(a) && <p className="billing-sub">{subscriptionLabel(a)}</p>}
          {!a.gifted && !a.catalog && <p className="hint">Prix indisponibles : cliquer Actualiser une fois en ligne.</p>}
          {!a.gifted && a.catalog && (
            <>
              <div className="form-actions">
                {a.catalog.packs.map((p) => (
                  <button key={p.pack} disabled={busy} onClick={() => void run('checkout', false, { kind: 'credits', pack: p.pack })}>
                    Recharger {euroLabel(p.amountCents)}
                  </button>
                ))}
                {a.plan === 'pro' ? (
                  <button disabled={busy} onClick={() => void run('portal')}>
                    Gérer mon abonnement
                  </button>
                ) : (
                  <button className="primary" disabled={busy} onClick={() => void run('checkout', false, { kind: 'pro' })}>
                    Passer Pro ({euroLabel(a.catalog.pro.amountCents)}/mois{a.catalog.mode === 'test' ? ', test' : ''})
                  </button>
                )}
              </div>
              <p className="hint">
                Le paiement se fait sur une page Stripe dans le navigateur ; l’app guette ensuite le compte pendant 3 minutes.
                {a.catalog.mode === 'test' ? ' Paiements de test : aucune carte réelle débitée.' : ''}
              </p>
            </>
          )}
        </div>
        {notice && (
          <p className="message ok" role="status">
            {notice}
            {payUrl && (
              <>
                {' '}
                Rien ne s’est ouvert ?{' '}
                <a href={payUrl} target="_blank" rel="noopener noreferrer">
                  Ouvrir la page
                </a>
                .
              </>
            )}
          </p>
        )}
        {a.message && (
          <p className="message error" role="alert">
            {a.message}
          </p>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button disabled={busy} onClick={() => void run('refresh')}>
            Actualiser
          </button>
          <button disabled={busy} onClick={() => void run('logout')}>
            Se déconnecter
          </button>
        </div>
        {/* Pour le support : licence, serveur, coût du modèle. Replié. */}
        <details className="details">
          <summary>Détails</summary>
          <dl>
            <dt>Licence</dt>
            <dd>{licenseLabel(a)}</dd>
            <dt>Serveur</dt>
            <dd>{a.online ? 'En ligne.' : 'Injoignable : Lenny et le Mur des DA reviennent avec le réseau.'}</dd>
            {u && (
              <>
                <dt>Aujourd’hui</dt>
                <dd>
                  {dollars(u.todayCents)} sur {dollars(u.dailyCapCents)} de plafond journalier (coût du modèle, remis à zéro à minuit UTC).
                </dd>
                <dt>Ce mois</dt>
                <dd>{dollars(u.monthCents)} de coût du modèle.</dd>
              </>
            )}
          </dl>
        </details>
      </section>
    );
  }
  return (
    <section
      className={compact ? 'account-compact' : 'settings-block'}
      {...(compact ? { 'aria-label': 'Connexion au compte' } : { 'aria-labelledby': 's-account' })}
    >
      {!compact && (
        <>
          <h2 id="s-account">Compte</h2>
          <p className="hint">
            Un compte DS-Studio active Lenny, l’assistant, et le Mur des DA. Vos projets restent sur cet ordinateur : seuls la doctrine,
            les tokens et les images envoyées au modèle passent par le serveur.
          </p>
        </>
      )}
      {account?.message && (
        <p className="message error" role="alert">
          {account.message}
        </p>
      )}
      <div className="account-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" aria-pressed={mode === t.id || (mode === 'reset' && t.id === 'forgot')} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <form className="account-form" aria-label="Compte DS-Studio" onSubmit={submit}>
        {mode !== 'reset' && (
          <label>
            Adresse mail
            <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        {mode === 'reset' && (
          <label>
            Code reçu par mail
            <input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          </label>
        )}
        {mode !== 'forgot' && (
          <label>
            {mode === 'reset' ? 'Nouveau mot de passe' : 'Mot de passe'}
            <input
              type="password"
              required
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {mode === 'signup' && <p className="hint">Un mail de confirmation arrive : cliquer sur son lien, puis se connecter ici.</p>}
        {mode === 'forgot' && <p className="hint">Un code arrive par mail ; il sert à choisir un nouveau mot de passe.</p>}
        {notice && (
          <p className="message ok" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="primary" type="submit" disabled={busy}>
            {SUBMIT[mode]}
          </button>
          {mode === 'reset' && (
            <button type="button" onClick={() => pick('login')}>
              Annuler
            </button>
          )}
        </div>
      </form>
      {/* Connexion par le site : Google, GitHub ou mail, approuvée en un clic (cadrage OAuth du 2026-11-16). */}
      <div className="account-link" aria-label="Connexion par le navigateur" role="group">
        <p className="account-or">
          <span>ou</span>
        </p>
        {account?.link ? (
          <>
            <p className="hint">Page ouverte dans le navigateur. Vérifier qu’elle affiche ce code, puis cliquer « Connecter l’app » :</p>
            <p className="mono link-code" aria-label="Code de connexion">
              {account.link.userCode}
            </p>
            <div className="form-actions">
              <a className="button" href={account.link.url} target="_blank" rel="noopener noreferrer">
                Rouvrir la page
              </a>
              <button type="button" disabled={busy} onClick={() => void run('link-cancel')}>
                Annuler
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="account-link-start" disabled={busy} onClick={() => void startLink()}>
            <GoogleMark />
            <GithubMark />
            Continuer avec Google ou GitHub
          </button>
        )}
      </div>
    </section>
  );
}

// Logo Google officiel (quatre couleurs, non modifié), comme sur le site.
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Connexion GitHub (plan GitHub, G1, réservée à Pro) : un code à saisir sur
// github.com, puis les dépôts où DS-Studio est installé. Le serveur local
// sonde GitHub et garde les jetons ; la page relit seulement l'état.
const open = (url: string) => window.open(url, '_blank', 'noopener');
function GithubSection({ tier }: { tier: string | undefined }) {
  const [github, setGithub] = useState<GithubStatus>();
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () =>
    getGithub()
      .then(setGithub)
      .catch((e) => setError((e as Error).message));
  // Palier relu : un passage à Pro débloque la section sans recharger la page.
  useEffect(() => {
    void load();
  }, [tier]);
  // Connexion aboutie ou retirée : la barre du haut et l'accueil se relisent.
  const linked = github?.status;
  const was = useRef(linked);
  useEffect(() => {
    if (was.current && linked && was.current !== linked) accountChanged();
    was.current = linked;
  }, [linked]);
  const pending = github?.status === 'pending';
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending]);
  const run = async (action: GithubAction) => {
    setBusy(true);
    setError('');
    try {
      const r = await githubAction(action);
      setGithub(r.github);
      if (action === 'repos') setRepos(r.repos ?? []);
      if (action === 'logout') setRepos(null);
      if (action === 'start' && r.github.verificationUri) open(r.github.verificationUri);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!github) return null;
  const g = github;
  return (
    <section className="settings-block" aria-labelledby="s-github">
      <h2 id="s-github" className="with-mark">
        <GithubMark size={18} />
        GitHub
        {!g.pro && <GlassBadge>Pro</GlassBadge>}
      </h2>
      <p className="hint">
        DS-Studio lit le design system d’un dépôt et propose une pull request qui modifie ses valeurs de design ; vous mergez
        vous-même sur GitHub. Le code est lu sur cet ordinateur.
      </p>
      {!g.pro && (
        <p className="message" role="status">
          Réservé à DS-Studio Pro : passer Pro depuis la page <a href={ACCOUNT_HASH}>Compte</a>.
        </p>
      )}
      {g.status === 'connected' && (
        <dl>
          <dt>Compte</dt>
          <dd className="mono">{g.login}</dd>
        </dl>
      )}
      {g.status === 'pending' && g.userCode && (
        <div className="github-code">
          <p>
            Saisir ce code sur <span className="mono">{g.verificationUri}</span> :
          </p>
          <p className="mono github-user-code" aria-label="Code GitHub">
            {g.userCode}
          </p>
          <p className="hint">
            En attente de GitHub{g.expiresAt ? `, code valable jusqu’à ${time(g.expiresAt)}` : ''}. Choisir ensuite les dépôts
            auxquels DS-Studio a accès.
          </p>
        </div>
      )}
      {repos && (
        <div>
          {repos.length ? (
            <ul className="github-repos" aria-label="Dépôts accessibles">
              {repos.map((r) => (
                <li key={r.fullName}>
                  <span className="mono">{r.fullName}</span>
                  {r.private ? ' (privé)' : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">Aucun dépôt accessible : ajouter DS-Studio à un dépôt sur GitHub.</p>
          )}
        </div>
      )}
      {g.message && (
        <p className="message error" role="alert">
          {g.message}
        </p>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {g.status === 'none' && (
          <button className="primary" disabled={busy || !g.pro} onClick={() => void run('start')}>
            Connecter GitHub
          </button>
        )}
        {g.status === 'pending' && (
          <>
            {g.verificationUri && <button onClick={() => open(g.verificationUri!)}>Ouvrir GitHub</button>}
            <button disabled={busy} onClick={() => void run('cancel')}>
              Annuler
            </button>
          </>
        )}
        {g.status === 'connected' && (
          <>
            <button disabled={busy || !g.pro} onClick={() => void run('repos')}>
              Voir mes dépôts
            </button>
            <button onClick={() => open(g.installUrl)}>Ajouter un dépôt</button>
            <button disabled={busy} onClick={() => void run('logout')}>
              Déconnecter GitHub
            </button>
          </>
        )}
      </div>
      {g.status === 'connected' && (
        <p className="hint">Déconnecter efface les jetons de cet ordinateur ; l’accès se retire aussi dans les réglages GitHub (Applications).</p>
      )}
    </section>
  );
}

// Page Compte (avatar de la barre, `#/compte`) : qui est connecté, le solde
// et les achats dans la carte en verre, le reste replié. Hors connexion : le
// formulaire de connexion.
// `welcome` : la pop-in d'accueil existe (accueil multi-projets), sinon pas de lien.
export function AccountPage({ onBack, welcome = true }: { onBack: () => void; welcome?: boolean }) {
  const [account, setAccount] = useState<AccountStatus>();
  const [error, setError] = useState('');
  const load = () => {
    setError('');
    getAccount()
      .then(setAccount)
      .catch((e) => setError((e as Error).message));
  };
  // Relu aussi quand un autre écran change le compte (pop-in, GitHub).
  useEffect(() => {
    load();
    window.addEventListener('ds-account', load);
    return () => window.removeEventListener('ds-account', load);
  }, []);
  return (
    <div className="home settings">
      <button className="settings-back" onClick={onBack}>
        ← Retour
      </button>
      <header className="home-hero">
        <div>
          <h1>Compte</h1>
          <p className="home-lead">Compte DS-Studio, solde et abonnement.</p>
        </div>
      </header>
      {error && (
        <div className="settings-grid settings-grid--single">
          <p className="message error" role="alert">
            {error}
          </p>
          <div className="form-actions">
            <button onClick={load}>Réessayer</button>
          </div>
        </div>
      )}
      {!account && !error && <p className="home-loading">Chargement du compte…</p>}
      {account && (
        <div className="settings-grid settings-grid--single">
          <AccountSection account={account} onChange={setAccount} />
          {welcome && (
            <p className="hint">
              <a href={WELCOME_HASH}>Revoir la présentation</a> : compte, GitHub et plugin Figma en trois étapes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Page Réglages (engrenage, `#/reglages`) : les connexions, les mises à jour,
// le reste replié dans « Avancé ». Plus de compte ni de paiement ici : un
// résumé renvoie vers la page Compte (les messages du serveur disent
// « Réglages → Compte »).
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [account, setAccount] = useState<AccountStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    Promise.all([getSettings(), getAccount()])
      .then(([s, a]) => {
        setSettings(s);
        setAccount(a);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  // Pendant une vérification ou un téléchargement, l'état bouge : on relit toutes les 2 s.
  const status = settings?.update?.status;
  useEffect(() => {
    if (status !== 'checking' && status !== 'downloading') return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [status]);
  const act = async (action: DesktopAction) => {
    setBusy(true);
    setError('');
    try {
      await desktopAction(action);
      setTimeout(() => void load(), 600);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const on = (active: boolean, yes: string, no: string) => (
    <span className={active ? 'count ok' : 'count'}>{active ? yes : no}</span>
  );
  const connected = account?.status === 'connected';
  const canUpdate = !!settings?.desktop && !!settings.update && settings.update.status !== 'disabled';
  return (
    <div className="home settings">
      <button className="settings-back" onClick={onBack}>
        ← Retour
      </button>
      <header className="home-hero">
        <div>
          <h1>Réglages</h1>
          <p className="home-lead">Connexions et mises à jour de l’app.</p>
        </div>
      </header>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <div className="settings-grid">
          {/* Résumé du compte : le détail et les achats sont sur la page Compte. */}
          <a className="settings-block account-summary" href={ACCOUNT_HASH}>
            <Avatar account={account} />
            <span className="account-summary-text">
              <strong>{connected ? account.email : 'Pas connecté'}</strong>
              <small>{connected ? `${tierLabel(account)} · solde, recharges et abonnement` : 'Connexion ou création de compte'}</small>
            </span>
            <span className="account-summary-go" aria-hidden="true">
              →
            </span>
          </a>
          <GithubSection tier={account?.tier} />
          <section className="settings-block" aria-labelledby="s-figma">
            <h2 id="s-figma" className="with-mark">
              <FigmaMark size={18} />
              Plugin Figma
            </h2>
            <p className="hint">
              Le plugin transfère la version acceptée dans le fichier Figma et renvoie les composants ici. Le code
              d’appairage est dans le bouton Figma de chaque projet.
            </p>
            <p>{on(settings.services.plugin, 'Prêt à être appairé', 'Fermé')}</p>
          </section>
          <section className="settings-block" aria-labelledby="s-update">
            <h2 id="s-update">Mises à jour</h2>
            {status === 'ready' ? (
              <div className="form-actions">
                <button className="primary" disabled={busy} onClick={() => void act('install-update')}>
                  Redémarrer pour installer la version {settings.update?.available ?? ''}
                </button>
              </div>
            ) : (
              <>
                <p className="hint" aria-live="polite">
                  Version <span className="mono">{settings.app.version}</span> · {updateLabel(settings.update)}
                </p>
                {canUpdate && (
                  <div className="form-actions">
                    <button disabled={busy || status === 'checking' || status === 'downloading'} onClick={() => void act('check-update')}>
                      Rechercher une mise à jour
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
          {/* Pour le support et les cas rares : replié. */}
          <details className="settings-block details">
            <summary>Avancé</summary>
            <dl>
              <dt>Version</dt>
              <dd className="mono">
                {settings.app.name} {settings.app.version}
                {settings.update ? ` (canal ${settings.update.channel})` : ''}
              </dd>
              <dt>Dossier des projets</dt>
              <dd className="mono">{settings.projects ?? 'Instance fixe : un seul projet'}</dd>
              <dt>Lenny (assistant) et Mur des DA</dt>
              <dd>
                {on(settings.services.assistant, 'Actif', connected && account?.online === false ? 'Serveur injoignable' : 'Indisponible')}
                {!settings.services.assistant && (
                  <small className="hint">
                    {' '}
                    {connected ? 'Ils reviennent dès que le serveur DS-Studio répond.' : 'Se connecter à votre compte DS-Studio (page Compte).'}
                  </small>
                )}
              </dd>
              <dt>Site en direct</dt>
              <dd>{on(settings.services.relay, 'Relais actif', 'Relais arrêté')}</dd>
              <dt>Pull request GitHub</dt>
              <dd>{on(settings.services.github, 'Par la connexion GitHub', 'GitHub non connecté')}</dd>
            </dl>
            <p className="hint">Vos projets restent sur cet ordinateur. Rien n’est envoyé ailleurs sans votre action.</p>
            {settings.desktop && settings.projects && (
              <div className="form-actions">
                <button disabled={busy} onClick={() => void act('choose-projects')}>
                  Changer de dossier…
                </button>
              </div>
            )}
          </details>
        </div>
      )}
    </div>
  );
}
