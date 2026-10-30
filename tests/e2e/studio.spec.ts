import { PLUGIN_CONTRACT } from '../../app/server/plugin.js';
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
  // Au lancement, toutes les sections de la planche sont repliées.
  await expect(page.locator('.fold[aria-expanded="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tout déplier' }).click();
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
  const picker = page.getByRole('combobox', { name: 'Projet' });
  await expect(picker.locator('option', { hasText: 'Marmotte' })).toHaveCount(1);
  // Projets indépendants : Marmotte n'a pas bougé.
  const other = await page.request.get('/api/state', { headers: { 'X-DS-Project': 'atelier-ceramique' } });
  expect((await other.json()).set.components).toBeUndefined();
  await picker.selectOption('marmotte');
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

test('réglages : version, dossier et services affichés, aucune valeur de secret, actions réservées à l’app', async ({ page }) => {
  // Depuis le projet, puis retour : la page est la même que depuis l'accueil.
  await page.getByRole('button', { name: 'Réglages' }).click();
  await expect(page).toHaveURL(/#\/reglages$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DS-Studio');
  const settings = await (await page.request.get('/api/settings')).json();
  expect(settings.desktop).toBe(false);
  expect(settings.app.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(settings.projects).toMatch(/projects$/);
  expect(settings.update).toBeNull();
  expect(settings.services).toEqual({ assistant: false, github: false, relay: expect.any(Boolean), plugin: true });
  // Jamais une clé ni un jeton dans la réponse, quel que soit le `.env` de la machine.
  expect(JSON.stringify(settings)).not.toMatch(/sk-|ghp_|OPENROUTER|GITHUB_TOKEN/);
  await expect(page.getByText(`Version ${settings.app.version}`)).toBeVisible();
  await expect(page.getByText('Mises à jour gérées hors de l’app')).toBeVisible();
  await expect(page.getByText('Indisponible')).toBeVisible();
  // Hors de l'app Electron : pas de bouton d'action, et la route refuse proprement.
  await expect(page.getByRole('button', { name: 'Changer de dossier…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rechercher une mise à jour' })).toHaveCount(0);
  const csrf = (await (await page.request.get('/api/bootstrap')).json()).csrf as string;
  const refused = await page.request.post('/api/desktop', {
    headers: { 'X-DS-Studio': csrf, 'Content-Type': 'application/json' },
    data: { action: 'check-update' },
  });
  expect(refused.status()).toBe(409);
  await page.getByRole('button', { name: '← Retour' }).click();
  await expect(page.locator('.bar .project')).toHaveText('Marmotte');
  await page.goto('/');
  await page.getByRole('button', { name: 'Réglages' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DS-Studio');
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
  await expect(page.getByRole('button', { name: '1 écart(s) · Corrections' })).toBeVisible();
  const mascot = page.locator('.mascot-dock');
  await expect(mascot.locator('.mascot-badge')).toHaveText('1');
  await expect(mascot.getByRole('status')).toHaveText('1 écart(s) : regarde « Corrections ».');
  await expect.poll(() => previewVar(page, '--space-sm')).toBe('15px');
  await page.getByRole('button', { name: 'Essayer 16 px' }).click();
  await expect(page.getByText('Aucun écart', { exact: true })).toBeVisible();
  await expect(mascot.getByRole('status')).toHaveText('Plus aucun écart !');
  await expect(mascot.locator('.mascot-badge')).toHaveCount(0);
  await validate(page);
  await expect(page.getByText(/Révision 1 enregistrée/)).toBeVisible();
  await expect(mascot.getByRole('status')).toHaveText('Enregistré, bien joué !');
  await page.reload();
  await expect(page.getByLabel('space/sm', { exact: true })).toHaveValue('16');
  await expect.poll(() => previewVar(page, '--space-sm')).toBe('16px');
});

test('écarts : le compteur du haut mène aux corrections, « Tout corriger » met tout en brouillon', async ({ page }) => {
  await page.getByLabel('space/sm', { exact: true }).fill('15');
  await page.getByLabel('space/md', { exact: true }).fill('23');
  await page.getByRole('button', { name: '2 écart(s) · Corrections' }).click();
  await expect(page.locator('#corrections')).toBeInViewport();
  await page.getByRole('button', { name: 'Tout corriger (2)' }).click();
  await expect(page.getByText('Aucun écart', { exact: true })).toBeVisible();
  await expect(page.getByLabel('space/sm', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('space/md', { exact: true })).toHaveValue('24');
  await expect(page.getByText(/2 correction\(s\) mises en brouillon/)).toBeVisible();
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
  await expect.poll(() => previewVar(page, '--bg-brand')).toBe('#FF5500');
  await expect(page.getByRole('button', { name: 'Retirer space/4xl' })).toHaveCount(0);
});

test('abandon du brouillon sans écriture, puis annulation depuis l’historique', async ({ page }) => {
  const before = await revision(page);
  await page.getByLabel('space/md', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Abandonner' }).click();
  await expect(page.getByLabel('space/md', { exact: true })).not.toHaveValue('20');
  expect(await revision(page)).toBe(before);
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('tab', { name: 'Historique' }).click();
  await page.getByRole('button', { name: 'Annuler cette révision' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('code').filter({ hasText: 'color/accent/500' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Valider et enregistrer' }).click();
  await page.getByRole('button', { name: 'Design system', exact: true }).click();
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
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('tab', { name: 'Historique' }).click();
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
  const headers = { Origin: 'null', 'X-DS-Plugin-Contract': String(PLUGIN_CONTRACT), 'X-DS-Plugin': code };
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
  await expect.poll(() => previewVar(page, '--color-brand-600')).toBe('#2F6BFF');
});

test('comparaison côte à côte : brouillon face à l’état enregistré, inversion, rien d’écrit', async ({ page }) => {
  const before = await revision(page);
  await page.getByLabel('space/md', { exact: true }).fill('28');
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('tab', { name: 'Comparer' }).click();
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
  await expect.poll(() => spaceIn('Droite')).toBe('28px');
  await expect.poll(() => spaceIn('Gauche')).not.toBe('28px');
  // Écran d'exemple : les deux cadres passent au tableau de bord, chacun avec son jeu.
  await view.getByLabel('Contenu comparé').selectOption('dashboard');
  await expect(view.frameLocator('iframe[title^="Droite :"]').getByRole('heading', { name: 'Bonjour Camille' })).toBeVisible();
  await expect.poll(() => spaceIn('Droite')).toBe('28px');
  await view.getByLabel('Contenu comparé').selectOption('ds');
  await view.getByRole('button', { name: 'Inverser avant et après' }).click();
  await expect(view.getByLabel('Version avant')).toHaveValue('draft');
  // Le cadre reçoit son nouveau jeu après l'inversion : on attend, sans lecture unique.
  await expect.poll(() => spaceIn('Gauche')).toBe('28px');
  await view.getByRole('button', { name: 'Détail' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('code').filter({ hasText: 'space/md' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await page.getByRole('button', { name: 'Design system', exact: true }).click();
  await page.getByRole('button', { name: 'Abandonner' }).click();
  expect(await revision(page)).toBe(before);
});

test('écrans d’exemple : la preview passe d’un écran à l’autre, brouillon appliqué', async ({ page }) => {
  const picker = page.getByLabel('Écran de la preview');
  await expect(picker.locator('option')).toHaveText(['Composants', 'Tableau de bord', 'Formulaire', 'Article']);
  await page.getByLabel('space/md', { exact: true }).fill('20');
  const frame = page.frameLocator('iframe[title="Preview du design system"]');
  for (const [screen, heading] of [
    ['dashboard', 'Bonjour Camille'],
    ['form', 'Ton espace'],
    ['article', 'Construire un design system qui dure'],
  ]) {
    await picker.selectOption(screen);
    await expect(frame.getByRole('heading', { name: heading })).toBeVisible();
    await expect.poll(() => previewVar(page, '--space-md')).toBe('20px');
  }
  await picker.selectOption('ds');
  await expect(frame.getByRole('heading', { name: 'Les tokens en situation.' })).toBeVisible();
  await page.getByRole('button', { name: 'Abandonner' }).click();
});

test('export code : CSS, Tailwind et JSON de l’état enregistré, téléchargement', async ({ page }) => {
  await page.getByRole('button', { name: 'Exporter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Exporter le code' });
  const code = dialog.getByRole('tabpanel');
  await expect(code).toContainText(':root {');
  await expect(code).toContainText('--bg-brand: var(--color-');
  await dialog.getByRole('tab', { name: 'Tailwind v4' }).click();
  await expect(code).toContainText('@theme inline {');
  await expect(code).toContainText('--color-bg-brand: var(--bg-brand);');
  await dialog.getByRole('tab', { name: 'JSON' }).click();
  await expect(code).toContainText('"modes"');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Télécharger' }).click();
  expect((await download).suggestedFilename()).toBe('marmotte.tokens.json');
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialog).toBeHidden();
});

test('évolution : le curseur rejoue le DS révision après révision, sans rien écrire', async ({ page }) => {
  const before = await revision(page);
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await page.getByRole('tab', { name: 'Évolution' }).click();
  const view = page.getByRole('region', { name: 'Évolution du design system' });
  const slider = view.getByLabel('Révision affichée');
  await expect(slider).toHaveValue(String(before));
  const spaceSm = () =>
    view
      .frameLocator('iframe[title^="Écran DS à"]')
      .locator('.ds')
      .first()
      .evaluate((el) => el.style.getPropertyValue('--space-sm'));
  await slider.fill('1'); // r1 : correction de space/sm à 16 px (parcours « boucle »)
  await expect(view.getByRole('status')).toContainText('space/sm');
  await expect.poll(spaceSm).toBe('16px');
  await slider.fill('0');
  await expect(view.getByRole('status')).toContainText('Départ du projet');
  await expect.poll(spaceSm).not.toBe('16px');
  await view.getByRole('button', { name: 'Rejouer l’historique' }).click();
  await expect(view.getByRole('button', { name: 'Mettre en pause' })).toBeVisible();
  await expect(slider).toHaveValue('1', { timeout: 3000 });
  await view.getByRole('button', { name: 'Mettre en pause' }).click();
  // Frise de la barre du haut : une marche ouvre l'évolution à sa version.
  const step = page.getByRole('button', { name: /^Voir v\d+ dans l’évolution$/ }).first();
  const v = /v(\d+)/.exec((await step.getAttribute('aria-label'))!)![1];
  await step.click();
  await expect(slider).toHaveValue(v);
  expect(await revision(page)).toBe(before);
});

test('planche : sections repliables, gardées au rechargement, rouvertes par la sous-barre', async ({ page }) => {
  const type = page.getByRole('button', { name: 'Typographie', exact: true });
  await expect(type).toHaveAttribute('aria-expanded', 'true');
  await type.click();
  await expect(type).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#h-type-body')).toBeHidden();
  await page.reload();
  await expect(type).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('navigation', { name: 'Sections du design system' }).getByRole('button', { name: /Typographie/ }).click();
  await expect(type).toHaveAttribute('aria-expanded', 'true');
  // Repliée, une section garde ses brouillons en vue.
  await page.getByLabel('space/md', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Tout replier' }).click();
  await expect(page.locator('.fold-body:visible')).toHaveCount(0);
  await expect(page.locator('section', { has: page.locator('#h-scales') }).getByText('1 en brouillon')).toBeVisible();
  await page.getByRole('button', { name: 'Tout déplier' }).click();
  await expect(page.locator('.fold[aria-expanded="false"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Abandonner' }).click();
});
