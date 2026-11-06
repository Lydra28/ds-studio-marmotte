import { gunzipSync } from 'node:zlib';

// Archive d'un dépôt GitHub (plan GitHub, G2) : `tar.gz` lu en mémoire,
// jamais écrit sur le disque. Entrée non fiable : décompression bornée
// (bombe), chemins relatifs vérifiés, liens et fichiers spéciaux ignorés.
// Formats lus : ustar, en-têtes étendus pax (`x`, chemins longs) et GNU (`L`)
// ; en-tête global pax (`g`, commit de GitHub) ignoré.

export interface TarLimits {
  /** Taille maximale décompressée de l'archive entière. */
  maxBytes: number;
  /** Nombre maximal de fichiers retenus. */
  maxFiles: number;
  /** Taille maximale d'un fichier retenu (au-delà : ignoré, compté). */
  maxFileBytes: number;
  /** Fichiers à garder, chemin relatif à la racine du dépôt. */
  accept: (path: string) => boolean;
}

export interface TarFile {
  path: string;
  text: string;
}

export interface TarResult {
  files: TarFile[];
  /** Entrées écartées : filtre, trop grosses, liens, chemins refusés. */
  skipped: { filtered: number; tooLarge: number; links: number; unsafe: number };
  /** Plus de `maxFiles` fichiers acceptés : la suite n'est pas lue. */
  truncated: boolean;
}

const BLOCK = 512;

const field = (buf: Buffer, at: number, len: number) => {
  const raw = buf.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString('utf8');
};
const octal = (buf: Buffer, at: number, len: number) => {
  const text = field(buf, at, len).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Archive illisible : taille d’entrée invalide.');
  return text ? parseInt(text, 8) : 0;
};

// Enregistrements pax : « <longueur> <clé>=<valeur>\n ».
function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8');
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(' ', at);
    if (space === -1) break;
    const len = Number(text.slice(at, space));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = text.slice(space + 1, at + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    at += len;
  }
  return null;
}

// Chemin relatif sûr, sans le dossier racine `<owner>-<repo>-<sha>/` de GitHub.
export function repoPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length < 2 || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return null;
  if (parts.some((p) => p === '..')) return null;
  return parts.slice(1).join('/');
}

export function readTarGz(archive: Buffer, limits: TarLimits): TarResult {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxBytes });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(String((e as Error).message))
        ? `Dépôt trop volumineux (plus de ${Math.round(limits.maxBytes / 1e6)} Mo décompressés) : choisis un sous-dossier.`
        : 'Archive du dépôt illisible.',
    );
  }
  const result: TarResult = { files: [], skipped: { filtered: 0, tooLarge: 0, links: 0, unsafe: 0 }, truncated: false };
  let at = 0;
  let longName: string | null = null;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const dataAt = at + BLOCK;
    const next = dataAt + Math.ceil(size / BLOCK) * BLOCK;
    if (dataAt + size > tar.length) throw new Error('Archive du dépôt tronquée.');
    const data = tar.subarray(dataAt, dataAt + size);
    at = next;
    if (type === 'g') continue;
    if (type === 'x') {
      longName = paxPath(data);
      continue;
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    if (type === '5') continue;
    if (type === '1' || type === '2') {
      result.skipped.links++;
      continue;
    }
    if (type !== '0' && type !== '7') continue;
    const path = repoPath(name);
    if (!path) {
      result.skipped.unsafe++;
      continue;
    }
    if (!limits.accept(path)) {
      result.skipped.filtered++;
      continue;
    }
    if (size > limits.maxFileBytes) {
      result.skipped.tooLarge++;
      continue;
    }
    if (result.files.length >= limits.maxFiles) {
      result.truncated = true;
      break;
    }
    result.files.push({ path, text: data.toString('utf8') });
  }
  return result;
}
