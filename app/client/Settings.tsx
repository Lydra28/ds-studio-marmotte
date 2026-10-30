import { useEffect, useState } from 'react';
import { desktopAction, getSettings, type DesktopAction, type Settings, type UpdateState } from './api.js';

// Réglages de l'application : lecture seule, plus deux actions que seule l'app
// installée sait faire (changer de dossier, mettre à jour). Rien à éditer dans
// un fichier : c'est la page qui remplace le `.env` pour l'utilisateur.
const time = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

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

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => getSettings().then(setSettings).catch((e) => setError(e.message));
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
                {on(settings.services.assistant, 'Actif', 'Indisponible')}
                {!settings.services.assistant && (
                  <small className="hint"> La connexion au compte DS-Studio arrive ici : l’assistant s’activera sans rien installer.</small>
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
