import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    'DS-Studio nécessite Node.js 22.12 ou supérieur (LTS conseillé).',
  );
  process.exit(1);
}
if (!existsSync(path.join(root, 'node_modules/tsx/dist/cli.mjs'))) {
  console.error(
    'Dépendances absentes. Dans le dossier DS-Studio : npm ci, puis npm run build.',
  );
  process.exit(1);
}
if (!existsSync(path.join(root, 'dist/index.html'))) {
  console.error('Interface non compilée. Dans DS-Studio : npm run build.');
  process.exit(1);
}
const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.join(root, 'app/server/index.ts')],
  { cwd: root, stdio: 'inherit', env: process.env },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    // Windows transmet déjà Ctrl+C aux deux processus de cette console.
    // child.kill('SIGINT') y serait une terminaison forcée, pas un transfert.
    if (process.platform !== 'win32') child.kill(signal);
  });
child.on('error', () => {
  console.error('Impossible de démarrer le serveur local.');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
