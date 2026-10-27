import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseStoredState } from '../app/server/store.js';

test(
  'interruption brutale pendant une rafale de commits : état et copie relisibles',
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ds-crash-'));
    const moduleUrl = new URL('../app/server/store.ts', import.meta.url).href;
    const modelUrl = new URL('../app/shared/model.ts', import.meta.url).href;
    const seedUrl = new URL(
      '../workspace/design-system.tokens.json',
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
    import { readFile } from 'node:fs/promises';
    import { Store } from ${JSON.stringify(moduleUrl)};
    import { migrateV1Tokens } from ${JSON.stringify(modelUrl)};
    const store = new Store(process.argv[1], migrateV1Tokens(JSON.parse(await readFile(new URL(${JSON.stringify(seedUrl)}), 'utf8'))));
    await store.init();
    for (let i = 0; i < 2000; i++) {
      await store.commit(store.propose(i, [{ key: 'space/sm', mode: 'default', value: i % 2 ? 8 : 12 }]).id);
      if (i === 4) process.send?.('ready');
    }
    setInterval(() => {}, 1000);
  `,
        directory,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await exited;
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () =>
        reject(new Error('Enfant arrêté avant écriture : ' + stderr)),
      );
    });
    child.kill('SIGKILL');
    await exited;
    const state = parseStoredState(
      await readFile(path.join(directory, 'state.json'), 'utf8'),
    );
    const previous = parseStoredState(
      await readFile(path.join(directory, 'state.previous.json'), 'utf8'),
    );
    assert(state.revision >= 5);
    assert([state.revision, state.revision - 1].includes(previous.revision));
  },
);
