import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages: repo is https://github.com/harsh10101993/finance_tracker
// Served from https://harsh10101993.github.io/finance_tracker/
// Base MUST match repo name. For local dev, Vite serves at / anyway.
const isGH = process.env.GITHUB_ACTIONS === 'true'
const base = isGH ? '/finance_tracker/' : '/'

export default defineConfig({
  base,
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'],
      manifest: {
        name: 'Finance Tracker',
        short_name: 'Finance',
        description: 'Offline-first personal finance tracker. Black & white, mobile-first.',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        scope: base,
        start_url: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm,data}'],
        // PGlite ships a ~8 MB wasm + 5 MB postgres data blob — precache them so
        // the offline database also works on the very first offline load.
        maximumFileSizeToCacheInBytes: 14 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: { cacheName: 'supabase-api', expiration: { maxEntries: 50, maxAgeSeconds: 60 } }
          }
        ],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/]
      },
      devOptions: { enabled: false }
    })
  ],
  // Preview/dev are proxied through the Arena sandbox host, so allow any Host header.
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 }
})
