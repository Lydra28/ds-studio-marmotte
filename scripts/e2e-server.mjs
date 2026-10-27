// Serveur des tests navigateur : copie jetable de l'instance Marmotte (seed,
// fiches et configuration seulement), pour ne jamais écrire dans projects/marmotte/.
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// Mode multi-projets, comme l'atelier : un dossier de projets jetable.
const dir = await mkdtemp(path.join(tmpdir(), 'ds-e2e-'));
const marmotte = path.join(dir, 'projects', 'marmotte');
await mkdir(marmotte, { recursive: true });
for (const file of ['design-system.tokens.json', 'project.config.json', 'components.json'])
  await copyFile(path.join('projects/marmotte', file), path.join(marmotte, file));
const child = spawn(
  process.execPath,
  ['--import', 'tsx', 'app/server/index.ts', `--projects=${path.join(dir, 'projects')}`],
  {
    // Jamais d'appel OpenRouter ni GitHub en test, même si un .env local contient une clé.
    env: { ...process.env, PORT: '4318', OPENROUTER_API_KEY: '', GITHUB_TOKEN: '' },
    stdio: 'inherit',
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill('SIGTERM'));
child.on('exit', async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exit(code ?? 0);
});
