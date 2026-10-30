// App desktop DS-Studio : le serveur de l'atelier tourne dans un processus
// utilitaire d'Electron, la fenêtre l'affiche comme le navigateur aujourd'hui.
// Installée : port 4310 (celui que le plugin Figma connaît), réglages dans
// %APPDATA%\DS-Studio. Depuis les sources (`npm run desktop`) : « DS-Studio Dev »,
// port 4311, réglages et dossier de projets à part, pour cohabiter avec l'app
// installée (le plugin a un champ d'adresse ; son manifeste autorise 4310 à 4312,
// 4312 restant aux tests). Aucun secret dans l'exe ; le `.env` du dossier des
// réglages reste lu s'il existe (usage avancé, jamais demandé à l'utilisateur).
import { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess } from 'electron';
import electronUpdater from 'electron-updater';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpdateConfig } from './update-config.mjs';

const { autoUpdater } = electronUpdater;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = !app.isPackaged;
const appName = dev ? 'DS-Studio Dev' : 'DS-Studio';
const PORT = Number(process.env.DS_STUDIO_DESKTOP_PORT || (dev ? 4311 : 4310));
const atelier = `http://127.0.0.1:${PORT}`;
const icon = path.join(root, 'desktop/icon.png');

// Réglages : %APPDATA%\DS-Studio (Dev depuis les sources, ou dossier imposé par les tests).
app.setPath('userData', process.env.DS_STUDIO_USER_DATA || path.join(app.getPath('appData'), appName));
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// En développement, le `.env` du dépôt ; installée, celui des réglages (facultatif).
const envFile = () => (app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(root, '.env'));

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
async function readSettings() {
  return readJson(settingsFile()) ?? {};
}
async function writeSettings(settings) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

// Dossier des projets : choisi une fois, gardé. Le dossier par défaut reçoit
// l'exemple Marmotte s'il est vide, pour ne pas ouvrir un atelier nu.
async function chooseProjects(cancelLabel) {
  const fallback = path.join(app.getPath('documents'), appName);
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: appName,
    message: 'Où ranger tes projets ?',
    detail: `Par défaut : ${fallback}\nOu un dossier qui contient déjà des projets DS-Studio (par exemple studio/projects).`,
    buttons: ['Dossier par défaut', 'Choisir un dossier…', cancelLabel],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 2) return null;
  let folder = fallback;
  if (response === 1) {
    const picked = await dialog.showOpenDialog({ title: 'Dossier des projets', properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return null;
    folder = picked.filePaths[0];
  }
  await fs.mkdir(folder, { recursive: true });
  const entries = (await fs.readdir(folder)).filter((n) => !n.startsWith('.'));
  // Garde : un dossier plein sans aucun projet (le Bureau, Documents…) est
  // sûrement une erreur de clic ; un projet = un sous-dossier avec son jeu de tokens.
  const projects = entries.filter((n) => existsSync(path.join(folder, n, 'design-system.tokens.json')));
  if (entries.length && !projects.length) {
    const { response: again } = await dialog.showMessageBox({
      type: 'warning',
      title: appName,
      message: 'Ce dossier ne contient aucun projet DS-Studio.',
      detail: `${folder}\nChoisis le dossier qui contient tes projets (par exemple studio/projects), ou un dossier vide pour repartir de zéro.`,
      buttons: ['Choisir un autre dossier', 'Utiliser quand même', cancelLabel],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (again === 0) return chooseProjects(cancelLabel);
    if (again === 2) return null;
  }
  if (!entries.length && existsSync(path.join(root, 'projects/marmotte')))
    await fs.cp(path.join(root, 'projects/marmotte'), path.join(folder, 'marmotte'), { recursive: true });
  await writeSettings({ ...(await readSettings()), projects: folder });
  return folder;
}

let server;
let window;
let quitting = false;

// Mises à jour automatiques (electron-updater) : flux décrit par
// desktop/build/update.json (écrit au build), vérification au lancement puis
// toutes les 6 h, téléchargement en arrière-plan, jamais de redémarrage forcé.
// L'état est poussé au serveur, qui le montre dans Réglages.
const updateConfig = resolveUpdateConfig({
  platform: process.platform,
  packaged: app.isPackaged,
  build: readJson(path.join(root, 'desktop/build/update.json')),
});
let updateState = {
  status: updateConfig.enabled ? 'idle' : 'disabled',
  version: app.getVersion(),
  channel: updateConfig.channel,
  reason: updateConfig.reason,
  available: null,
  progress: null,
  message: null,
  checkedAt: null,
};
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  server?.postMessage({ type: 'desktop-state', update: updateState });
}
if (updateConfig.enabled) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({ provider: 'generic', url: updateConfig.url, channel: updateConfig.channel });
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', message: null }));
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', available: info.version, progress: 0 }));
  autoUpdater.on('update-not-available', () =>
    setUpdate({ status: 'up-to-date', available: null, progress: null, checkedAt: new Date().toISOString() }),
  );
  autoUpdater.on('download-progress', (p) => setUpdate({ status: 'downloading', progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) =>
    setUpdate({ status: 'ready', available: info.version, progress: 100, checkedAt: new Date().toISOString() }),
  );
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: e?.message || 'Mise à jour impossible.' }));
}
async function checkUpdates() {
  if (!updateConfig.enabled || updateState.status === 'checking' || updateState.status === 'downloading') return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setUpdate({ status: 'error', message: e?.message || 'Mise à jour impossible.' });
  }
}
async function installUpdate() {
  if (updateState.status !== 'ready') return;
  quitting = true;
  await stopServer();
  autoUpdater.quitAndInstall();
}

// Captures du Mur des DA : fenêtre cachée, session à part (aucun cookie de l'atelier).
async function capture(url) {
  if (!/^https?:\/\//.test(url)) throw new Error('Lien http(s) attendu.');
  const page = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { partition: 'ds-capture', sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await Promise.race([page.loadURL(url), new Promise((_, reject) => setTimeout(() => reject(new Error('Site trop lent.')), 20_000))]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return (await page.webContents.capturePage()).toJPEG(62);
  } finally {
    page.destroy();
  }
}

// Actions demandées depuis la vue Réglages de l'atelier.
const desktopActions = {
  'choose-projects': () => changeProjects(),
  'check-update': () => checkUpdates(),
  'install-update': () => installUpdate(),
};

function startServer(projects) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(root, 'desktop/build/server.mjs'), [], {
      serviceName: 'DS-Studio serveur',
      stdio: 'pipe',
      env: {
        ...process.env,
        DS_STUDIO_ROOT: root,
        DS_STUDIO_PROJECTS: projects,
        DS_STUDIO_ENV_FILE: envFile(),
        DS_STUDIO_APP_NAME: appName,
        DS_STUDIO_APP_VERSION: app.getVersion(),
        PORT: String(PORT),
      },
    });
    let log = '';
    child.stdout?.on('data', (d) => (log += d));
    child.stderr?.on('data', (d) => (log += d));
    child.on('message', (message) => {
      if (message?.type === 'ready') {
        child.postMessage({ type: 'desktop-state', update: updateState });
        resolve(child);
      }
      if (message?.type === 'capture')
        capture(message.url).then(
          (data) => child.postMessage({ type: 'capture-result', id: message.id, data: new Uint8Array(data) }),
          (e) => child.postMessage({ type: 'capture-result', id: message.id, error: e.message }),
        );
      if (message?.type === 'desktop' && desktopActions[message.action]) void desktopActions[message.action]();
    });
    child.once('exit', (code) => {
      if (server === child) server = undefined;
      reject(new Error(log.trim() || `Serveur arrêté (code ${code}).`));
    });
  });
}

function stopServer() {
  const child = server;
  server = undefined;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.postMessage({ type: 'stop' });
  });
}

async function run(projects) {
  try {
    server = await startServer(projects);
  } catch (e) {
    const busy = /port occupé|déjà verrouillé/i.test(e.message);
    dialog.showErrorBox(
      `${appName} ne démarre pas`,
      busy
        ? `Un autre DS-Studio utilise déjà le port ${PORT} ou ce dossier de projets (un « npm start » ?). Ferme-le, puis relance l'app.\n\n${e.message}`
        : e.message,
    );
    app.quit();
    return false;
  }
  return true;
}

function openWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: appName,
    icon,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  // Liens externes (PR GitHub, docs) dans le navigateur ; la fenêtre reste sur l'atelier.
  const external = (url) => /^https?:\/\//.test(url) && void shell.openExternal(url);
  window.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${atelier}/`)) return;
    event.preventDefault();
    external(url);
  });
  // Le titre de la page est « DS-Studio » : l'app Dev garde son nom à elle.
  window.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(appName);
  });
  window.on('closed', () => (window = undefined));
  void window.loadURL(`${atelier}/`);
}

async function changeProjects() {
  const folder = await chooseProjects('Annuler');
  if (!folder) return;
  await stopServer();
  if (await run(folder)) window?.loadURL(`${atelier}/`);
}

function menu() {
  return Menu.buildFromTemplate([
    {
      label: 'Fichier',
      submenu: [
        { label: 'Réglages', click: () => window?.loadURL(`${atelier}/#/reglages`) },
        { label: 'Changer de dossier de projets…', click: () => void changeProjects() },
        { label: 'Rechercher une mise à jour', enabled: updateConfig.enabled, click: () => void checkUpdates() },
        { label: 'Ouvrir le dossier des réglages', click: () => void shell.openPath(app.getPath('userData')) },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: 'Outils de développement' }]),
        { type: 'separator' },
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
  ]);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    // Aucune permission (caméra, micro, notifications…) sauf l'écriture dans le
    // presse-papiers (bouton « Copier » de l'export) ; jamais sa lecture.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(permission === 'clipboard-sanitized-write'),
    );
    Menu.setApplicationMenu(menu());
    const projects =
      process.env.DS_STUDIO_PROJECTS || (await readSettings()).projects || (await chooseProjects('Quitter'));
    if (!projects) return app.quit();
    if (await run(projects)) {
      openWindow();
      if (updateConfig.enabled) {
        setTimeout(() => void checkUpdates(), 5_000);
        setInterval(() => void checkUpdates(), 6 * 60 * 60 * 1000);
      }
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    void stopServer().then(() => app.quit());
  });
}
