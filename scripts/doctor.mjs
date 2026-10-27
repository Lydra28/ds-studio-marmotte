import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [major, minor] = process.versions.node.split('.').map(Number);
const valid = major > 22 || (major === 22 && minor >= 12);
console.log(`Node ${process.versions.node}: ${valid ? 'OK' : '22.12+ requis'}`);
for (const file of [
  'node_modules/tsx/dist/cli.mjs',
  'dist/index.html',
  'workspace/design-system.tokens.json',
])
  console.log(
    `${file}: ${existsSync(path.join(root, file)) ? 'OK' : 'absent'}`,
  );
console.log(
  'Figma: non connecté (facultatif). Aucun fichier d’authentification consulté.',
);
console.log(
  `Données locales: ${process.env.DS_STUDIO_DATA_DIR ? 'dossier configuré' : '.ds-studio/ (ignoré par Git)'}`,
);
if (!valid) process.exitCode = 1;
