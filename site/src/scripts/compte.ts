// Compte sur le site (lot 7) : session par le cookie httpOnly `ds_session`
// posé par l'API à la connexion `client: 'site'`. Le script ne voit jamais
// le jeton ; chaque appel part avec `credentials: 'include'`.

interface Me {
  email: string;
  tier: 'free' | 'pro' | 'gifted' | string;
  plan: string;
  gifted: boolean;
  creditCents: number;
  welcome: boolean;
  subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  usage: { includedLeftCents: number };
  catalog?: { pro: { amountCents: number }; packs: { pack: string; amountCents: number }[] };
}

const root = document.querySelector<HTMLElement>('[data-api]');
if (root) start(root);

function start(root: HTMLElement) {
  const api = root.dataset.api!.replace(/\/+$/, '');
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const message = $('[data-message]');

  const say = (text: string, kind: 'ok' | 'error' = 'ok') => {
    message.textContent = text;
    message.className = `message ${kind}`;
    message.hidden = false;
  };
  const quiet = () => {
    message.hidden = true;
  };

  async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${api}${path}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        credentials: 'include',
        headers: init.body ? { 'content-type': 'application/json' } : {},
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new Error('Serveur DS-Studio injoignable. Vérifie ta connexion et réessaie.');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw Object.assign(new Error(data.error ?? `Erreur ${res.status}.`), { status: res.status });
    return data as T;
  }

  const euros = (cents: number) =>
    `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })} €`;

  // Onglets des formulaires (connexion, création, mot de passe oublié).
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panes = [...root.querySelectorAll<HTMLElement>('[data-pane]')];
  const show = (name: string) => {
    for (const t of tabs) t.setAttribute('aria-pressed', String(t.dataset.tab === name));
    for (const p of panes) p.hidden = p.dataset.pane !== name;
  };
  for (const t of tabs) t.addEventListener('click', () => (quiet(), show(t.dataset.tab!)));
  show(location.hash === '#creer' ? 'signup' : 'login');

  const value = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  const busy = async (form: HTMLFormElement, run: () => Promise<void>) => {
    const button = form.querySelector('button[type=submit]') as HTMLButtonElement;
    button.disabled = true;
    try {
      await run();
    } catch (e) {
      say((e as Error).message, 'error');
    } finally {
      button.disabled = false;
    }
  };
  const on = (name: string, run: (form: HTMLFormElement) => Promise<void>) => {
    const form = $<HTMLFormElement>(`form[data-form="${name}"]`);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      quiet();
      void busy(form, () => run(form));
    });
  };

  on('login', async (f) => {
    await call('/v1/auth/login', { body: { email: value(f, 'email'), password: (f.elements.namedItem('password') as HTMLInputElement).value, client: 'site' } });
    f.reset();
    await refresh();
  });
  on('signup', async (f) => {
    const r = await call<{ message: string }>('/v1/auth/signup', {
      body: { email: value(f, 'email'), password: (f.elements.namedItem('password') as HTMLInputElement).value },
    });
    say(`${r.message} Ouvre le lien du mail, puis connecte-toi.`);
    f.reset();
    show('login');
  });
  on('resend', async (f) => {
    const r = await call<{ message: string }>('/v1/auth/resend', { body: { email: value(f, 'email') } });
    say(r.message);
  });
  on('forgot', async (f) => {
    const r = await call<{ message: string }>('/v1/auth/forgot', { body: { email: value(f, 'email') } });
    say(`${r.message} Colle le code reçu ci-dessous.`);
  });
  on('reset', async (f) => {
    const r = await call<{ message: string }>('/v1/auth/reset', {
      body: { token: value(f, 'token'), password: (f.elements.namedItem('password') as HTMLInputElement).value },
    });
    say(r.message);
    f.reset();
    show('login');
  });

  // Espace connecté.
  const out = $('[data-out]');
  const inside = $('[data-in]');
  const go = async (path: string, body?: unknown) => {
    quiet();
    try {
      const { url } = await call<{ url: string }>(path, { body: body ?? {} });
      location.assign(url);
    } catch (e) {
      say((e as Error).message, 'error');
    }
  };

  function render(me: Me) {
    $('[data-email]').textContent = me.email;
    $('[data-tier]').textContent = me.gifted ? 'Pro (compte offert)' : me.tier === 'pro' ? 'Pro' : 'Gratuit';
    $('[data-credit]').textContent = me.welcome ? `${euros(me.creditCents)} (une génération offerte)` : euros(me.creditCents);
    const toggle = (sel: string, visible: boolean) => {
      for (const el of root.querySelectorAll<HTMLElement>(sel)) el.hidden = !visible;
    };
    toggle('[data-included-row]', me.tier === 'pro' || me.gifted);
    $('[data-included]').textContent = euros(me.usage.includedLeftCents);
    toggle('[data-sub-row]', !!me.subscription);
    if (me.subscription) {
      const end = me.subscription.currentPeriodEnd ? new Date(me.subscription.currentPeriodEnd).toLocaleDateString('fr-FR') : '';
      $('[data-sub]').textContent = me.subscription.cancelAtPeriodEnd ? `résilié, actif jusqu’au ${end}` : `actif, renouvelé le ${end}`;
    }

    const packs = $('[data-packs]');
    packs.replaceChildren(
      ...(me.catalog?.packs ?? []).map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `Recharger ${euros(p.amountCents)}`;
        b.addEventListener('click', () => void go('/v1/billing/checkout', { kind: 'credits', pack: p.pack }));
        return b;
      }),
    );
    const pro = $<HTMLButtonElement>('[data-pro]');
    pro.hidden = me.gifted || me.tier === 'pro';
    if (me.catalog) pro.textContent = `Passer Pro (${euros(me.catalog.pro.amountCents)} / mois)`;
    $('[data-portal]').hidden = me.gifted || !me.subscription;
  }

  async function refresh() {
    try {
      render(await call<Me>('/v1/me'));
      out.hidden = true;
      inside.hidden = false;
    } catch (e) {
      out.hidden = false;
      inside.hidden = true;
      if ((e as { status?: number }).status !== 401) say((e as Error).message, 'error');
    }
  }

  $('[data-pro]').addEventListener('click', () => void go('/v1/billing/checkout', { kind: 'pro' }));
  $('[data-portal]').addEventListener('click', () => void go('/v1/billing/portal'));
  $('[data-logout]').addEventListener('click', async () => {
    quiet();
    try {
      await call('/v1/auth/logout', { method: 'POST' });
    } catch {
      // Session déjà tombée côté serveur : l'état local suit quand même.
    }
    await refresh();
    say('Déconnecté.');
  });

  void refresh();
}
