import { readFileSync } from 'node:fs';

// Données du site lues au build : adresse de l'API, base des
// téléchargements, catalogue des prix (GET /v1/billing/catalog, seule
// source des montants, server/billing.ts). Prix changés : redéployer le site.
export const API = (import.meta.env.PUBLIC_API_URL || 'https://api.design-system-studio.fr').replace(/\/+$/, '');
export const DOWNLOADS = (import.meta.env.PUBLIC_DOWNLOAD_URL || 'https://pub-6b486982e0584424a2fdaa8f2d9f0a1a.r2.dev/stable').replace(
  /\/+$/,
  '',
);

// Page Figma Community du plugin, posée au build dès sa publication (en revue).
export const FIGMA_PLUGIN = import.meta.env.PUBLIC_FIGMA_PLUGIN_URL || '';

export interface Catalog {
  currency: 'eur';
  mode: 'live' | 'test' | 'off';
  pro: { amountCents: number; interval: 'month'; includedCents: number };
  packs: { pack: string; amountCents: number }[];
  welcomeCents: number;
  generationCents: { wall: number; assistant: number };
}

let cached: Promise<Catalog> | undefined;
// `SITE_CATALOG_FILE` : catalogue JSON local, réservé aux tests (aucun réseau).
export function loadCatalog(): Promise<Catalog> {
  cached ??= (async () => {
    const file = process.env.SITE_CATALOG_FILE;
    if (file) return JSON.parse(readFileSync(file, 'utf8')) as Catalog;
    const res = await fetch(`${API}/v1/billing/catalog`);
    if (!res.ok) throw new Error(`Catalogue illisible (${res.status}) sur ${API} : prix non publiés, build arrêté.`);
    return (await res.json()) as Catalog;
  })();
  return cached;
}

export const euros = (cents: number) =>
  cents % 100 === 0
    ? `${cents / 100} €`
    : `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// Fichiers à nom fixe poussés par release.yml à chaque version (lot 7).
export const INSTALLERS = [
  {
    os: 'Windows',
    file: 'DS-Studio-Setup.exe',
    detail: 'Windows 10 ou 11, 64 bits.',
    note: 'L’installateur n’est pas encore signé : Windows affiche « Windows a protégé votre ordinateur ». Clique « Informations complémentaires », puis « Exécuter quand même ».',
  },
  {
    os: 'macOS',
    file: 'DS-Studio.dmg',
    detail: 'Mac à puce Apple (M1 et suivants).',
    note: 'L’app n’est pas encore signée par Apple : après l’avoir glissée dans Applications, fais clic droit sur DS-Studio puis « Ouvrir », et confirme. Les mises à jour automatiques arriveront avec la signature.',
  },
  {
    os: 'Linux',
    file: 'DS-Studio.AppImage',
    detail: 'AppImage 64 bits, sans installation.',
    note: 'Rends le fichier exécutable (clic droit → Propriétés → Autoriser l’exécution, ou chmod +x DS-Studio.AppImage), puis lance-le.',
  },
] as const;
