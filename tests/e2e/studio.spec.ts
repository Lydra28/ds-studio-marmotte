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
  await page.goto('/#/p/marmotte');
  await expect(page.locator('.bar .project')).toHaveText('Marmotte');
});

test('accueil : liste des projets, création d’un projet vierge à côté de Marmotte', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Marmotte r\d+/ })).toBeVisible();
  await page.getByRole('button', { name: /Nouveau projet/ }).click();
  const form = page.getByRole('form', { name: 'Nouveau projet' });
  await form.getByLabel('Nom').fill('Atelier céramique');
  await form.getByLabel('Doctrine du projet').fill('Artisanal, calme, tons terre.');
  await form.getByLabel('Fichier Figma cible (facultatif)').fill('pas un lien');
  await form.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(form.getByRole('alert')).toContainText('Lien Figma attendu');
  await form.getByLabel('Fichier Figma cible (facultatif)').fill('');
  await form.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page).toHaveURL(/#\/p\/atelier-ceramique$/);
  await expect(page.locator('.bar .project')).toHaveText('Atelier céramique');
  await expect(page.locator('.bar .rev')).toHaveText('r0');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Marmotte' })).toBeVisible();
  // Projets indépendants : Marmotte n'a pas bougé.
  const other = await page.request.get('/api/state', { headers: { 'X-DS-Project': 'atelier-ceramique' } });
  expect((await other.json()).set.components).toBeUndefined();
  await page.getByRole('navigation').getByRole('button', { name: 'Marmotte' }).click();
  await expect(page.locator('.bar .project')).toHaveText('Marmotte');
});

test('assistant : ouvert par la mascotte, désactivé proprement sans clé, mascotte rendue à la fermeture', async ({ page }) => {
  await page.getByRole('button', { name: 'Ouvrir l’assistant' }).click();
  await expect(page.getByRole('button', { name: 'Ouvrir l’assistant' })).toHaveCount(0); // une seule scène 3D
  const panel = page.getByRole('complementary', { name: 'Assistant' });
  await expect(panel).toContainText('Assistant désactivé');
  await expect(panel.getByLabel('Message à l’assistant')).toBeDisabled();
  await expect(page.locator('.bar .project')).toHaveText('Marmotte');
  await panel.getByRole('button', { name: 'Fermer l’assistant' }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole('button', { name: 'Ouvrir l’assistant' })).toBeVisible();
});

test('mur des DA : image déposée, réduite, retirée ; génération bloquée sans clé', async ({ page }) => {
  await page.getByRole('navigation').getByRole('button', { name: 'Mur des DA' }).click();
  await expect(page.getByRole('heading', { name: 'Mur des DA' })).toBeVisible();
  // PNG 2×2 rouge, assez pour createImageBitmap.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.locator('.inspiration-add input[type=file]').setInputFiles({ name: 'mood.png', mimeType: 'image/png', buffer: png });
  const card = page.locator('.inspiration');
  await expect(card).toHaveCount(1);
  await expect(card.locator('img')).toHaveJSProperty('complete', true);
  await expect(page.getByRole('button', { name: /^Proposer \d DA$/ })).toBeDisabled();
  await card.getByRole('button', { name: 'Retirer mood.png' }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: 'Retour à la planche' }).click();
  await expect(page.getByRole('heading', { name: 'Couleurs · Primitives' })).toBeVisible();
});

test('boucle : écart signalé, correction essayée, diff validé, preview à jour', async ({ page }) => {
  const sm = page.getByLabel('space/sm', { exact: true });
  await sm.fill('15');
  await expect(page.getByText('1 écart(s)', { exact: true })).toBeVisible();
  const mascot = page.locator('.mascot-dock');
  await expect(mascot.locator('.mascot-badge')).toHaveText('1');
  await expect(mascot.getByRole('status')).toHaveText('1 écart(s) : regarde « Corrections ».');
  expect(await previewVar(page, '--space-sm')).toBe('15px');
  await page.getByRole('button', { name: 'Essayer 16 px' }).click();
  await expect(page.getByText('Aucun écart', { exact: true })).toBeVisible();
  await expect(mascot.getByRole('status')).toHaveText('Plus aucun écart !');
  await expect(mascot.locator('.mascot-badge')).toHaveCount(0);
  await validate(page);
  await expect(page.getByText(/Révision 1 enregistrée/)).toBeVisible();
  await expect(mascot.getByRole('status')).toHaveText('Enregistré, bien joué !');
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
  await expect(dialog.getByText('ajouté', { exact: true })).toBeVisible();
  await expect(dialog.getByText('retiré', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^Tokens : 1 ajouté\(s\), 1 modifié\(s\), 1 retiré\(s\)$/)).toBeVisible();
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

test('fiches : création au nom corrigé, modification et retrait par diff', async ({ page }) => {
  await page.getByRole('button', { name: '+ Ajouter un composant' }).click();
  const form = page.getByRole('form', { name: 'Nouveau composant' });
  await form.getByLabel('Nom (anglais, PascalCase)').fill('card projet');
  await form.getByRole('button', { name: 'Utiliser CardProject' }).click();
  await form.getByLabel('À quoi il sert').fill('Présente un projet du portfolio.');
  await form.getByRole('button', { name: 'Ajouter en brouillon' }).click();
  await page.getByRole('button', { name: 'Modifier Card', exact: true }).click();
  const edit = page.getByRole('form', { name: 'Modifier Card' });
  await edit.getByLabel('Quand l’éviter').fill('Jamais de carte dans une carte.');
  await edit.getByRole('button', { name: 'Mettre à jour en brouillon' }).click();
  await page.getByRole('button', { name: 'Retirer Input', exact: true }).click();
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('3 changement(s)')).toBeVisible();
  await expect(dialog.getByText('Jamais de carte dans une carte.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const names = page.locator('.fiches .fiche h3');
  await expect(names).toHaveText(['Button', 'Card', 'CardProject']);
});

test('acceptation : bloquée par un brouillon, puis version figée', async ({ page }) => {
  const accept = page.getByRole('button', { name: 'Accepter cette version' });
  await page.getByLabel('space/md', { exact: true }).fill('20');
  await expect(accept).toBeDisabled();
  await page.getByRole('button', { name: 'Abandonner' }).click();
  await accept.click();
  // Avant d'accepter : ce qui change depuis la dernière version, et l'effet côté Figma.
  const review = page.getByRole('dialog');
  await expect(review.getByRole('heading', { name: /^Accepter r\d+ · (comparée à v\d+|première version)$/ })).toBeVisible();
  await expect(review.getByText(/Le transfert appliquera|Aucune cible Figma/)).toBeVisible();
  await review.getByRole('button', { name: /^Accepter v\d+$/ }).click();
  await expect(page.getByText(/Version v\d+ acceptée \(empreinte/)).toBeVisible();
  // Historique : la version se compare à la précédente, ou montre tout son contenu.
  await page.getByRole('button', { name: 'Historique' }).click();
  await page.getByRole('button', { name: /^(Comparer avec v\d+|Voir le contenu)$/ }).first().click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /^v\d+ (comparée à v\d+|· première version)$/ })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();
  await expect(page.getByRole('button', { name: /^v\d+ acceptée$/ })).toBeDisabled();
});

test('plugin Figma : code affiché, version calculée, fiches reçues relues par diff', async ({ page }) => {
  await page.getByRole('button', { name: 'Figma', exact: true }).click();
  const code = (await page.locator('.figma-dialog .pair').textContent()) ?? '';
  expect(code).toMatch(/^[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}$/);
  await page.getByRole('dialog').getByRole('button', { name: 'Fermer' }).click();
  // Requêtes telles que le plugin les envoie depuis Figma (origine `null`).
  const headers = { Origin: 'null', 'X-DS-Plugin': code };
  const payload = await (await page.request.get('/api/plugin/payload?project=marmotte', { headers })).json();
  expect(payload.collections.map((c: { name: string }) => c.name)).toEqual(['Primitives', 'Tokens', 'Typography']);
  const sent = await page.request.post('/api/plugin/components?project=marmotte', {
    headers,
    data: { source: 'Figma test', components: [{ name: 'badge statut', props: { Variant: ['Info', 'Alerte'] }, variables: ['bg/brand'] }] },
  });
  expect((await sent.json()).count).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Fiches reçues de Figma (1)' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Fiches : 1 ajouté(s)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: /Fiches reçues de Figma/ })).toHaveCount(0);
  await expect(page.locator('.fiches .fiche h3', { hasText: 'BadgeStatus' })).toBeVisible();
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

test('générateur de gamme : couleur gardée à son palier, paliers manquants ajoutés, validés par diff', async ({ page }) => {
  const before = await revision(page);
  await page.getByRole('button', { name: 'Générer la gamme color/brand' }).click();
  const gen = page.getByRole('group', { name: 'Générer la gamme color/brand' });
  await gen.getByLabel('Couleur de base en hexadécimal').fill('#2F6BFF');
  await gen.getByLabel('Palier de la couleur de base').selectOption('600');
  await gen.getByText('Compléter de 50 à 900').click();
  await expect(gen.locator('li')).toHaveCount(10);
  await expect(gen.locator('li.is-anchor')).toContainText('#2F6BFF');
  await gen.getByRole('button', { name: 'Mettre en brouillon' }).click();
  await expect(gen).toBeHidden();
  expect(await revision(page)).toBe(before); // brouillon seulement
  await page.getByRole('button', { name: 'Voir le diff et valider' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Tokens : 6 ajouté\(s\), 4 modifié\(s\)/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await expect(dialog).toBeHidden();
  expect(await previewVar(page, '--color-brand-600')).toBe('#2F6BFF');
});

test('comparaison côte à côte : brouillon face à l’état enregistré, inversion, rien d’écrit', async ({ page }) => {
  const before = await revision(page);
  await page.getByLabel('space/md', { exact: true }).fill('28');
  await page.getByRole('button', { name: 'Comparer' }).click();
  const view = page.getByRole('region', { name: 'Comparaison côte à côte' });
  await expect(view.getByLabel('Version après')).toHaveValue('draft');
  await expect(view.getByText('Tokens : 1 modifié(s)')).toBeVisible();
  // Chaque cadre reçoit son propre jeu.
  const spaceIn = (side: string) =>
    view
      .frameLocator(`iframe[title^="${side} :"]`)
      .locator('.ds')
      .first()
      .evaluate((el) => el.style.getPropertyValue('--space-md'));
  expect(await spaceIn('Droite')).toBe('28px');
  expect(await spaceIn('Gauche')).not.toBe('28px');
  await view.getByRole('button', { name: 'Inverser avant et après' }).click();
  await expect(view.getByLabel('Version avant')).toHaveValue('draft');
  expect(await spaceIn('Gauche')).toBe('28px');
  await view.getByRole('button', { name: 'Détail' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('code').filter({ hasText: 'space/md' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await view.getByRole('button', { name: '← Atelier' }).click();
  await page.getByRole('button', { name: 'Abandonner' }).click();
  expect(await revision(page)).toBe(before);
});
