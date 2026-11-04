import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: { target: 'esnext' },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
})
