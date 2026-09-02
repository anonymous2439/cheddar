import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/cheddar/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // mgba-wasm's threaded runtime requires a cross-origin-isolated page
    // (crossOriginIsolated === true) to use SharedArrayBuffer at all —
    // see web/src/games/pokefirered/emulator.ts. Applied site-wide rather
    // than scoped to just this route (Vite has no easy per-route header
    // hook); every other backend call already goes through CORS-mode
    // fetch/axios, which COEP doesn't block.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
}))
