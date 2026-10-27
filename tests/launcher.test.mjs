import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { alive, delay, control, readRecord } from '../scripts/runtime.mjs';

const exec = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test(
  'Linux : un ouvreur persistant ne bloque pas le lanceur',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ds opener '));
    const pidFile = path.join(temp, 'opener.pid');
    let pid;
    try {
      await fs.writeFile(
        path.join(temp, 'xdg-open'),
        '#!/bin/sh\nprintf "%s" "$$" > "$DS_OPENER_PID"\nexec /bin/sleep 15\n',
        { mode: 0o700 },
      );
      const module = pathToFileURL(
        path.join(source, 'scripts/runtime.mjs'),
      ).href;
      const start = Date.now();
      await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {openBrowser} from ${JSON.stringify(module)}; await openBrowser('http://127.0.0.1:4321');`,
        ],
        {
          env: { ...process.env, PATH: temp, DS_OPENER_PID: pidFile },
          timeout: 5000,
        },
      );
      pid = Number(await fs.readFile(pidFile, 'utf8'));
      assert.equal(alive(pid), true);
      assert(Date.now() - start < 5000);
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
      await fs.rm(temp, { recursive: true, force: true });
    }
  },
);
async function until(work, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await work();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await delay(100);
  }
  throw new Error(message + (last ? ': ' + last.message : ''));
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test(
  'Launcher : préparation et cycle complet sur de vrais processus isolés',
  { timeout: 240000 },
  async (t) => {
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ds launcher espaces '),
    );
    const root = path.join(temporary, "projet d'étude $local");
    const data = path.join(root, '.ds-studio');
    await fs.mkdir(root);
    // Aucun fichier privé, compte ou état utilisateur dans la fixture.
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
      'start.sh',
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
    const port = await freePort();
    const env = {
      ...process.env,
      PORT: String(port),
      DS_STUDIO_DATA_DIR: data,
    };
    let launcher;
    let unrelated;
    let browser;
    const children = [];
    async function launch() {
      const result = await exec(
        process.execPath,
        [path.join(root, 'scripts/launcher.mjs'), '--no-open'],
        { env, timeout: 20000 },
      );
      const url = new URL(result.stdout.trim());
      const token = url.hash.slice(1);
      url.hash = '';
      return { url: url.origin, token };
    }
    async function request(route, body, extra = {}) {
      const response = await fetch(launcher.url + '/api/' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + launcher.token,
          'Content-Type': 'application/json',
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { code: response.status, ...(await response.json()) };
    }
    async function action(name, body = {}) {
      assert.equal((await request(name, body)).code, 202);
      return until(
        async () => {
          const state = await request('status');
          return !state.busy && state;
        },
        name + ' terminé',
        120000,
      );
    }
    async function serverState() {
      return (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    }
    async function terminal(custom = {}) {
      const child = spawn(
        process.execPath,
        [path.join(root, 'scripts/launch.mjs')],
        {
          env: { ...env, ...custom },
          cwd: temporary,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let output = '';
      child.stdout.on('data', (x) => {
        output += x;
      });
      child.stderr.on('data', (x) => {
        output += x;
      });
      return {
        child,
        output: () => output,
        exited: new Promise((resolve) => child.once('exit', resolve)),
      };
    }
    try {
      await t.test(
        'premier double lancement concurrent, sans dépendances et sans installation implicite',
        async () => {
          const launches = await Promise.all([launch(), launch()]);
          assert.deepEqual(launches[0], launches[1]);
          launcher = launches[0];
          const state = await request('status');
          assert.equal(state.phase, 'arrêté');
          assert.equal(state.ready, false);
          assert.equal((await action('prepare')).phase, 'erreur');
          await assert.rejects(fs.access(path.join(root, 'node_modules')));
        },
      );
      await t.test(
        'frontière HTTP : pas de mutation sans jeton ou depuis une origine externe',
        async () => {
          assert.equal(
            (await fetch(launcher.url + '/api/start', { method: 'POST' }))
              .status,
            403,
          );
          assert.equal(
            (await request('start', {}, { Origin: 'https://example.org' }))
              .code,
            403,
          );
          const badHost = await new Promise((resolve, reject) => {
            const req = http.get(
              launcher.url + '/api/status',
              {
                headers: {
                  Host: 'localhost',
                  Authorization: 'Bearer ' + launcher.token,
                },
              },
              (res) => {
                res.resume();
                resolve(res.statusCode);
              },
            );
            req.once('error', reject);
          });
          assert.equal(badHost, 403);
        },
      );
      await t.test(
        'annulation graphique de l’installation : aucun téléchargement',
        async () => {
          const { chromium } = await import('@playwright/test');
          browser = await chromium.launch();
          const page = await browser.newPage();
          await page.goto(launcher.url + '/#' + launcher.token);
          page.once('dialog', (dialog) => dialog.dismiss());
          await page
            .getByRole('button', { name: 'Installer / compiler…' })
            .click();
          await assert.rejects(fs.access(path.join(root, 'node_modules')));
          await browser.close();
          browser = undefined;
        },
      );
      await t.test(
        'npm ci et compilation réels après confirmation seulement',
        async () => {
          const result = await action('prepare', { confirm: true });
          assert.equal(result.phase, 'arrêté', JSON.stringify(result));
          assert.equal(result.ready, true);
        },
      );
      await t.test('panneau graphique, démarrer et ouvrir', async () => {
        const { chromium } = await import('@playwright/test');
        browser = await chromium.launch();
        const page = await browser.newPage();
        // Un essai séparé exécute aussi le navigateur système et le vrai .desktop.
        await page.goto(launcher.url + '/#' + launcher.token);
        await page
          .getByRole('button', { name: 'Démarrer DS-Studio', exact: true })
          .click();
        await page
          .getByRole('status')
          .filter({ hasText: 'État : actif' })
          .waitFor();
        const link = page.getByRole('link', {
          name: 'Ouvrir directement l’atelier',
        });
        assert.equal(
          await link.getAttribute('href'),
          `http://127.0.0.1:${port}`,
        );
        const popupPromise = page.waitForEvent('popup');
        await link.click();
        const popup = await popupPromise;
        await popup.waitForLoadState();
        assert.match(await popup.title(), /DS-Studio/);
        await popup.close();
        await page.close();
        await browser.close();
        browser = undefined;
        assert.equal(
          (await request('status')).phase,
          'actif',
          'Fermer le navigateur ne doit pas arrêter le serveur',
        );
      });
      await t.test(
        'installation refusée sur serveur actif, erreur visible et données inchangées',
        async () => {
          const original = await fs.readFile(
            path.join(data, 'server.lock'),
            'utf8',
          );
          const result = await action('prepare', { confirm: true });
          assert.equal(result.phase, 'erreur');
          assert.match(result.error, /Arrêtez DS-Studio/);
          assert.equal(
            await fs.readFile(path.join(data, 'server.lock'), 'utf8'),
            original,
          );
          assert.equal((await serverState()).revision, 0);
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
        },
      );
      let saved;
      await t.test(
        'données modifiées réellement, arrêt propre et redémarrage sans changer un octet',
        async () => {
          const base = `http://127.0.0.1:${port}`;
          const { csrf } = await (await fetch(base + '/api/bootstrap')).json();
          async function post(route, body) {
            const response = await fetch(base + '/api/' + route, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-DS-Studio': csrf,
              },
              body: JSON.stringify(body),
            });
            assert.equal(response.status, 200);
            return response.json();
          }
          const proposal = await post('proposals', {
            revision: 0,
            changes: [{ key: 'color.brand', value: '#8A3B20' }],
          });
          await post('commit', { id: proposal.id });
          saved = await fs.readFile(path.join(data, 'state.json'), 'utf8');
          const oldPID = (await request('status')).pid;
          assert.equal((await action('stop')).phase, 'arrêté');
          assert.equal(alive(oldPID), false);
          await assert.rejects(fs.access(path.join(data, 'server.lock')));
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
          const newPID = (await request('status')).pid;
          assert.notEqual(newPID, oldPID);
          assert.equal((await action('restart')).phase, 'actif');
          assert.notEqual((await request('status')).pid, newPID);
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            saved,
          );
          assert.equal((await serverState()).revision, 1);
        },
      );
      await t.test(
        'onglet conservé pendant un vrai redémarrage : session renouvelée, diff sans écriture',
        async () => {
          const { chromium } = await import('@playwright/test');
          browser = await chromium.launch();
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${port}`);
          await page.getByLabel('Valeur du token').fill('#224477');
          await action('restart');
          await page
            .getByRole('button', { name: 'Proposer', exact: true })
            .click();
          await page.getByRole('dialog').waitFor();
          assert.match(await page.getByRole('dialog').textContent(), /#224477/);
          assert.equal((await serverState()).revision, 1);
          await page.keyboard.press('Escape');
          await browser.close();
          browser = undefined;
        },
      );
      await t.test(
        'plusieurs serveurs concurrents, même données et ports différents : tous refusés',
        async () => {
          const original = await fs.readFile(
            path.join(data, 'server.lock'),
            'utf8',
          );
          const contenders = await Promise.all(
            Array.from({ length: 5 }, async () =>
              terminal({ PORT: String(await freePort()) }),
            ),
          );
          for (const contender of contenders) {
            assert.equal(await contender.exited, 1);
            assert.match(contender.output(), /verrouillé/);
          }
          assert.equal(
            await fs.readFile(path.join(data, 'server.lock'), 'utf8'),
            original,
          );
          assert.equal((await serverState()).revision, 1);
        },
      );
      await t.test(
        'crash SIGKILL, verrou abandonné récupéré automatiquement et état préservé',
        async () => {
          const record = await readRecord(data, 'server');
          process.kill(record.pid, 'SIGKILL');
          await until(() => !alive(record.pid), 'PID crashé disparu');
          await fs.access(path.join(data, 'server.lock'));
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            saved,
          );
        },
      );
      await t.test(
        'crash du panneau seul : nouveau panneau, même serveur contrôlable',
        async () => {
          const serverPID = (await request('status')).pid;
          const old = await readRecord(data, 'launcher');
          process.kill(old.pid, 'SIGKILL');
          await until(() => !alive(old.pid), 'ancien contrôleur mort');
          launcher = await launch();
          assert.notEqual((await readRecord(data, 'launcher')).pid, old.pid);
          assert.equal((await request('status')).pid, serverPID);
          assert.equal((await action('stop')).phase, 'arrêté');
          assert.equal(alive(serverPID), false);
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
        },
      );
      await t.test(
        'port application occupé : erreur claire, occupant et données préservés, reprise possible',
        async () => {
          await action('stop');
          const occupant = net.createServer((socket) => socket.destroy());
          await new Promise((resolve) =>
            occupant.listen(port, '127.0.0.1', resolve),
          );
          try {
            const result = await action('start');
            assert.equal(result.phase, 'erreur');
            assert.match(result.error, /port occupé/);
            assert.equal(occupant.listening, true);
            assert.equal(
              await fs.readFile(path.join(data, 'state.json'), 'utf8'),
              saved,
            );
            await assert.rejects(fs.access(path.join(data, 'server.lock')));
          } finally {
            await new Promise((resolve) => occupant.close(resolve));
          }
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
        },
      );
      await t.test(
        'PID réutilisé / processus non DS-Studio : aucun signal, verrou conservé',
        async () => {
          await action('stop');
          unrelated = spawn(
            process.execPath,
            ['-e', 'setInterval(()=>{},1000)'],
            { stdio: 'ignore' },
          );
          await new Promise((resolve) => unrelated.once('spawn', resolve));
          const contents = JSON.stringify({
            pid: unrelated.pid,
            id: 'not-studio',
            token: 'not-studio',
            port,
            root,
            directory: data,
          });
          await fs.writeFile(path.join(data, 'server.lock'), contents);
          assert.equal((await action('stop')).phase, 'erreur');
          assert.equal((await action('start')).phase, 'erreur');
          assert.equal(alive(unrelated.pid), true);
          assert.equal(
            await fs.readFile(path.join(data, 'server.lock'), 'utf8'),
            contents,
          );
          const exit = new Promise((resolve) =>
            unrelated.once('exit', resolve),
          );
          unrelated.kill();
          await exit;
          unrelated = undefined;
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
        },
      );
      await t.test(
        'verrou historique PID mort, puis lancement terminal historique contrôlable',
        async () => {
          const record = await readRecord(data, 'server');
          await action('stop');
          await fs.writeFile(
            path.join(data, 'server.lock'),
            String(record.pid),
          );
          const run = await terminal();
          await until(async () => {
            const r = await readRecord(data, 'server');
            return r?.pid !== record.pid && (await control(r));
          }, 'ancien lanceur disponible');
          assert.equal((await request('status')).phase, 'actif');
          await action('stop');
          assert.equal(await run.exited, 0);
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            saved,
          );
        },
      );
      await t.test(
        'état corrompu : refus sans écrasement ni remise à zéro',
        async () => {
          await fs.writeFile(path.join(data, 'state.json'), '{corrompu');
          const result = await action('start');
          assert.equal(result.phase, 'erreur');
          assert.match(result.error, /original préservé/);
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            '{corrompu',
          );
          await fs.writeFile(path.join(data, 'state.json'), saved);
        },
      );
      await t.test(
        'restauration guidée, confirmation et original conservé',
        async () => {
          assert.equal((await request('status')).backup, true);
          assert.equal((await action('restore')).phase, 'erreur');
          const result = await action('restore', { confirm: true });
          assert.equal(result.phase, 'arrêté', JSON.stringify(result));
          assert.match(result.output, /Original conservé/);
          const archives = (await fs.readdir(data)).filter((file) =>
            file.startsWith('state-preserved-'),
          );
          assert.equal(archives.length, 1);
          assert.equal(
            await fs.readFile(path.join(data, archives[0]), 'utf8'),
            saved,
          );
          assert.equal(
            JSON.parse(await fs.readFile(path.join(data, 'state.json'), 'utf8'))
              .revision,
            0,
          );
          // Replacer la fixture d'origine pour poursuivre les cas V1.1 indépendants.
          await fs.writeFile(path.join(data, 'state.json'), saved);
        },
      );
      await t.test(
        'verrou mal formé ou symbolique : refus sans suppression ni écriture',
        async () => {
          const file = path.join(data, 'server.lock');
          await fs.writeFile(file, '{incomplet');
          assert.equal((await action('start')).phase, 'erreur');
          assert.equal(await fs.readFile(file, 'utf8'), '{incomplet');
          await fs.unlink(file);
          if (process.platform !== 'win32') {
            await fs.symlink(path.join(data, 'state.json'), file);
            assert.equal((await action('start')).phase, 'erreur');
            assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
            assert.equal(
              await fs.readFile(path.join(data, 'state.json'), 'utf8'),
              saved,
            );
            await fs.unlink(file);
          }
        },
      );
      await t.test(
        'deux clics Démarrer simultanés : opérations sérialisées et un seul serveur',
        async () => {
          const responses = await Promise.all([
            request('start', {}),
            request('start', {}),
          ]);
          assert.deepEqual(responses.map((r) => r.code).sort(), [202, 409]);
          const state = await until(async () => {
            const s = await request('status');
            return !s.busy && s;
          }, 'Double démarrage terminé');
          assert.equal(state.phase, 'actif', state.error);
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            saved,
          );
        },
      );
      await t.test(
        'quitter le contrôleur et relancer sans terminal ni état perdu',
        async () => {
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
          const old = await readRecord(data, 'launcher');
          assert.equal((await request('quit', {})).code, 202);
          await until(() => !alive(old.pid), 'contrôleur quitté');
          await assert.rejects(fs.access(path.join(data, 'server.lock')));
          launcher = await launch();
          assert.equal((await request('status')).phase, 'arrêté');
          {
            const result = await action('start');
            assert.equal(result.phase, 'actif', JSON.stringify(result));
          }
          assert.equal(
            await fs.readFile(path.join(data, 'state.json'), 'utf8'),
            saved,
          );
        },
      );
    } finally {
      await browser?.close();
      unrelated?.kill();
      try {
        if (launcher) {
          await action('stop');
          const record = await readRecord(data, 'launcher');
          await request('quit', {});
          if (record)
            await until(() => !alive(record.pid), 'nettoyage contrôleur');
        }
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
  },
);

test(
  'Linux : découverte Node hors PATH et absence de Node sans modification système',
  { skip: process.platform !== 'linux' },
  async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ds node discovery '));
    try {
      const bin = path.join(temp, '.local/opt/node-test-linux/bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.symlink(process.execPath, path.join(bin, 'node'));
      const script =
        '. "$1/launcher/find-node.sh"; find_node; printf "%s" "$DS_NODE"';
      const result = await exec('/bin/sh', ['-c', script, 'sh', source], {
        env: { HOME: temp, PATH: '/usr/bin:/bin' },
      });
      assert(result.stdout, 'Un Node valide doit être découvert hors PATH');
      await exec(result.stdout, [
        '-e',
        'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)',
      ]);
      // Test isolé de la branche utilisateur, même si le runner a un Node système.
      const finder = await fs.readFile(
        path.join(source, 'launcher/find-node.sh'),
        'utf8',
      );
      const isolated = path.join(temp, 'find-node.sh');
      await fs.writeFile(
        isolated,
        finder.replace(
          '/usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node',
          '/missing-node-system',
        ),
      );
      const own = await exec(
        '/bin/sh',
        ['-c', '. "$1"; find_node; printf "%s" "$DS_NODE"', 'sh', isolated],
        {
          env: { HOME: temp, PATH: '/nonexistent' },
        },
      );
      assert.equal(own.stdout, path.join(bin, 'node'));
      await fs.rm(path.join(temp, '.local'), { recursive: true });
      // Sur le MSI /usr/bin et /usr/local/bin n'ont pas de Node. Si la machine
      // de test en possède un, l'absence n'est pas simulée comme un succès.
      {
        const probe = await exec(
          '/bin/sh',
          [
            '-c',
            '. "$1"; if find_node; then printf found; else printf absent; fi',
            'sh',
            isolated,
          ],
          { env: { HOME: temp, PATH: '/nonexistent' } },
        );
        assert.equal(probe.stdout, 'absent');
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  },
);
