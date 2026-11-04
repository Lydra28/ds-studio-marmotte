import { defineConfig } from '@playwright/test';
// Site vitrine (lot 7) : build hors ligne puis service statique avec les en-têtes de Cloudflare Pages.
export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 15_000,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4330', trace: 'retain-on-failure' },
  webServer: {
    command: 'node tests/site/server.mjs',
    // Racine de studio/ (npm run test:site), pas le dossier de cette configuration.
    cwd: process.cwd(),
    url: 'http://127.0.0.1:4330/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
