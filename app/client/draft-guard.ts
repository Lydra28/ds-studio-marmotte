// Brouillon gardé en sessionStorage, donc perdu à la fermeture de l'app :
// avertir avant (choix de Romain du 2026-11-18). Dans un navigateur, le
// beforeunload pose la question ; dans Electron, `desktop/main.mjs` lit
// `__dsHasDraft` et pose la sienne avant toute fermeture.
const DRAFT_KEY = /^ds-(drafts|structure|components):/;

type Store = Pick<Storage, 'length' | 'key' | 'getItem'>;

/** Un brouillon non vide, tous projets confondus (valeurs, structure, fiches). */
export function hasDraft(storage: Store) {
  for (let i = 0; i < storage.length; i++) {
    const name = storage.key(i);
    if (!name || !DRAFT_KEY.test(name)) continue;
    const raw = storage.getItem(name);
    if (raw && raw !== '[]') return true;
  }
  return false;
}

/** Brouillon présent ? Lu aussi par Electron avant d'arrêter le serveur. */
function present(target: Window) {
  try {
    return hasDraft(target.sessionStorage);
  } catch {
    return false; // Stockage indisponible : aucun brouillon gardé, rien à perdre.
  }
}

/**
 * Refuse le déchargement de la page tant qu'un brouillon existe, et expose
 * `__dsHasDraft` à `desktop/main.mjs` (question posée avant de quitter,
 * d'installer une mise à jour ou de changer de dossier).
 */
export function guardDrafts(target: Window = window) {
  (target as Window & { __dsHasDraft?: () => boolean }).__dsHasDraft = () => present(target);
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!present(target)) return;
    e.preventDefault();
    e.returnValue = '';
  };
  target.addEventListener('beforeunload', onBeforeUnload);
  return () => target.removeEventListener('beforeunload', onBeforeUnload);
}
