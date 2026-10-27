import { test, expect, type Page } from '@playwright/test';

// Parcours de l'atelier sur une copie jetable de l'instance Marmotte
// (scripts/e2e-server.mjs). Les tests partagent un serveur : chacun part de
// la révision enregistrée par le précédent, dans l'ordre du fichier.
test.describe.configure({ mode: 'serial' });

const revision = async (page: Page) =>
  (await (await page.request.get('/api/state')).json()).revision as number;
const validate = async (page: Page) => {
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
};
// Variable CSS lue dans l'iframe de preview, brouillon compris.
const previewVar = (page: Page, name: string) =>
  page
    .frameLocator('iframe[title="Preview du design system"]')
    .locator('.ds')
    .first()
    .evaluate((el, n) => el.style.getPropertyValue(n), name);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Marmotte', { exact: true })).toBeVisible();
});

test('boucle : écart signalé, correction essayée, diff validé, preview à jour', async ({ page }) => {
  const sm = page.getByLabel('space/sm', { exact: true });
  await sm.fill('15');
  await expect(page.getByText('1 écart(s)', { exact: true })).toBeVisible();
  expect(await previewVar(page, '--space-sm')).toBe('15px');
  await page.getByRole('button', { name: 'Essayer 16 px' }).click();
  await expect(page.getByText('Aucun écart', { exact: true })).toBeVisible();
  await validate(page);
  await expect(page.getByText(/Révision 1 enregistrée/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('space/sm', { exact: true })).toHaveValue('16');
  expect(await previewVar(page, '--space-sm')).toBe('16px');
});

test('ajout et retrait de tokens, retrait refusé tant qu’un alias y renvoie', async ({ page }) => {
  await page.getByRole('button', { name: '+ Ajouter un token' }).first().click();
  const name = page.getByLabel('Nom du nouveau token');
  await name.fill('color/neutral/500');
  await expect(page.getByText('existe déjà')).toBeVisible();
  await name.fill('color/accent/500');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByLabel('color/accent/500', { exact: true }).fill('#FF5500');
  await page.getByLabel('bg/brand light', { exact: true }).selectOption('{color/accent/500}');
  await page.getByRole('button', { name: 'Retirer color/accent/500' }).click();
  await expect(page.getByText(/utilisé par bg\/brand/)).toBeVisible();
  await page.getByRole('button', { name: 'Retirer space/4xl' }).click();
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('ajouté')).toBeVisible();
  await expect(dialog.getByText('retiré')).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
  expect(await previewVar(page, '--bg-brand')).toBe('#FF5500');
  await expect(page.getByRole('button', { name: 'Retirer space/4xl' })).toHaveCount(0);
});

test('abandon du brouillon sans écriture, puis annulation depuis l’historique', async ({ page }) => {
  const before = await revision(page);
  await page.getByLabel('space/md', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Abandonner' }).click();
  await expect(page.getByLabel('space/md', { exact: true })).not.toHaveValue('20');
  expect(await revision(page)).toBe(before);
  await page.getByRole('button', { name: 'Historique' }).click();
  await page.getByRole('button', { name: 'Annuler cette révision' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('code').filter({ hasText: 'color/accent/500' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(page.getByLabel('space/4xl', { exact: true })).toBeVisible();
  expect(await revision(page)).toBe(before + 1);
});

test('acceptation : bloquée par un brouillon, puis version figée', async ({ page }) => {
  const accept = page.getByRole('button', { name: 'Accepter cette version' });
  await page.getByLabel('space/md', { exact: true }).fill('20');
  await expect(accept).toBeDisabled();
  await page.getByRole('button', { name: 'Abandonner' }).click();
  await accept.click();
  await expect(page.getByText(/Version v\d+ acceptée \(empreinte/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^v\d+ acceptée$/ })).toBeDisabled();
});

test('nomenclature et mobile 375 px sans défilement horizontal', async ({ page }) => {
  await page.getByLabel('Noms à vérifier, un par ligne').fill('card projet\nButton');
  await expect(page.getByText('1 nom(s) à revoir sur 2.')).toBeVisible();
  await expect(page.getByText('→ CardProject')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
