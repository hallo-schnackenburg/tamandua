import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // The Worker only accepts this address (ALLOWED_ORIGIN in worker/wrangler.toml).
  // If the port is taken, stop with an error instead of quietly using another one.
  server: {
    port: 5173,
    strictPort: true,
    // The Worker is reached below /api on the same address, so that the session cookie is
    // an ordinary same-origin cookie. Deployed, the same mapping is a route in front of the Worker.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
})
