import { test, expect, type Page } from '@playwright/test';

// Recette GitHub du 2026-11-17 : relecture du dépôt avec un brouillon en
// attente, « Réessayer » gardé après un passage par Réglages. Faux serveurs
// (tests/e2e/fake-api.ts), aucun réseau. Ce fichier n'ouvre aucune PR : la PR
// du dépôt fictif est attendue « ouverte » par le test « dépôt » de studio.spec.ts.
test.describe.configure({ mode: 'serial' });

const validate = async (page: Page) => {
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
};

test('recette GitHub : relecture avant validation → rien à reprendre ; « Réessayer » gardé après Réglages', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => sessionStorage.setItem('ds-onboarding', '1'));
  await page.goto('/#/p/marmotte');
  await expect(page.locator('.bar .project')).toHaveText('Marmotte');

  // Compte Pro (offert) puis GitHub, contre les faux serveurs.
  await page.getByRole('button', { name: /^Compte,/ }).click();
  const form = page.getByRole('form', { name: 'Compte DS-Studio' });
  await form.getByLabel('Adresse mail').fill('associe@example.com');
  await form.getByLabel('Mot de passe').fill('mot-de-passe-de-test');
  await form.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('region', { name: 'Compte' })).toContainText('Pro (offert)');
  await page.goto('/#/reglages');
  const github = page.getByRole('region', { name: 'GitHub' });
  const popup = page.waitForEvent('popup');
  await github.getByRole('button', { name: 'Connecter GitHub' }).click();
  await (await popup).close();
  await expect(github).toContainText('dev-e2e', { timeout: 15_000 });

  // Projet depuis le dépôt fictif, proposition mise en brouillon, pas validée.
  await page.goto('/');
  await page.getByRole('button', { name: 'Nouveau projet depuis un dépôt' }).click();
  const create = page.getByRole('form', { name: 'Nouveau projet' });
  // Le nom est prérempli quand la liste des dépôts arrive : l'attendre, sinon
  // il s'ajoute à la saisie (CI du 2026-11-26).
  await expect(create.getByLabel('Nom')).toHaveValue('site-vitrine');
  await create.getByLabel('Nom').fill('Recette GitHub');
  await create.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page).toHaveURL(/#\/p\/recette-github$/);
  const panel = page.getByRole('region', { name: 'Dépôt GitHub' });
  await panel.getByRole('button', { name: 'Mettre en brouillon' }).click();
  await expect(panel).toBeHidden();

  // Relecture avant de valider : tout est déjà dans le brouillon, rien à remettre
  // (avant : « Mettre en brouillon », refusé en bloc, panneau fermé).
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  await panel.getByRole('button', { name: 'Relire le dépôt' }).click();
  await expect(panel.getByRole('button', { name: 'Rien à reprendre' })).toBeDisabled();
  await expect(panel).toContainText('Tout est déjà dans le brouillon');
  await panel.getByRole('button', { name: 'Fermer le dépôt' }).click();
  await validate(page);

  // GitHub déconnecté : la version est acceptée, la PR échoue, « Réessayer » proposé.
  await page.getByRole('button', { name: 'Réglages' }).click();
  await github.getByRole('button', { name: 'Déconnecter GitHub' }).click();
  await expect(github.getByRole('button', { name: 'Connecter GitHub' })).toBeEnabled();
  await page.getByRole('button', { name: '← Retour' }).click();
  await expect(page).toHaveURL(/#\/p\/recette-github$/);
  await page.getByRole('button', { name: 'Accepter cette version' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /^Accepter v\d+$/ }).click();
  const failed = page.getByRole('status').filter({ hasText: 'GitHub : ' });
  await expect(failed).toContainText('Réglages');
  await expect(failed.getByRole('button', { name: 'Réessayer' })).toBeVisible();

  // Le message envoie dans Réglages : au retour, « Réessayer » est toujours là.
  await page.getByRole('button', { name: 'Réglages' }).click();
  await expect(github).toBeVisible();
  await page.getByRole('button', { name: '← Retour' }).click();
  await expect(page).toHaveURL(/#\/p\/recette-github$/);
  await expect(page.getByRole('status').filter({ hasText: 'GitHub : ' }).getByRole('button', { name: 'Réessayer' })).toBeVisible();

  // Nettoyage pour les fichiers suivants : compte déconnecté (GitHub l'est déjà).
  await page.getByRole('button', { name: 'Réglages' }).click();
  await page.getByRole('link', { name: /associe@example\.com/ }).click();
  await page.getByRole('region', { name: 'Compte' }).getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(form).toBeVisible();
});
