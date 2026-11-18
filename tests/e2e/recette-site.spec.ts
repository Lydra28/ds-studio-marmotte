import { test, expect, type Page } from '@playwright/test';
import { errorPage } from '../../app/server/site-relay';

// Recette du 2026-11-18 : projet existant sans Site en direct (cas Devonia),
// erreurs du relais lisibles dans l'atelier, « Revenir à cette version »
// grisé avec sa raison. Projet à part : Marmotte n'est pas touchée. Le cadre
// du site est servi par `page.route` (aucun réseau, relais non sollicité).

const slug = 'recette-site';
const headers = { 'X-DS-Project': slug };

const api = async (page: Page, route: string, data: unknown) => {
  const csrf = (await (await page.request.get('/api/bootstrap')).json()).csrf as string;
  const r = await page.request.post(`/api/${route}`, {
    headers: { ...headers, 'X-DS-Studio': csrf, 'Content-Type': 'application/json' },
    data,
  });
  return { status: r.status(), body: await r.json() };
};

test('site en direct : adresse ajoutée depuis Comparer, http écarté, erreur du relais lisible, version en cours expliquée', async ({ page }) => {
  // Création avec une adresse http par le formulaire : projet créé (styles
  // lus quand même), Site en direct écarté et dit à l'ouverture du projet.
  await page.addInitScript(() => sessionStorage.setItem('ds-onboarding', '1'));
  await page.goto('/');
  const atelier = new URL(page.url()).origin;
  await page.getByRole('button', { name: /Nouveau projet/ }).click();
  const create = page.getByRole('form', { name: 'Nouveau projet' });
  await create.getByLabel('Nom').fill('Recette site');
  await create.getByLabel('Adresse du site (facultatif)').fill('http://recette-site.example/');
  await create.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${slug}$`));
  await expect(page.getByRole('status').filter({ hasText: 'Adresse en http:// écartée' })).toBeVisible();
  // Une version acceptée, pour l'historique.
  const proposal = await api(page, 'proposals', { revision: 0, changes: [{ key: 'bg/brand', mode: 'light', value: '#225588' }] });
  expect((await api(page, 'commit', { id: proposal.body.id })).status).toBe(200);
  expect((await api(page, 'accept', { revision: 1 })).status).toBe(200);

  // Cadre du site : page d'erreur du relais (site injoignable), sans réseau.
  await page.route(/^http:\/\/recette-site\.localhost:\d+\//, (route) =>
    route.fulfill({
      status: 502,
      contentType: 'text/html; charset=utf-8',
      body: errorPage(atelier, 'Site injoignable : getaddrinfo ENOTFOUND recette-site.example'),
    }),
  );
  // Même URL (hash seul) : goto ne recharge pas ; reload relit la version acceptée par l'API.
  await page.reload();
  await expect(page.locator('.bar .project')).toHaveText('Recette site');
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('tab', { name: 'Comparer' }).click();
  const view = page.getByRole('region', { name: 'Comparaison côte à côte' });
  const content = view.getByLabel('Contenu comparé');
  await expect(content.locator('option[value="site"]')).toHaveCount(0);

  await view.getByRole('button', { name: 'Ajouter l’adresse du site' }).click();
  const form = view.getByRole('form', { name: 'Adresse du site' });
  await form.getByLabel('Adresse du site').fill('http://recette-site.example/');
  await form.getByRole('button', { name: 'Enregistrer l’adresse' }).click();
  await expect(form.getByRole('alert')).toHaveText('Adresse en http:// écartée : le Site en direct demande une adresse https://.');
  await expect(content.locator('option[value="site"]')).toHaveCount(0);

  await form.getByLabel('Adresse du site').fill('https://recette-site.example/accueil');
  await form.getByRole('button', { name: 'Enregistrer l’adresse' }).click();
  await expect(content).toHaveValue('site');
  await expect(content.locator('option[value="site"]')).toHaveText('Site en direct');
  const config = await (await page.request.get('/api/config', { headers })).json();
  expect(config.site).toEqual({ url: 'https://recette-site.example/', pages: ['/'] });

  // Erreur du relais : redite en grand sur le cadre, pas seulement dans la page minuscule.
  const error = view.locator('.site-frame__error').first();
  await expect(error).toBeVisible();
  await expect(error).toContainText('Site indisponible dans l’atelier');
  await expect(error).toContainText('Site injoignable : getaddrinfo ENOTFOUND recette-site.example');
  expect(await error.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);

  // Adresse gardée en changeant d'onglet (Comparer remonté).
  await page.getByRole('tab', { name: 'Historique' }).click();
  const history = page.getByRole('region', { name: 'Historique' });
  const current = history.locator('.hist__item').filter({ hasText: 'version actuelle' });
  await expect(current.getByRole('button', { name: 'Revenir à cette version' })).toBeDisabled();
  await expect(current.getByText('Version enregistrée en cours : rien à rétablir.')).toBeVisible();
  await expect(current.getByRole('button', { name: 'Revenir à cette version' })).toHaveAccessibleDescription(
    'Version enregistrée en cours : rien à rétablir.',
  );
  await page.getByRole('tab', { name: 'Comparer' }).click();
  await expect(view.getByLabel('Contenu comparé').locator('option[value="site"]')).toHaveCount(1);
});
