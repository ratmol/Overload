import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `BASE_PATH` exists so the same build works on Vercel (served from `/`) and on
 * GitHub Pages (served from `/<repo>/`). Nothing else in the app knows its own
 * URL, and nothing should.
 */
export default defineConfig({
  base: process.env['BASE_PATH'] ?? '/',
  plugins: [react()],
  server: {
    // data/plan.json lives at the monorepo root, one workspace up.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
