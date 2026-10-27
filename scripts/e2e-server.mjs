// Serveur des tests navigateur : copie jetable de l'instance Marmotte (seed et
// configuration seulement), pour ne jamais écrire dans projects/marmotte/.
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(path.join(tmpdir(), 'ds-e2e-'));
for (const file of ['design-system.tokens.json', 'project.config.json'])
  await copyFile(path.join('projects/marmotte', file), path.join(dir, file));
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'app/server/index.ts', `--project=${dir}`],
  {
    env: { ...process.env, PORT: '4318' },
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
