// Prépare le transfert d'une version acceptée vers Figma, sans contacter Figma.
// Usage : npx tsx scripts/figma-payload.ts projects/marmotte/versions/v4.json
// Refuse (code 1) si l'empreinte recalculée ne correspond pas au fichier.
// Même calcul que le plugin DS-Studio (app/server/figma-payload.ts).
import { readFile } from 'node:fs/promises';
import { buildFigmaPayload } from '../app/server/figma-payload.js';

const file = process.argv[2];
if (!file) {
  console.error('Chemin de la version acceptée requis.');
  process.exit(1);
}
try {
  console.log(JSON.stringify(buildFigmaPayload(JSON.parse(await readFile(file, 'utf8'))), null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
