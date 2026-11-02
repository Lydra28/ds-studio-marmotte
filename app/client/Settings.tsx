import { useEffect, useState, type FormEvent } from 'react';
import {
  accountAction,
  desktopAction,
  getAccount,
  getSettings,
  type AccountAction,
  type AccountStatus,
  type DesktopAction,
  type Settings,
  type UpdateState,
} from './api.js';

// Réglages de l'application : compte DS-Studio (lot 3), lecture de ce que
// l'app sait d'elle-même, plus deux actions que seule l'app installée sait
// faire (changer de dossier, mettre à jour). Rien à éditer dans un fichier :
// c'est la page qui remplace le `.env` pour l'utilisateur.
const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
// Coûts du relais comptés en centimes de dollar (1 crédit OpenRouter = 1 $) ; prix en euros au lot 4.
const dollars = (cents: number) => `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

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
  if (!l || l.state === 'none') return 'Pas encore de licence : actualise une fois en ligne.';
  if (l.state === 'valid' && l.expiresAt) return `Valide jusqu’au ${day(l.expiresAt)}, renouvelée en ligne.`;
  if (l.state === 'grace' && l.graceUntil) return `Expirée : tolérée hors ligne jusqu’au ${day(l.graceUntil)}, reconnecte-toi au réseau.`;
  if (l.state === 'expired') return 'Expirée : palier Gratuit jusqu’au prochain contact avec le serveur.';
  return 'Illisible : actualise, ou déconnecte-toi puis reconnecte-toi.';
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

function AccountSection({ account, onChange }: { account: AccountStatus | undefined; onChange: (a: AccountStatus) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const run = async (action: AccountAction, fields = false) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await accountAction(fields ? { action, email: email || undefined, password: password || undefined, code: code || undefined } : { action });
      onChange(r.account);
      setNotice(r.message ?? '');
      setPassword('');
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
      <section className="settings-block" aria-labelledby="s-account">
        <h2 id="s-account">Compte</h2>
        <dl>
          <dt>Adresse</dt>
          <dd className="mono">{a.email}</dd>
          <dt>Palier</dt>
          <dd>
            <span className={a.tier === 'pro' ? 'count ok' : 'count'}>{tierLabel(a)}</span>
          </dd>
          <dt>Licence</dt>
          <dd>{licenseLabel(a)}</dd>
          <dt>Serveur</dt>
          <dd>{a.online ? 'En ligne.' : 'Injoignable : l’assistant et le Mur des DA reviennent avec le réseau.'}</dd>
          {u && (
            <>
              <dt>Aujourd’hui</dt>
              <dd>
                {dollars(u.todayCents)} sur {dollars(u.dailyCapCents)} de plafond journalier (remis à zéro à minuit UTC).
              </dd>
              <dt>Ce mois</dt>
              <dd>
                {dollars(u.monthCents)}
                {a.tier === 'pro' && !a.gifted ? `, ${dollars(u.includedLeftCents)} encore inclus dans l’abonnement` : ''}.
              </dd>
              <dt>Crédits</dt>
              <dd>{a.gifted ? 'Compte offert : jamais débité.' : dollars(u.creditCents)}</dd>
            </>
          )}
        </dl>
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
      </section>
    );
  }
  return (
    <section className="settings-block" aria-labelledby="s-account">
      <h2 id="s-account">Compte</h2>
      <p className="hint">
        Un compte DS-Studio active l’assistant et le Mur des DA. Tes projets restent sur cet ordinateur : seuls la doctrine, les
        tokens et les images que tu envoies au modèle passent par le serveur.
      </p>
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
        {mode === 'signup' && <p className="hint">Un mail de confirmation arrive : clique sur son lien, puis connecte-toi ici.</p>}
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
    </section>
  );
}

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
  return (
    <div className="home settings">
      <button className="settings-back" onClick={onBack}>
        ← Retour
      </button>
      <header className="home-hero">
        <div>
          <p className="home-kicker">Réglages</p>
          <h1>{settings?.app.name ?? 'DS-Studio'}</h1>
          <p className="home-lead">{settings ? `Version ${settings.app.version}` : 'Chargement…'}</p>
        </div>
      </header>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <div className="settings-grid">
          <AccountSection
            account={account}
            onChange={(a) => {
              setAccount(a);
              void load();
            }}
          />
          <section className="settings-block" aria-labelledby="s-app">
            <h2 id="s-app">Application</h2>
            <dl>
              <dt>Version</dt>
              <dd className="mono">{settings.app.version}</dd>
              <dt>Mises à jour</dt>
              <dd aria-live="polite">{updateLabel(settings.update)}</dd>
            </dl>
            {settings.desktop && settings.update && settings.update.status !== 'disabled' && (
              <div className="form-actions">
                <button disabled={busy || status === 'checking' || status === 'downloading'} onClick={() => void act('check-update')}>
                  Rechercher une mise à jour
                </button>
                {status === 'ready' && (
                  <button className="primary" disabled={busy} onClick={() => void act('install-update')}>
                    Redémarrer pour installer
                  </button>
                )}
              </div>
            )}
          </section>
          <section className="settings-block" aria-labelledby="s-projects">
            <h2 id="s-projects">Projets</h2>
            <dl>
              <dt>Dossier</dt>
              <dd className="mono">{settings.projects ?? 'Instance fixe : un seul projet'}</dd>
            </dl>
            {settings.desktop && settings.projects && (
              <div className="form-actions">
                <button disabled={busy} onClick={() => void act('choose-projects')}>
                  Changer de dossier…
                </button>
              </div>
            )}
            <p className="hint">Tes projets restent sur cet ordinateur. Rien n’est envoyé ailleurs sans ton action.</p>
          </section>
          <section className="settings-block" aria-labelledby="s-services">
            <h2 id="s-services">Services</h2>
            <dl>
              <dt>Assistant et Mur des DA</dt>
              <dd>
                {on(settings.services.assistant, 'Actif', connected && account?.online === false ? 'Serveur injoignable' : 'Indisponible')}
                {!settings.services.assistant && (
                  <small className="hint">
                    {' '}
                    {connected ? 'Ils reviennent dès que le serveur DS-Studio répond.' : 'Connecte-toi à ton compte DS-Studio (section Compte).'}
                  </small>
                )}
              </dd>
              <dt>Plugin Figma</dt>
              <dd>{on(settings.services.plugin, 'Prêt (code d’appairage dans le bouton Figma)', 'Fermé')}</dd>
              <dt>Site en direct</dt>
              <dd>{on(settings.services.relay, 'Relais actif', 'Relais arrêté')}</dd>
              <dt>Pull request GitHub</dt>
              <dd>{on(settings.services.github, 'Jeton présent', 'Aucun jeton (usage avancé)')}</dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}
