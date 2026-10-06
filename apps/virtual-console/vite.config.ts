import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the console proxies API and console WebSocket calls to a local FBRX Virtual.
const target = process.env.FBRX_V_URL ?? 'https://127.0.0.1:9443';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/v1': { target, ws: true, changeOrigin: true, secure: false },
      '/healthz': { target, secure: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
});
