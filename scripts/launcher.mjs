import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireLease,
  readRecord,
  control,
  alive,
  delay,
  openBrowser,
} from './runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(
  process.env.DS_STUDIO_DATA_DIR || path.join(root, '.ds-studio'),
);
const port = Number(process.env.PORT || 4310);
const env = {
  ...process.env,
  PATH:
    path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
};

async function existingLauncher() {
  try {
    const record = await readRecord(directory, 'launcher');
    return record?.root === root &&
      record?.directory === directory &&
      (await control(record))
      ? record
      : null;
  } catch {
    return null;
  }
}
function launcherURL(record) {
  return `http://127.0.0.1:${record.port}/#${record.token}`;
}
async function launch() {
  let record = await existingLauncher();
  if (!record) {
    record = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--serve'],
        {
          cwd: root,
          env,
          detached: true,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const timeout = setTimeout(() => {
        child.disconnect();
        child.unref();
        reject(
          new Error(
            'Le panneau de lancement ne répond pas. Relancez DS-Studio.',
          ),
        );
      }, 12000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('message', (message) => {
        clearTimeout(timeout);
        child.disconnect();
        child.unref();
        if (message.error) reject(new Error(message.error));
        else resolve(message);
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        if (code)
          reject(new Error('Le panneau de lancement n’a pas pu démarrer.'));
      });
    });
  }
  if (process.argv.includes('--no-open')) {
    console.log(launcherURL(record));
    return;
  }
  await openBrowser(launcherURL(record));
  const origin = `http://127.0.0.1:${record.port}`;
  const headers = {
    Authorization: `Bearer ${record.token}`,
    'Content-Type': 'application/json',
  };
  const state = await (await fetch(origin + '/api/status', { headers })).json();
  if (state.ready && state.phase === 'arrêté' && !state.busy) {
    await fetch(origin + '/api/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ open: true }),
    });
    for (let i = 0; i < 220; i++) {
      const current = await (
        await fetch(origin + '/api/status', { headers })
      ).json();
      if (!current.busy) {
        break;
      }
      await delay(100);
    }
  }
}

async function serve() {
  let lease;
  try {
    lease = await acquireLease(directory, 'launcher', { root, directory });
  } catch (error) {
    // Un double-clic concurrent peut lire le fichier avant sa publication complète.
    for (let i = 0; i < 40; i++) {
      const old = await existingLauncher();
      if (old) {
        process.send?.(old);
        return;
      }
      await delay(100);
    }
    throw error;
  }
  let phase = 'arrêté';
  let error = '';
  let busy = false;
  let output = '';
  let serverChild;
  let operation;
  let observedServer = null;
  let generation = 0;

  async function serverRecord() {
    const record = await readRecord(directory, 'server');
    if (!record) return null;
    if (!alive(typeof record === 'number' ? record : record.pid)) return null;
    if (record.root !== root || record.directory !== directory)
      throw new Error(
        'Verrou existant non identifiable (ancienne version ou autre projet). Aucun processus arrêté. Voir le guide de lancement.',
      );
    if (await control(record)) return record;
    if (alive(record.pid))
      throw new Error(
        'Le PID enregistré ne répond pas comme DS-Studio. Aucun arrêt forcé. Réessayez ou consultez le guide.',
      );
    return null;
  }
  async function serverLog() {
    try {
      const file = path.join(directory, 'server-output.txt');
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return '';
      const handle = await fs.open(file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(10000, stat.size));
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          Math.max(0, stat.size - buffer.length),
        );
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      return '';
    }
  }
  async function requirements() {
    const dependencies =
      existsSync(path.join(root, 'node_modules/tsx/dist/cli.mjs')) &&
      existsSync(path.join(root, 'node_modules/vite/bin/vite.js'));
    const built = existsSync(path.join(root, 'dist/index.html'));
    let stale = false;
    if (built) {
      const buildTime = (await fs.stat(path.join(root, 'dist/index.html')))
        .mtimeMs;
      async function newer(dir) {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name);
          if (
            entry.isDirectory()
              ? await newer(file)
              : (await fs.stat(file)).mtimeMs > buildTime
          )
            return true;
        }
        return false;
      }
      stale = await newer(path.join(root, 'app'));
      for (const file of [
        'package.json',
        'package-lock.json',
        'vite.config.ts',
        'tsconfig.json',
      ])
        stale ||= (await fs.stat(path.join(root, file))).mtimeMs > buildTime;
    }
    return {
      dependencies,
      built,
      stale,
      ready: dependencies && built && !stale,
    };
  }
  async function status() {
    let record = observedServer;
    if (!busy) {
      const observedGeneration = generation;
      try {
        record = await serverRecord();
        if (busy || observedGeneration !== generation) return status();
        observedServer = record;
        if (record) {
          if (!error) phase = 'actif';
        } else if (phase === 'actif') {
          phase = 'erreur';
          error =
            'DS-Studio s’est arrêté de façon inattendue. Cliquez sur Démarrer.';
        }
      } catch (e) {
        if (busy || observedGeneration !== generation) return status();
        observedServer = record = null;
        phase = 'erreur';
        error = e.message;
      }
    }
    return {
      phase,
      error,
      busy,
      ...(await requirements()),
      url: record ? `http://127.0.0.1:${record.port}` : null,
      pid: record?.pid ?? null,
      output: output || (await serverLog()),
      backup: existsSync(path.join(directory, 'state.previous.json')),
    };
  }
  async function stopServer() {
    const record = await serverRecord();
    if (record) {
      if (!(await control(record, 'stop')))
        throw new Error('Identité DS-Studio non confirmée : arrêt refusé.');
      for (let i = 0; i < 100; i++) {
        const current = await readRecord(directory, 'server');
        if ((!current || current.id !== record.id) && !alive(record.pid)) {
          phase = 'arrêté';
          observedServer = null;
          return;
        }
        await delay(100);
      }
      throw new Error(
        'L’arrêt propre dépasse 10 secondes. Aucun processus tué de force. Réessayez.',
      );
    }
    phase = 'arrêté';
    observedServer = null;
  }
  async function startServer() {
    const record = await serverRecord();
    if (record) {
      observedServer = record;
      phase = 'actif';
      return;
    }
    if (!(await requirements()).ready)
      throw new Error(
        'Préparez l’application avec le bouton Installer / compiler après avoir lu la confirmation.',
      );
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error('PORT doit être compris entre 1024 et 65535.');
    phase = 'démarrage';
    output = '';
    const logFile = path.join(directory, 'server-output.txt');
    const stat = await fs.lstat(logFile).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error('Journal serveur non sûr : fichier préservé.');
    const log = await fs.open(logFile, 'w', 0o600);
    let failure;
    try {
      serverChild = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(root, 'app/server/index.ts')],
        {
          cwd: root,
          env: { ...env, PORT: String(port), DS_STUDIO_DATA_DIR: directory },
          detached: true,
          stdio: ['ignore', log.fd, log.fd],
          windowsHide: true,
        },
      );
      serverChild.on('error', (e) => {
        failure = e;
      });
      serverChild.unref();
    } finally {
      await log.close();
    }
    for (let i = 0; i < 200; i++) {
      if (failure || serverChild.exitCode !== null)
        throw new Error(
          (await serverLog()).trim() || failure?.message || 'Échec du serveur.',
        );
      try {
        const live = await readRecord(directory, 'server');
        if (live?.pid === serverChild.pid && (await control(live))) {
          phase = 'actif';
          observedServer = live;
          return;
        }
      } catch {
        /* Fichier en cours de publication ; ne pas conclure avant la disponibilité. */
      }
      await delay(100);
    }
    // On conserve le handle et le verrou ; ne jamais démarrer un second serveur.
    throw new Error(
      'Démarrage trop long. Patientez et actualisez le panneau, ou cliquez sur Arrêter.',
    );
  }
  async function npmCLI() {
    const bin = path.dirname(process.execPath);
    const candidates = [
      path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
      path.resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
      '/usr/share/nodejs/npm/bin/npm-cli.js',
    ];
    for (const candidate of candidates)
      if (existsSync(candidate)) return candidate;
    // Homebrew et certains gestionnaires publient npm comme lien vers un
    // npm-cli.js situé hors du préfixe du binaire Node réellement exécuté.
    for (const folder of [bin, ...(env.PATH || '').split(path.delimiter)]) {
      try {
        const target = await fs.realpath(path.join(folder, 'npm'));
        if (path.basename(target) === 'npm-cli.js') return target;
      } catch {
        /* Emplacement facultatif. */
      }
    }
    throw new Error(
      'npm est absent de cette installation Node. Installez la distribution officielle Node.js LTS (avec npm), puis relancez.',
    );
  }
  async function runNpm(args) {
    const cli = await npmCLI();
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const capture = (chunk) => {
        output = (output + chunk.toString()).slice(-10000);
      };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                'Préparation échouée. Consultez le journal ci-dessous, vérifiez Internet et réessayez.',
              ),
            ),
      );
    });
  }
  async function action(name, body) {
    error = '';
    if (name === 'prepare') {
      if (body.confirm !== true)
        throw new Error(
          'Confirmation explicite requise avant installation et compilation.',
        );
      if (await serverRecord())
        throw new Error('Arrêtez DS-Studio avant de préparer l’application.');
      phase = 'démarrage';
      output = '';
      const preparation = await acquireLease(directory, 'server', {
        root,
        directory,
        preparing: true,
      });
      try {
        await runNpm(['ci']);
        await runNpm(['run', 'build']);
      } finally {
        await preparation.release();
      }
      phase = 'arrêté';
    } else if (name === 'restore') {
      if (body.confirm !== true)
        throw new Error('Confirmation requise avant restauration.');
      if (await serverRecord())
        throw new Error('Arrêtez DS-Studio avant de restaurer.');
      const recovery = await acquireLease(directory, 'server', {
        root,
        directory,
        preparing: true,
      });
      try {
        output = '';
        await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              path.join(root, 'scripts/recover-state.ts'),
              directory,
            ],
            {
              cwd: root,
              env,
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          const capture = (chunk) => {
            output = (output + chunk.toString()).slice(-10000);
          };
          child.stdout.on('data', capture);
          child.stderr.on('data', capture);
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0
              ? resolve()
              : reject(new Error(output.trim() || 'Restauration impossible.')),
          );
        });
        phase = 'arrêté';
      } finally {
        await recovery.release();
      }
    } else if (name === 'start') {
      await startServer();
      if (body.open === true) {
        const record = await serverRecord();
        await openBrowser(`http://127.0.0.1:${record.port}`);
      }
    } else if (name === 'stop') await stopServer();
    else if (name === 'restart') {
      await stopServer();
      await startServer();
    } else if (name === 'open') {
      const record = await serverRecord();
      if (!record) throw new Error('Démarrez DS-Studio avant de l’ouvrir.');
      await openBrowser(`http://127.0.0.1:${record.port}`);
    } else if (name === 'quit') {
      await stopServer();
      setTimeout(async () => {
        await lease.release();
        server.close();
        server.closeIdleConnections();
      }, 200);
    } else throw new Error('Action inconnue.');
  }
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${lease.record.port}`;
    const send = (code, data) => {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      if (
        req.headers.host !== `127.0.0.1:${lease.record.port}` ||
        (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site'
      )
        return send(403, { error: 'Origine refusée.' });
      if (
        req.url === '/_studio/health' &&
        req.method === 'GET' &&
        req.headers['x-studio-control'] === lease.record.token
      ) {
        const { token, ...identity } = lease.record;
        return send(200, identity);
      }
      if (
        req.method === 'GET' &&
        ['/', '/launcher.js', '/launcher.css'].includes(req.url)
      ) {
        const file = req.url === '/' ? 'index.html' : req.url.slice(1);
        res.writeHead(200, {
          'Content-Type': file.endsWith('html')
            ? 'text/html; charset=utf-8'
            : file.endsWith('js')
              ? 'text/javascript; charset=utf-8'
              : 'text/css; charset=utf-8',
        });
        return res.end(await fs.readFile(path.join(root, 'launcher', file)));
      }
      if (req.headers.authorization !== `Bearer ${lease.record.token}`)
        return send(403, {
          error:
            'Session du lanceur absente. Double-cliquez de nouveau sur DS-Studio.',
        });
      if (req.method === 'GET' && req.url === '/api/status')
        return send(200, await status());
      const name =
        /^\/api\/(start|stop|restart|open|prepare|restore|quit)$/.exec(
          req.url || '',
        )?.[1];
      if (req.method !== 'POST' || !name)
        return send(404, { error: 'Route inconnue.' });
      if (!req.headers['content-type']?.startsWith('application/json'))
        return send(415, { error: 'JSON requis.' });
      if (busy)
        return send(409, { error: 'Une opération est en cours. Patientez.' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1024)
          return send(413, { error: 'Requête trop longue.' });
      }
      const body = JSON.parse(raw);
      // La lecture du corps cède la main : deux requêtes peuvent avoir franchi
      // le premier contrôle simultanément. Sérialiser avant tout effet.
      if (busy)
        return send(409, { error: 'Une opération est en cours. Patientez.' });
      busy = true;
      generation++;
      if (['start', 'restart', 'prepare'].includes(name)) phase = 'démarrage';
      operation = action(name, body)
        .catch((e) => {
          phase = 'erreur';
          error = e.message;
        })
        .finally(() => {
          busy = false;
        });
      send(202, { accepted: true });
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await lease.update({ port: server.address().port });
  process.send?.(lease.record);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      if (operation) await operation;
      try {
        await stopServer();
      } catch {
        /* Aucune terminaison aveugle. */
      }
      await lease.release();
      server.close();
      server.closeIdleConnections();
    });
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12))
    throw new Error(
      'Node.js 22.12 ou supérieur est requis. Installez Node.js LTS depuis nodejs.org.',
    );
  if (process.argv.includes('--serve')) await serve();
  else await launch();
} catch (error) {
  if (process.send) process.send({ error: error.message });
  else {
    console.error(error.message);
    // Le bootstrap affiche le dialogue natif et le guide si le démarrage échoue.
  }
  process.exitCode = 1;
}
