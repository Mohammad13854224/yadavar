import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// base './' so the built files also work inside Capacitor / Tauri (file:// style loading)
export default defineConfig({
  base: './',
  plugins: [svelte()],
  // the build's number (GitHub's run number, the same as the APK's version), shown in the settings
  define: { __BUILD__: JSON.stringify(process.env.GITHUB_RUN_NUMBER ?? 'dev') },
  // YADAVAR_API points the dev server at another backend (e.g. a test collection on another port)
  server: { port: 5173, proxy: { '/api': process.env.YADAVAR_API ?? 'http://localhost:8765' } },
})
