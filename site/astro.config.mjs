import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

// Site statique (Cloudflare Pages). Aucun script ni style en ligne : la CSP
// de dist/_headers (scripts/headers.mjs) n'autorise que des fichiers du site.
export default defineConfig({
  site: 'https://design-system-studio.fr',
  output: 'static',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never', format: 'directory' },
  devToolbar: { enabled: false },
  vite: {
    // Commentaires légaux (/*! … */) gardés dans le JS publié : notice MIT
    // du moteur des requins (site/src/scripts/ocean.ts), exigée par la licence.
    build: { assetsInlineLimit: 0, rolldownOptions: { output: { comments: { legal: true } } } },
    // Tokens de la DA (app/client/da.css) et logo (desktop/icon.png) lus à
    // leur place dans le dépôt : une seule source pour l'app et le site.
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  },
});
