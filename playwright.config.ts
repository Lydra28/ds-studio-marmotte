import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  fullyParallel: false,
  // Parcours courts : un test bloqué échoue vite au lieu d'allonger la CI.
  timeout: 15_000,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4318',
    viewport: { width: 1600, height: 1100 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4318/api/state',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
