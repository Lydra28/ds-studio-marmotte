// Sonde d'un dépôt (plan GitHub, G2) : `npx tsx scripts/repo-scan.ts <owner/repo> [branche] [--subdir=x] [--settings=dossier]`.
// Lit le dépôt avec la connexion GitHub faite dans l'app (Réglages → GitHub)
// et n'affiche que des chiffres : jamais un nom de fichier, une valeur ni une
// ligne de code. Faite pour mesurer un dépôt privé sans que son contenu
// passe par un agent. Fermer l'app avant : un jeton renouvelé ici ou là-bas
// invalide l'autre.
import os from 'node:os';
import path from 'node:path';
import { GithubAuth } from '../app/server/github-auth.js';
import { readRepo } from '../app/server/repo-read.js';
import { summarizeScan } from '../app/shared/repo-scan.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [repo, ref] = args.filter((a) => !a.startsWith('--'));
if (!repo) {
  console.error('Usage : npx tsx scripts/repo-scan.ts <owner/repo> [branche] [--subdir=dossier] [--settings=dossier-des-reglages]');
  process.exit(2);
}

const appData =
  process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const settings = flag('settings') ?? process.env.DS_STUDIO_SETTINGS_DIR ?? path.join(appData, 'DS-Studio Dev');

// Outil du poste : la garde Pro a joué à la connexion dans l'app (G1).
const auth = await GithubAuth.open({ dir: settings, isPro: () => true, autoPoll: false });
if (auth.status().status !== 'connected') {
  console.error(`GitHub non connecté dans ce dossier de réglages (${settings}) : connecte-le dans l'app, Réglages → GitHub.`);
  process.exit(1);
}
try {
  const started = Date.now();
  let branch = ref;
  if (!branch) branch = (await auth.repos()).find((r) => r.fullName.toLowerCase() === repo.toLowerCase())?.defaultBranch ?? 'main';
  const read = await readRepo(auth, repo, branch, flag('subdir'));
  const summary = summarizeScan(read.scan);
  console.log(
    JSON.stringify(
      {
        sonde: 'repo-scan G2',
        secondes: Math.round((Date.now() - started) / 100) / 10,
        sousDossier: !!read.subdir,
        fichiersLus: summary.files,
        fichiersAvecOccurrences: summary.filesWithOccurrences,
        ecartes: read.skipped,
        fichiersTronques: read.filesTruncated,
        occurrencesTronquees: summary.truncated,
        tailwind: summary.tailwind,
        parDetecteur: summary.byDetector,
        enDurParType: summary.hardcoded,
        parContexte: summary.byVia,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
