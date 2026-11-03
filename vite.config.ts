import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: ['es2022', 'safari17'],
    sourcemap: true,
    rollupOptions: { output: { manualChunks(id) { if (/node_modules\/(?:@codemirror|@lezer)\//.test(id)) return 'editor'; } } },
  },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
