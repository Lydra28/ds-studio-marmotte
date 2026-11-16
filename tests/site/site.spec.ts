import { expect, test, type Page, type Route } from '@playwright/test';

// Site vitrine (lot 7), servi par tests/site/server.mjs : catalogue de
// fixture (tests/site/catalog.json), API factice simulée ici, aucun réseau.
const API = 'http://127.0.0.1:4331';
const SITE = 'http://127.0.0.1:4330';
const PAGES = [
  '/',
  '/telecharger/',
  '/plugin-figma/',
  '/prix/',
  '/compte/',
  '/compte/verifier/',
  '/compte/app/',
  '/merci/',
  '/paiement-annule/',
  '/mentions-legales/',
  '/cgv/',
  '/confidentialite/',
];

const ME = {
  email: 'essai@example.test',
  tier: 'free',
  plan: 'free',
  gifted: false,
  creditCents: 1,
  welcome: true,
  subscription: null,
  usage: { todayCents: 0, monthCents: 0, resetAt: '2026-11-05T00:00:00.000Z', includedLeftCents: 0 },
  catalog: {
    currency: 'eur',
    mode: 'test',
    pro: { amountCents: 999, interval: 'month', includedCents: 1100 },
    packs: [
      { pack: '5', amountCents: 500 },
      { pack: '10', amountCents: 1000 },
      { pack: '20', amountCents: 2000 },
    ],
  },
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true' },
    body: JSON.stringify(body),
  });

// Polices Google remplacées par une feuille vide ; erreurs console relevées (CSP comprise).
async function offline(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return errors;
}

test('pages : titre unique, langue, images décrites, liens internes valides, aucune erreur', async ({ page, request }) => {
  const errors = await offline(page);
  await page.route(`${API}/**`, (r) => json(r, 401, { error: 'Connexion requise.' }));
  const links = new Set<string>();
  for (const path of PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page.locator('h1'), path).toHaveCount(1);
    await expect(page.locator('img:not([alt])'), path).toHaveCount(0);
    await expect(page.getByRole('note').filter({ hasText: 'mode test' })).toBeVisible();
    for (const href of await page.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!)))
      links.add(href.split('#')[0]);
  }
  for (const href of links) expect((await request.get(href)).status(), href).toBe(200);
  // Le 401 de /v1/me (visiteur non connecté) est attendu sur /compte/ ; rien d'autre.
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
  expect((await request.get('/inconnue/')).status()).toBe(404);
});

test('en-têtes : CSP stricte, API seule destination des requêtes', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain(`connect-src ${API}`);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  const html = await res.text();
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/); // aucun script en ligne
});

test('prix et téléchargements : montants du catalogue, fichiers à nom fixe', async ({ page }) => {
  await offline(page);
  await page.goto('/prix/');
  const pro = page.locator('.plan', { has: page.getByRole('heading', { name: 'Pro' }) });
  await expect(pro).toContainText('9,99 € / mois');
  await expect(pro).toContainText('11 € d’usage');
  await expect(pro).toContainText('≈ 275 générations du Mur');
  const credits = page.locator('.plan', { has: page.getByRole('heading', { name: 'Crédits' }) });
  for (const amount of ['5 €', '10 €', '20 €']) await expect(credits.getByRole('radio', { name: amount })).toBeAttached();
  // Barre à paliers : le montant et les générations affichés suivent le palier choisi.
  // (innerText : les valeurs des autres paliers sont dans la page, masquées.)
  await expect(credits.locator('.amount')).toHaveText('5 €', { useInnerText: true });
  await credits.locator('.cr-stop', { hasText: '10 €' }).click();
  await expect(credits.getByRole('radio', { name: '10 €' })).toBeChecked();
  await expect(credits.locator('.amount')).toHaveText('10 €', { useInnerText: true });
  await expect(credits.locator('li').first()).toHaveText('≈ 250 générations du Mur', { useInnerText: true });

  await page.goto('/telecharger/');
  for (const [os, file] of [
    ['Windows', 'DS-Studio-Setup.exe'],
    ['macOS', 'DS-Studio.dmg'],
    ['Linux', 'DS-Studio.AppImage'],
  ])
    await expect(page.getByRole('link', { name: `Télécharger pour ${os}` })).toHaveAttribute(
      'href',
      `https://downloads.example/stable/${file}`,
    );
  // Mac non signé : quarantaine retirée au Terminal (le clic droit → Ouvrir
  // ne suffit plus depuis macOS 15).
  // Texte exact (toHaveText normalise les espaces) : copiée telle quelle.
  expect(await page.locator('.os-cmd').textContent()).toBe('xattr -cr /Applications/DS-Studio.app');
  await page.goto('/plugin-figma/');
  await expect(page.getByText('en cours de validation par Figma')).toBeVisible();
});

test('compte : connexion par cookie du site, solde, recharge vers Stripe, déconnexion', async ({ page }) => {
  const errors = await offline(page);
  let logged = false;
  const seen: { path: string; body: unknown }[] = [];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    seen.push({ path, body: req.postData() ? req.postDataJSON() : null });
    if (path === '/v1/me') return logged ? json(route, 200, ME) : json(route, 401, { error: 'Connexion requise.' });
    if (path === '/v1/auth/login') {
      const body = req.postDataJSON() as { password: string };
      if (body.password !== 'mot-de-passe-essai') return json(route, 401, { error: 'Adresse ou mot de passe incorrect.' });
      logged = true;
      return json(route, 200, { token: 'ignoré par le site', account: { email: ME.email } });
    }
    if (path === '/v1/billing/checkout') return json(route, 200, { url: `${SITE}/merci/` });
    if (path === '/v1/billing/withdrawals') return json(route, 200, { days: 14, email: ME.email, purchases: [] });
    if (path === '/v1/auth/logout') {
      logged = false;
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true' } });
    }
    return json(route, 404, { error: 'inconnu' });
  });

  await page.goto('/compte/');
  const form = page.locator('form[data-form="login"]');
  await form.getByLabel('Adresse mail').fill(ME.email);
  await form.getByLabel('Mot de passe').fill('mauvais');
  await form.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('status')).toHaveText('Adresse ou mot de passe incorrect.');
  await form.getByLabel('Mot de passe').fill('mot-de-passe-essai');
  await form.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.locator('[data-email]')).toHaveText(ME.email);
  await expect(page.locator('[data-tier]')).toHaveText('Gratuit');
  await expect(page.locator('[data-credit]')).toHaveText('0,01 € (une génération offerte)');
  await expect(page.getByText('Inclus Pro restant')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Passer Pro (9,99 € / mois)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gérer mon abonnement' })).toBeHidden();
  expect(seen.find((s) => s.path === '/v1/auth/login')?.body).toMatchObject({ client: 'site', email: ME.email });

  await page.getByRole('button', { name: 'Recharger 10 €' }).click();
  await expect(page).toHaveURL(`${SITE}/merci/`);
  expect(seen.find((s) => s.path === '/v1/billing/checkout')?.body).toEqual({ kind: 'credits', pack: '10' });

  await page.goto('/compte/');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page.getByRole('status')).toHaveText('Déconnecté.');
  await expect(page.locator('form[data-form="login"]')).toBeVisible();
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

test('compte : rétractation d’un achat de moins de 14 jours, déclaration puis confirmation', async ({ page }) => {
  const errors = await offline(page);
  let withdrawn = false;
  let sent: unknown = null;
  const purchase = { id: 7, kind: 'credits', label: 'Recharge de crédits de 10,00 € du 6 novembre 2026', amountCents: 1000, purchasedAt: '2026-11-06T10:00:00.000Z', until: '2026-11-20T10:00:00.000Z', refundCents: 700 };
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return json(route, 200, ME);
    if (path === '/v1/billing/withdrawals') return json(route, 200, { days: 14, email: ME.email, purchases: withdrawn ? [] : [purchase] });
    if (path === '/v1/billing/withdraw') {
      sent = req.postDataJSON();
      withdrawn = true;
      return json(route, 200, { purchaseId: 7, kind: 'credits', label: purchase.label, refundCents: 700, receivedAt: '2026-11-08T09:30:00.000Z', refundBy: '2026-11-22T09:30:00.000Z', mailed: true });
    }
    return json(route, 404, { error: 'inconnu' });
  });

  await page.goto('/');
  await page.getByRole('navigation', { name: 'Pied de page' }).getByRole('link', { name: 'Se rétracter' }).click();
  await expect(page).toHaveURL(`${SITE}/compte/#retractation`);
  const box = page.locator('#retractation');
  await expect(box.getByText('Recharge de crédits de 10,00 € du 6 novembre 2026')).toBeVisible();
  await expect(box.getByText(/Remboursement : 7 € \(crédits non utilisés\)/)).toBeVisible();
  await box.getByRole('button', { name: 'Se rétracter du contrat ici' }).click();
  const form = page.locator('form[data-form="withdraw"]');
  await expect(form.getByText(`Accusé de réception envoyé à ${ME.email}.`)).toBeVisible();
  await form.getByLabel('Nom', { exact: true }).fill('Camille Test');
  await form.getByRole('button', { name: 'Confirmer la rétractation' }).click();
  await expect(page.getByRole('status')).toContainText('Rétractation reçue le');
  await expect(page.getByRole('status')).toContainText('7 € remboursés au plus tard le 22 novembre 2026. Accusé de réception envoyé par mail.');
  expect(sent).toEqual({ purchaseId: 7, name: 'Camille Test' });
  await expect(form).toBeHidden();
  await expect(box.getByText('Aucun achat de moins de 14 jours.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('compte : création, onglet ouvert par #creer, mot de passe oublié', async ({ page }) => {
  await offline(page);
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/auth/signup') return json(route, 201, { ok: true, message: 'Compte créé : un mail de confirmation vient de partir.' });
    if (path === '/v1/auth/forgot') return json(route, 200, { ok: true, message: 'Si un compte existe à cette adresse, un mail vient de partir.' });
    if (path === '/v1/auth/reset') return json(route, 400, { error: 'Code invalide ou expiré.' });
    return json(route, 401, { error: 'Connexion requise.' });
  });
  await page.goto('/compte/#creer');
  const signup = page.locator('form[data-form="signup"]');
  await expect(signup).toBeVisible();
  await signup.getByLabel('Adresse mail').fill('nouveau@example.test');
  await signup.getByLabel(/Mot de passe/).fill('un-mot-de-passe-long');
  await signup.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByRole('status')).toContainText('Ouvrir le lien du mail, puis se connecter.');
  await expect(page.locator('form[data-form="login"]')).toBeVisible();

  await page.getByRole('button', { name: 'Mot de passe oublié' }).click();
  await page.locator('form[data-form="forgot"]').getByLabel('Adresse mail').fill('nouveau@example.test');
  await page.locator('form[data-form="forgot"]').getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('Coller le code reçu ci-dessous.');
  const reset = page.locator('form[data-form="reset"]');
  await reset.getByLabel('Code reçu par mail').fill('code-trop-vieux-1234');
  await reset.getByLabel('Nouveau mot de passe').fill('un-mot-de-passe-long');
  await reset.getByRole('button').click();
  await expect(page.getByRole('status')).toHaveText('Code invalide ou expiré.');
});

// Connexion avec Google et GitHub (cadrage du 2026-11-16) : de simples liens
// vers l'API ; l'échec revient par `?oauth=`.
test('compte : boutons Google et GitHub sous les formulaires, échec affiché puis retiré de l’adresse', async ({ page }) => {
  const errors = await offline(page);
  await page.route(`${API}/**`, (r) => json(r, 401, { error: 'Connexion requise.' }));
  await page.goto('/compte/?oauth=adresse');
  await expect(page.getByRole('status')).toContainText('Adresse mail non vérifiée chez ce fournisseur');
  expect(page.url()).toBe(`${SITE}/compte/`);
  const login = page.locator('[data-pane="login"]');
  await expect(login.getByRole('link', { name: 'Continuer avec Google' })).toHaveAttribute('href', `${API}/v1/auth/oauth/google/start`);
  await expect(login.getByRole('link', { name: 'Continuer avec GitHub' })).toHaveAttribute('href', `${API}/v1/auth/oauth/github/start`);
  await page.goto('/compte/#creer');
  await expect(page.getByRole('link', { name: 'Continuer avec Google' }).filter({ visible: true })).toHaveCount(1);
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

test('app : page « Connecter l’app », code montré, connexion puis approbation en un clic', async ({ page }) => {
  const errors = await offline(page);
  let logged = false;
  let approved: unknown = null;
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return logged ? json(route, 200, ME) : json(route, 401, { error: 'Connexion requise.' });
    if (path === '/v1/auth/login') {
      logged = true;
      return json(route, 200, { token: 'ignoré', account: { email: ME.email } });
    }
    if (path === '/v1/auth/app-link/approve') {
      approved = req.postDataJSON();
      return json(route, 200, { ok: true, message: 'App connectée : retourner dans DS-Studio.' });
    }
    return json(route, 404, { error: 'inconnu' });
  });

  await page.goto('/compte/app/');
  await expect(page.getByRole('status')).toContainText('Lien incomplet');

  // Pas connecté : le code est montré, les boutons Google et GitHub ramènent ici.
  await page.goto('/compte/app/?code=bcdf-ghjk');
  await expect(page.locator('[data-code]')).toHaveText('BCDF-GHJK');
  await expect(page.getByRole('link', { name: 'Continuer avec Google' })).toHaveAttribute('href', `${API}/v1/auth/oauth/google/start?app=BCDF-GHJK`);
  await expect(page.getByRole('button', { name: 'Connecter l’app' })).toBeHidden();

  // Connexion par mail sur /compte/, puis retour automatique sur la page de l'app.
  await page.getByRole('link', { name: 'Se connecter par mail' }).click();
  await expect(page).toHaveURL(`${SITE}/compte/?app=BCDF-GHJK`);
  await expect(page.getByRole('link', { name: 'Continuer avec GitHub' }).first()).toHaveAttribute('href', `${API}/v1/auth/oauth/github/start?app=BCDF-GHJK`);
  const form = page.locator('form[data-form="login"]');
  await form.getByLabel('Adresse mail').fill(ME.email);
  await form.getByLabel('Mot de passe').fill('mot-de-passe-essai');
  await form.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(`${SITE}/compte/app/?code=BCDF-GHJK`);

  await expect(page.locator('[data-email]')).toHaveText(ME.email);
  await page.getByRole('button', { name: 'Connecter l’app' }).click();
  await expect(page.getByRole('status')).toHaveText('App connectée : retourner dans DS-Studio.');
  expect(approved).toEqual({ code: 'BCDF-GHJK' });
  await expect(page.locator('[data-code]')).toBeHidden();
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

// Lien créé depuis un autre réseau (peut-être envoyé par un tiers) : le clic
// est refusé (409), le code du lien disparaît, il faut saisir celui de l'app.
test('app : lien d’un autre réseau → code du lien masqué, code saisi', async ({ page }) => {
  const errors = await offline(page);
  const sent: unknown[] = [];
  await page.route(`${API}/**`, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return json(route, 200, ME);
    if (path === '/v1/auth/app-link/approve') {
      const b = req.postDataJSON() as { typed?: boolean };
      sent.push(b);
      return b.typed
        ? json(route, 200, { ok: true, message: 'App connectée : retourner dans DS-Studio.' })
        : json(route, 409, { error: 'Ce lien a été créé depuis un autre réseau que ce navigateur : saisir le code affiché dans votre DS-Studio.' });
    }
    return json(route, 404, { error: 'inconnu' });
  });
  await page.goto('/compte/app/?code=BCDF-GHJK');
  await page.getByRole('button', { name: 'Connecter l’app' }).click();
  await expect(page.getByRole('status')).toContainText('autre réseau');
  await expect(page.locator('[data-code]')).toBeHidden();
  const field = page.getByLabel('Code affiché dans DS-Studio');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('', { timeout: 1000 });
  await field.fill('mnpq-rstv');
  await page.getByRole('button', { name: 'Connecter l’app' }).click();
  await expect(page.getByRole('status')).toHaveText('App connectée : retourner dans DS-Studio.');
  expect(sent).toEqual([{ code: 'BCDF-GHJK' }, { code: 'mnpq-rstv', typed: true }]);
  expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
});

// Relecture du lot site : connecté avec le mauvais compte, « Changer de
// compte » déconnecte sur place (plus de boucle /compte/ ↔ /compte/app/).
test('app : « Changer de compte » déconnecte et propose les autres connexions', async ({ page }) => {
  await offline(page);
  let logged = true;
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') return logged ? json(route, 200, ME) : json(route, 401, { error: 'Connexion requise.' });
    if (path === '/v1/auth/logout') {
      logged = false;
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true' } });
    }
    return json(route, 404, { error: 'inconnu' });
  });
  await page.goto('/compte/app/?code=BCDF-GHJK');
  await expect(page.locator('[data-email]')).toHaveText(ME.email);
  await page.getByRole('button', { name: 'Changer de compte' }).click();
  await expect(page.getByRole('link', { name: 'Continuer avec Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connecter l’app' })).toBeHidden();
  expect(logged).toBe(false);
  expect(page.url()).toBe(`${SITE}/compte/app/?code=BCDF-GHJK`);
});

test('confirmation : jeton du lien envoyé puis retiré de l’adresse', async ({ page }) => {
  await offline(page);
  let token = '';
  await page.route(`${API}/v1/auth/verify`, (route) => {
    token = (route.request().postDataJSON() as { token: string }).token;
    return json(route, 200, { ok: true, message: 'Adresse confirmée : vous pouvez vous connecter.' });
  });
  await page.goto('/compte/verifier/?token=jeton-du-mail-123456');
  await expect(page.getByRole('status')).toHaveText('Adresse confirmée : vous pouvez vous connecter.');
  expect(token).toBe('jeton-du-mail-123456');
  expect(page.url()).toBe(`${SITE}/compte/verifier/`);
  await page.goto('/compte/verifier/');
  await expect(page.getByRole('status')).toContainText('Lien incomplet');
});

test('navigation mobile : bouton Menu, ouverture, fermeture par Échap', async ({ page }) => {
  const errors = await offline(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/prix/');
  const menu = page.getByRole('button', { name: 'Menu' });
  const link = page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('link', { name: 'Télécharger' });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(link).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(link).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(link).toBeHidden();
  await expect(menu).toBeFocused();
  // Bureau : pas de bouton, navigation affichée.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(menu).toBeHidden();
  await expect(link).toBeVisible();
  expect(errors).toEqual([]);
});
