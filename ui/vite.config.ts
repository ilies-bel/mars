import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = process.env.MARS_UI_API_BASE ?? 'http://127.0.0.1:7777'

/**
 * The directory Vite must be allowed to serve font files from.
 *
 * When the UI is developed inside a git worktree (`.mars/worktrees/<task-id>/ui`),
 * `node_modules` is a symlink farm pointing back into the MAIN checkout's pnpm
 * store, so `@fontsource/inter` physically lives outside the worktree. Vite's
 * default `server.fs.allow` is the workspace root it detects from `root`, and
 * in a worktree that detection stops at the worktree — a worktree's `.git` is a
 * file, not a directory, which defeats the usual walk. Every @fontsource
 * `.woff2` then answers 403.
 *
 * The failure is silent and total: @fontsource ships metric-override "Inter
 * Fallback" faces that load fine, so the page renders at plausible metrics in a
 * system face while `document.fonts.check('12px Inter')` is false. Nothing
 * warns; every tracking and leading decision is simply being made against the
 * wrong typeface.
 *
 * Resolve the package for real and allow the OUTERMOST `node_modules` above it,
 * so the whole store is reachable (jetbrains-mono included) whatever the
 * package manager's layout.
 */
const fontStoreRoot = ((): string => {
  const req = createRequire(import.meta.url)
  let dir: string
  try {
    dir = path.dirname(req.resolve('@fontsource/inter/package.json'))
  } catch {
    return path.resolve(__dirname, '..')
  }
  let outermost: string | null = null
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (path.basename(d) === 'node_modules') outermost = d
  }
  return outermost ?? path.resolve(__dirname, '..')
})()

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
    port: 7173,
    // Fail immediately when the port is already in use (default strictPort:false
    // silently switches to the next free port, which causes mars-ui to keep running
    // on the wrong port while the frontend becomes unreachable). With strictPort:true,
    // Vite exits non-zero so mars-ui.mjs propagates the error rather than silently
    // falling back to the stale prebuilt dist bundle.
    // Port 7173 avoids collision with Vite's universal default (5173) used by
    // other tools on the operator's machine (e.g. daniel-admin).
    strictPort: true,
    fs: {
      // Explicit, not widened-by-default: the worktree root plus wherever the
      // real dependency tree lives. See fontStoreRoot above.
      allow: [path.resolve(__dirname, '..'), fontStoreRoot],
    },
    proxy: {
      '/api': API,
      '/arc': API,
      '/events': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
