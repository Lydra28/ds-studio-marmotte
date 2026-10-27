// Qualification Linux réelle : GIO lance le .desktop, xdg-open utilise le
// navigateur système. Toutes les données et sources exécutées sont une fixture.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { readRecord, control, alive, delay } from './runtime.mjs';
if (process.platform !== 'linux' || !process.env.DISPLAY)
  throw new Error('Une vraie session graphique Linux est requise.');
const exec = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ds desktop '));
const root = path.join(temporary, "projet déplacé d'étude $local");
const data = path.join(root, '.ds-studio');
const original = await fs
  .readFile(path.join(source, '.ds-studio/state.json'))
  .catch(() => null);
let browser;
let record;
async function until(work, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await work();
      if (result) return result;
    } catch {}
    await delay(100);
  }
  throw new Error(message);
}
try {
  await fs.mkdir(root);
  for (const name of [
    'app',
    'connectors',
    'scripts',
    'launcher',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    'index.html',
    'DS-Studio.desktop',
  ])
    await fs.cp(path.join(source, name), path.join(root, name), {
      recursive: true,
    });
  await fs.mkdir(path.join(root, 'workspace'));
  await fs.copyFile(
    path.join(source, 'workspace/design-system.tokens.json'),
    path.join(root, 'workspace/design-system.tokens.json'),
  );
  await fs.symlink(
    path.join(source, 'node_modules'),
    path.join(root, 'node_modules'),
  );
  await fs.cp(path.join(source, 'dist'), path.join(root, 'dist'), {
    recursive: true,
  });
  const env = {
    ...process.env,
    PATH: '/usr/bin:/bin',
    DS_STUDIO_DATA_DIR: data,
    PORT: '4327',
  };
  await exec('gio', ['launch', path.join(root, 'DS-Studio.desktop')], { env });
  record = await until(async () => {
    const r = await readRecord(data, 'launcher');
    return (await control(r)) && r;
  }, '.desktop non lancé');
  const headers = {
    Authorization: 'Bearer ' + record.token,
    'Content-Type': 'application/json',
  };
  const origin = `http://127.0.0.1:${record.port}`;
  const status = async () =>
    (await fetch(origin + '/api/status', { headers })).json();
  await until(async () => {
    const s = await status();
    return s.phase === 'actif' && !s.busy;
  }, 'Démarrage automatique .desktop échoué');
  const firstPID = (await status()).pid;
  const saved = await fs.readFile(path.join(data, 'state.json'));
  await until(
    async () => (await exec('wmctrl', ['-l'])).stdout.includes('DS-Studio'),
    'Fenêtre du navigateur système non observée',
  );
  console.log(
    'PASS : vrai .desktop via GIO, chemin déplacé avec espaces/apostrophe/$, Node absent du PATH, démarrage et navigateur système observés.',
  );
  await exec('gio', ['launch', path.join(root, 'DS-Studio.desktop')], { env });
  assert.equal((await readRecord(data, 'launcher')).pid, record.pid);
  assert.equal((await status()).pid, firstPID);
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1000, height: 1000 },
  });
  await page.goto(origin + '/#' + record.token);
  await page
    .getByRole('button', { name: 'Redémarrer DS-Studio', exact: true })
    .click();
  await until(async () => {
    const s = await status();
    return s.phase === 'actif' && !s.busy && s.pid !== firstPID;
  }, 'Redémarrage graphique échoué');
  await page
    .getByRole('button', { name: 'Ouvrir DS-Studio', exact: true })
    .click();
  await until(
    async () => !(await status()).busy,
    'Ouverture navigateur non terminée',
  );
  assert.equal((await status()).error, '');
  await page.waitForFunction(
    () => !document.querySelector('[data-action="stop"]').disabled,
  );
  await fs.mkdir(path.join(source, 'test-results'), { recursive: true });
  await page.screenshot({
    path: path.join(source, 'test-results/launcher-linux.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Arrêter DS-Studio', exact: true })
    .click();
  await until(async () => {
    const s = await status();
    return s.phase === 'arrêté' && !s.busy;
  }, 'Arrêt par bouton échoué');
  assert.deepEqual(await fs.readFile(path.join(data, 'state.json')), saved);
  // Le contrôleur existe encore : un autre double-clic doit aussi relancer.
  await exec('gio', ['launch', path.join(root, 'DS-Studio.desktop')], { env });
  await until(async () => {
    const s = await status();
    return s.phase === 'actif' && !s.busy;
  }, 'Relance au double-clic échouée');
  assert.deepEqual(await fs.readFile(path.join(data, 'state.json')), saved);
  await page
    .getByRole('button', { name: 'Arrêter et quitter le lanceur', exact: true })
    .click();
  await until(() => !alive(record.pid), 'Contrôleur non quitté');
  assert.deepEqual(await fs.readFile(path.join(data, 'state.json')), saved);
  console.log(
    'PASS : double lancement, boutons Ouvrir / Redémarrer / Arrêter / Quitter, relance automatique après arrêt, données identiques.',
  );
  if (original)
    assert.deepEqual(
      await fs.readFile(path.join(source, '.ds-studio/state.json')),
      original,
    );
} finally {
  await browser?.close();
  if (record && alive(record.pid)) {
    await fetch(`http://127.0.0.1:${record.port}/api/quit`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + record.token,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }).catch(() => {});
    await until(() => !alive(record.pid), 'Nettoyage contrôleur échoué');
  }
  await fs.rm(temporary, { recursive: true, force: true });
}
