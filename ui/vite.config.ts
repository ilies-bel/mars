import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = process.env.VITE_API_BASE ?? 'http://127.0.0.1:7777'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // Pre-bundle streamdown and its syntax-highlighting transitive dep so Vite's
  // dep-optimizer never re-hashes the "highlighted-body-<hash>.js" chunk mid-
  // session. Without this, an already-open tab references the old hashed URL
  // which 404s → dynamic import rejects → FallbackBoundary shows
  // "Couldn't load the view." (mars-4ce23622).
  optimizeDeps: {
    include: ['streamdown'],
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': API,
      '/events': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
