import { restorePrevious } from '../app/server/store.js';
try {
  const result = await restorePrevious(process.argv[2]);
  console.log(
    `Révision ${result.revision} restaurée. Original conservé : ${result.preserved}.`,
  );
} catch {
  console.error(
    'Restauration refusée : copie absente, invalide ou inaccessible. Aucun reset. Consultez le guide de dépannage.',
  );
  process.exitCode = 1;
}
