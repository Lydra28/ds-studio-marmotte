// App desktop DS-Studio : le serveur de l'atelier tourne dans un processus
// utilitaire d'Electron, la fenêtre l'affiche comme le navigateur aujourd'hui.
// Mêmes ports (4310, relais 4320, plugin Figma), mêmes fichiers de projets.
// Les secrets restent dans le `.env` des réglages de l'utilisateur, jamais dans l'exe.
import { app, BrowserWindow, dialog, Menu, session, shell, utilityProcess } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 4310 : le port que le plugin Figma connaît (les tests en prennent un autre).
const PORT = Number(process.env.DS_STUDIO_DESKTOP_PORT || 4310);
const atelier = `http://127.0.0.1:${PORT}`;
const icon = path.join(root, 'desktop/icon.png');

// Réglages : %APPDATA%\DS-Studio (ou dossier imposé par les tests).
app.setPath('userData', process.env.DS_STUDIO_USER_DATA || path.join(app.getPath('appData'), 'DS-Studio'));
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
// En développement, le `.env` du dépôt ; installée, celui des réglages.
const envFile = () => (app.isPackaged ? path.join(app.getPath('userData'), '.env') : path.join(root, '.env'));

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
async function writeSettings(settings) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

// Dossier des projets : choisi une fois, gardé. Le dossier par défaut reçoit
// l'exemple Marmotte s'il est vide, pour ne pas ouvrir un atelier nu.
async function chooseProjects(cancelLabel) {
  const fallback = path.join(app.getPath('documents'), 'DS-Studio');
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'DS-Studio',
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
      title: 'DS-Studio',
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
        PORT: String(PORT),
      },
    });
    let log = '';
    child.stdout?.on('data', (d) => (log += d));
    child.stderr?.on('data', (d) => (log += d));
    child.on('message', (message) => {
      if (message?.type === 'ready') resolve(child);
      if (message?.type === 'capture')
        capture(message.url).then(
          (data) => child.postMessage({ type: 'capture-result', id: message.id, data: new Uint8Array(data) }),
          (e) => child.postMessage({ type: 'capture-result', id: message.id, error: e.message }),
        );
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
      'DS-Studio ne démarre pas',
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
    title: 'DS-Studio',
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
        { label: 'Changer de dossier de projets…', click: () => void changeProjects() },
        { label: 'Ouvrir le dossier des réglages (.env)', click: () => void shell.openPath(app.getPath('userData')) },
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
    if (await run(projects)) openWindow();
  });
  app.on('window-all-closed', () => app.quit());
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    void stopServer().then(() => app.quit());
  });
}
