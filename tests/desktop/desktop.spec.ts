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
  const app = await electron.launch({
    ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: ['desktop/main.mjs'] }),
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
