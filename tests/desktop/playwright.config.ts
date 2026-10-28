import { defineConfig } from '@playwright/test';
// App desktop : Playwright pilote Electron lui-même (pas de serveur web à part).
export default defineConfig({
  testDir: '.',
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
