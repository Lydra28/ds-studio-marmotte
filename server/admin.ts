// Administration du serveur, depuis un poste (jamais exposée en HTTP).
// `npm run admin -- keys` : paire Ed25519 pour signer les licences.
// Étape 2.6 : `grant`, `cap`, `usage` (base en `DATABASE_URL`).
import { generateKeys } from './license.js';

const [command] = process.argv.slice(2);

if (command === 'keys') {
  const keys = generateKeys();
  process.stdout.write(
    [
      '# Clé privée : variable LICENSE_PRIVATE_KEY du serveur (Render), jamais dans le dépôt.',
      keys.privateKeyPem.trimEnd(),
      '',
      '# Clé publique : embarquée dans l’app (lot 3), servie aussi par GET /v1/license/key.',
      keys.publicKeyPem.trimEnd(),
      '',
    ].join('\n'),
  );
} else {
  console.error('Usage : npm run admin -- keys');
  process.exit(command ? 1 : 0);
}
