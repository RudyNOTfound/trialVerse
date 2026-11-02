import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: { port: 5173, host: true },
  // Recharts is lazy-loaded in its own chunk; the remaining entry chunk is ~180 kB gzipped.
  build: { chunkSizeWarningLimit: 650 },
});
