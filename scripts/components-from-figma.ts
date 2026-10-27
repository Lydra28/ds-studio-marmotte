// Convertit la liste brute des composants lus dans Figma par l'agent (lecture
// seule, voir le README du projet) en fichier de fiches importable dans
// l'atelier : noms corrigés par la nomenclature, propriétés ramenées à
// Variant / State / Size, tokens liés repris. Ne contacte pas Figma.
// Usage : npx tsx scripts/components-from-figma.ts brut.json [--project=projects/marmotte] > fiches.json
// Le rapport des corrections sort sur stderr ; rien n'est écrit dans l'atelier.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { componentsFromFigma, rawComponentsSchema } from '../app/server/figma-components.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Chemin du fichier brut requis.');
  process.exit(1);
}
const raw = rawComponentsSchema.parse(JSON.parse(await readFile(file, 'utf8')));

// Fiches déjà présentes dans l'atelier : jamais écrasées par l'import.
const project = args.find((a) => a.startsWith('--project='))?.slice(10);
const existing = new Set<string>();
if (project)
  for (const [source, pick] of [
    [path.join(project, '.ds-studio/state.json'), (j: any) => j.set?.components],
    [path.join(project, 'components.json'), (j: any) => j],
  ] as const)
    try {
      for (const name of Object.keys(pick(JSON.parse(await readFile(source, 'utf8'))) ?? {}))
        existing.add(name);
      break;
    } catch {
      /* Source absente : essayer la suivante. */
    }

const { file: result, report } = componentsFromFigma(raw, existing);
console.log(JSON.stringify(result, null, 2));
console.error(report.join('\n'));
