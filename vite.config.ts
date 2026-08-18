import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string }

export default defineConfig({
  plugins: [react()],
  // Deployed under a subpath (e.g. /notefall/ on GitHub Pages). The
  // workflow sets BASE_URL=/notefall/; local builds default to root.
  base: process.env.BASE_URL ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    // Dev-only proxy to the sample CDN. The R2 bucket's CORS allow-list
    // is locked to https://notefall.app, so a direct fetch from
    // http://localhost:* is blocked. Routing through the dev server
    // makes the request same-origin from the browser's perspective.
    // Production builds go to the CDN directly (no proxy involved).
    proxy: {
      '/samples-cdn': {
        target: 'https://samples.notefall.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/samples-cdn/, ''),
      },
    },
  },
})
