import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // onnxruntime-web (wake-word detector, lazy-loaded) locates its own .wasm/.mjs
  // siblings via import.meta.url; pre-bundling breaks that path. Excluding it
  // keeps those served same-origin from node_modules — no CDN (CSP + offline).
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8001', changeOrigin: true, ws: true },
    },
  },
})
