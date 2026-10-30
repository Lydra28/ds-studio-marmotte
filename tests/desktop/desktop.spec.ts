import { test, expect, _electron as electron } from '@playwright/test';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Fumée de l'app desktop : serveur embarqué, projets d'un dossier jetable,
// réglages isolés, port de test (4312). Aucune clé : OpenRouter et GitHub coupés.
const PORT = 4312;
const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

test('app desktop : ouvre l’atelier, un projet, puis rend le port en quittant', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ds-desktop-'));
  const projects = path.join(temp, 'projets');
  await fs.cp('projects/marmotte', path.join(projects, 'marmotte'), {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.ds-studio`),
  });
  // DS_STUDIO_EXE : l'exe empaqueté (release/win-unpacked/DS-Studio.exe) au lieu des sources.
  const exe = process.env.DS_STUDIO_EXE;
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
    // propose ses actions ; depuis les sources, les mises à jour sont désactivées.
    const settings = await (await page.request.get(`http://127.0.0.1:${PORT}/api/settings`)).json();
    expect(settings.desktop).toBe(true);
    expect(settings.app.name).toBe(exe ? 'DS-Studio' : 'DS-Studio Dev');
    expect(settings.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(settings.projects).toBe(projects);
    expect(settings.update?.status).toBe('disabled');
    expect(JSON.stringify(settings)).not.toMatch(/sk-|ghp_|OPENROUTER|GITHUB_TOKEN/);
    await page.getByRole('button', { name: 'Réglages' }).click();
    await expect(page.getByRole('button', { name: 'Changer de dossier…' })).toBeVisible();
    await expect(page.getByText(exe ? /mise à jour/i : 'Mises à jour désactivées depuis les sources.')).toBeVisible();
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
  await fs.rm(temp, { recursive: true, force: true });
});
