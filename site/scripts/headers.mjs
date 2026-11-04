// Écrit dist/_headers (Cloudflare Pages) après le build : CSP stricte, API du
// serveur DS-Studio seule destination des requêtes du navigateur.
import { writeFileSync } from 'node:fs';

const api = new URL(process.env.PUBLIC_API_URL || 'https://api.design-system-studio.fr').origin;
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  `connect-src ${api}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
writeFileSync(
  new URL('../dist/_headers', import.meta.url),
  `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n`,
);
console.log('dist/_headers écrit, API', api);
