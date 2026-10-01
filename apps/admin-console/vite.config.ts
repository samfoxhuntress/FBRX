import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the console proxies API + WebSocket calls to a local control plane.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/v1': { target: process.env.FBRX_CP_URL ?? 'http://127.0.0.1:8787', ws: true, changeOrigin: true },
      '/healthz': process.env.FBRX_CP_URL ?? 'http://127.0.0.1:8787',
    },
  },
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 },
});
