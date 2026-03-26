import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        // Skip waiting immediately so the new SW takes over on install
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            // App's own navigation requests: network-first so deploys are picked up fast
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'pages-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
      manifest: {
        name: 'CocoNot - Coconut Allergy Checker',
        short_name: 'CocoNot',
        description: 'Scan barcodes and ingredients to check for coconut',
        theme_color: '#0f172a',
        background_color: '#f9fafb',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    // Allow any Host header so Caddy reverse proxy and LAN access work.
    // Only affects the dev server — no impact on production builds.
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
})
