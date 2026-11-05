import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  // The site lives in web/; the build lands in dist/ at the repository root.
  build: { target: 'esnext', outDir: '../dist', emptyOutDir: true },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
})
