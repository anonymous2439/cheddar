import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/cheddar/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
}))
