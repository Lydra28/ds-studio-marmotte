// Page « Connecter l'app » (pages/compte/app.astro) : l'app DS-Studio l'ouvre
// avec son code ; connecté sur le site (cookie httpOnly), un clic approuve le
// code et l'app récupère sa session (server/oauth.ts, /v1/auth/app-link).
// 409 : lien créé depuis un autre réseau (peut-être envoyé par un tiers) ; le
// code du lien n'est plus montré, il faut saisir celui affiché dans l'app.
import { appCode, carryAppCode, takeOAuthError } from './oauth.ts';

const root = document.querySelector<HTMLElement>('[data-link-app]');
if (root) start(root);

function start(root: HTMLElement) {
  const api = root.dataset.linkApp!.replace(/\/+$/, '');
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const message = $('[data-message]');
  const say = (text: string, kind: 'ok' | 'error' = 'ok') => {
    message.textContent = text;
    message.className = `message ${kind}`;
    message.hidden = false;
  };

  const failure = takeOAuthError();
  const code = appCode('code');
  if (!code) {
    say('Lien incomplet : relancer la connexion depuis l’app DS-Studio.', 'error');
    return;
  }
  if (failure) say(failure, 'error');
  $('[data-code]').textContent = code;
  $('[data-code-box]').hidden = false;
  carryAppCode(root, code);
  $<HTMLAnchorElement>('[data-mail-login]').href = `/compte/?app=${code}`;

  async function call<T>(path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string; message?: string } }> {
    const res = await fetch(`${api}${path}`, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as T & { error?: string; message?: string } };
  }

  const approve = $<HTMLButtonElement>('[data-approve]');
  const retype = $<HTMLFormElement>('[data-retype]');
  async function send(button: HTMLButtonElement, payload: { code: string; typed?: true }) {
    button.disabled = true;
    try {
      const r = await call('/v1/auth/app-link/approve', payload);
      if (r.status === 200) {
        $('[data-in]').hidden = true;
        $('[data-code-box]').hidden = true;
        say(r.data.message ?? 'App connectée : retourner dans DS-Studio.');
      } else if (r.status === 409 && !payload.typed) {
        // Le code du lien n'est plus affiché : seul celui de l'app compte.
        $('[data-code-box]').hidden = true;
        approve.hidden = true;
        retype.hidden = false;
        say(r.data.error ?? 'Saisir le code affiché dans DS-Studio.', 'error');
        retype.querySelector('input')!.focus();
      } else say(r.data.error ?? `Erreur ${r.status}.`, 'error');
    } catch {
      say('Serveur DS-Studio injoignable. Vérifier la connexion et réessayer.', 'error');
    } finally {
      button.disabled = false;
    }
  }
  approve.addEventListener('click', () => void send(approve, { code }));
  retype.addEventListener('submit', (e) => {
    e.preventDefault();
    const typed = String(new FormData(retype).get('code') ?? '').trim();
    void send(retype.querySelector('button')!, { code: typed, typed: true });
  });

  // Mauvais compte : déconnexion sur place, puis Google, GitHub ou mail
  // (jamais /compte/?app=, qui renverrait ici tant que la session vit).
  const change = $<HTMLButtonElement>('[data-switch]');
  change.addEventListener('click', async () => {
    change.disabled = true;
    try {
      await fetch(`${api}/v1/auth/logout`, { method: 'POST', credentials: 'include' });
      $('[data-in]').hidden = true;
      $('[data-out]').hidden = false;
    } catch {
      say('Serveur DS-Studio injoignable. Vérifier la connexion et réessayer.', 'error');
    } finally {
      change.disabled = false;
    }
  });

  call<{ email: string }>('/v1/me')
    .then((r) => {
      if (r.status === 200) {
        $('[data-email]').textContent = r.data.email;
        $('[data-in]').hidden = false;
      } else if (r.status === 401) $('[data-out]').hidden = false;
      else say(r.data.error ?? `Erreur ${r.status}.`, 'error');
    })
    .catch(() => say('Serveur DS-Studio injoignable. Vérifier la connexion et réessayer.', 'error'));
}
