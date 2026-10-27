// Qualification du vrai lanceur et du redémarrage processus. Aucun état étudiant utilisé.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecord, control } from './runtime.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await mkdtemp(
  path.join(tmpdir(), 'ds qualification avec espaces '),
);
const origin = 'http://127.0.0.1:4321';
let child;
async function start() {
  child = spawn(process.execPath, [path.join(root, 'scripts/launch.mjs')], {
    cwd: data,
    env: { ...process.env, PORT: '4321', DS_STUDIO_DATA_DIR: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const live = child;
  let log = '';
  live.stdout.on('data', (b) => (log += b.toString()));
  live.stderr.on('data', (b) => (log += b.toString()));
  for (let attempt = 0; attempt < 100; attempt++) {
    if (live.exitCode !== null)
      throw new Error('Lanceur arrêté avant disponibilité : ' + log);
    try {
      const response = await fetch(origin + '/api/state');
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Serveur indisponible : ' + log);
}
async function stop() {
  if (!child) return;
  const current = child;
  child = undefined;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      current.kill('SIGKILL');
      reject(new Error('Arrêt gracieux dépassé.'));
    }, 10000);
    current.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    if (process.platform === 'win32') {
      // child.kill('SIGTERM') est une terminaison forcée sous Windows, pas
      // l'événement Ctrl+C d'une console. Tester le vrai protocole d'arrêt.
      void readRecord(data, 'server')
        .then(async (record) => {
          if (!(await control(record, 'stop')))
            throw new Error('Arrêt HTTP privé refusé.');
        })
        .catch((e) => {
          clearTimeout(timeout);
          reject(e);
        });
    } else current.kill('SIGTERM');
  });
  await assert.rejects(() => access(path.join(data, 'server.lock')));
}
async function session() {
  const { csrf } = await (await fetch(origin + '/api/bootstrap')).json();
  return async (route, body) => {
    const response = await fetch(origin + '/api/' + route, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'X-DS-Studio': csrf,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
}
try {
  await start();
  let post = await session();
  const p = await post('proposals', {
    revision: 0,
    changes: [{ key: 'color.brand', value: '#8A3B20' }],
  });
  await post('commit', { id: p.id });
  assert.equal(
    JSON.parse(await readFile(path.join(data, 'state.json'), 'utf8')).tokens[
      'color.brand'
    ].$value,
    '#8A3B20',
  );
  // Un deuxième processus ne doit jamais partager ce dossier de données en écriture.
  const second = spawn(
    process.execPath,
    [path.join(root, 'scripts/launch.mjs')],
    {
      env: { ...process.env, PORT: '4322', DS_STUDIO_DATA_DIR: data },
      stdio: 'ignore',
    },
  );
  const code = await new Promise((r) => second.once('exit', r));
  assert.equal(code, 1);
  await stop();
  await start();
  post = await session();
  const state = await (await fetch(origin + '/api/state')).json();
  assert.equal(state.revision, 1);
  assert.equal(state.set.tokens['bg/brand'].$values.light, '#8A3B20');
  const undo = await post('undo', { revision: 1, id: p.id });
  await post('commit', { id: undo.id });
  console.log(
    'PASS: lanceur réel depuis cwd à espaces, verrou interprocessus, écriture disque, fermeture, redémarrage, persistance et annulation.',
  );
} finally {
  await stop();
  await rm(data, { recursive: true, force: true });
}
