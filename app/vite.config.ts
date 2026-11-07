import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  // The Worker only accepts this address (ALLOWED_ORIGIN in worker/wrangler.toml).
  // If the port is taken, stop with an error instead of quietly using another one.
  server: { port: 5173, strictPort: true },
})
