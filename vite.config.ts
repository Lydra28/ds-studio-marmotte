import { defineConfig } from 'vite';
export default defineConfig({
  // Three.js (mascotte, environ 560 Ko) est chargé à part, à la demande : seuil relevé pour lui.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 600 },
  server: { host: '127.0.0.1' },
});
