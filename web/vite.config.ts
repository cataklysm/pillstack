import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const apiPort = process.env.PILLSTACK_PORT ?? '5174';

export default defineConfig({
  plugins: [vue()],
  server: {
    // Dev server stays on the loopback interface, like the API.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
