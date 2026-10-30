import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveUpdateConfig } from '../../desktop/update-config.mjs';

// Fumée de l'app desktop : serveur embarqué, projets d'un dossier jetable,
// réglages isolés, port de test (4312). Aucune clé : OpenRouter et GitHub coupés.
const PORT = 4312;
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

// L'app empaquetée est copiée hors du dépôt avant d'être lancée : depuis
// release/, Node remonte jusqu'à studio/node_modules et masque une dépendance
// absente du paquet (electron-updater manquant dans l'app installée, 2026-10-30).
async function isolate(exe: string, temp: string) {
  const source = path.resolve(exe);
  let unpacked = path.dirname(source);
  while (path.basename(path.dirname(unpacked)) !== 'release') {
    const parent = path.dirname(unpacked);
    if (parent === unpacked) throw new Error(`DS_STUDIO_EXE doit pointer dans release/ : ${exe}`);
    unpacked = parent;
  }
  const copy = path.join(temp, 'app');
  await fs.cp(unpacked, copy, { recursive: true, verbatimSymlinks: true });
  return path.join(copy, path.relative(unpacked, source));
}

test('app desktop : ouvre l’atelier, un projet, puis rend le port en quittant', async () => {
  test.setTimeout(180_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-desktop-'));
  const projects = path.join(temp, 'projets');
  await fs.cp('projects/marmotte', path.join(projects, 'marmotte'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.ds-studio`),
  });
  // DS_STUDIO_EXE : l'exe empaqueté (release/win-unpacked/DS-Studio.exe) au lieu des sources.
  const exe = process.env.DS_STUDIO_EXE ? await isolate(process.env.DS_STUDIO_EXE, temp) : undefined;
  // Linux en CI : le bac à sable setuid de Chromium n'est pas installable sur le
  // runner ; la fenêtre garde son propre bac à sable (webPreferences.sandbox).
  const exeArgs = exe && process.platform === 'linux' ? ['--no-sandbox'] : [];
  const app = await electron.launch({
    ...(exe ? { executablePath: path.resolve(exe), args: exeArgs } : { args: ['desktop/main.mjs'] }),
    env: {
      ...process.env,
      DS_STUDIO_PROJECTS: projects,
      DS_STUDIO_USER_DATA: path.join(temp, 'reglages'),
      DS_STUDIO_DESKTOP_PORT: String(PORT),
      OPENROUTER_API_KEY: '',
      GITHUB_TOKEN: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle(/DS-Studio/);
    // Réglages : l'app se décrit (version, dossier choisi, mises à jour) et
    // propose ses actions. Mises à jour : même décision que l'app
    // (desktop/update-config.mjs, flux écrit au build dans desktop/build/update.json) :
    // désactivées depuis les sources, sans flux ou sur Mac non signé ; sinon
    // l'app part vérifier le flux (CI de release : flux R2 réel).
    const settings = await (await page.request.get(`http://127.0.0.1:${PORT}/api/settings`)).json();
    expect(settings.desktop).toBe(true);
    expect(settings.app.name).toBe(exe ? 'DS-Studio' : 'DS-Studio Dev');
    expect(settings.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(settings.projects).toBe(projects);
    const build = JSON.parse(await fs.readFile('desktop/build/update.json', 'utf8').catch(() => 'null'));
    const updates = resolveUpdateConfig({ platform: process.platform, packaged: !!exe, build });
    if (updates.enabled) {
      expect(['idle', 'checking', 'downloading', 'up-to-date', 'error']).toContain(settings.update?.status);
    } else {
      expect(settings.update?.status).toBe('disabled');
      expect(settings.update?.reason).toBe(updates.reason);
    }
    expect(JSON.stringify(settings)).not.toMatch(/sk-|ghp_|OPENROUTER|GITHUB_TOKEN/);
    await page.getByRole('button', { name: 'Réglages' }).click();
    await expect(page.getByRole('button', { name: 'Changer de dossier…' })).toBeVisible();
    if (updates.enabled) {
      await expect(page.getByRole('button', { name: 'Rechercher une mise à jour' })).toBeVisible();
    } else {
      await expect(page.getByText(updates.reason ?? '')).toBeVisible();
    }
    await page.getByRole('button', { name: '← Retour' }).click();
    await page.getByRole('button', { name: /Marmotte r\d+/ }).click();
    await expect(page.locator('.bar .project')).toHaveText('Marmotte');
    // La fenêtre est isolée : aucun accès Node côté page.
    expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined');
    // Rien d'autre que l'atelier dans la fenêtre (file: : refusé sans ouvrir de navigateur).
    await page.evaluate(() => (location.href = 'file:///'));
    await expect(page).toHaveURL(new RegExp(`^http://127\.0\.0\.1:${PORT}/`));
  } finally {
    await app.close();
  }
  await expect.poll(() => free(PORT)).toBe(true);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});
