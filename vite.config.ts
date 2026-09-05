import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Security response headers on every dev response (prod-server.mjs does
// the same in production).
const SECURITY_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
}

function securityHeadersPlugin() {
  return {
    name: 'security-headers',
    configureServer(server: { middlewares: { use: (cb: unknown) => void } }) {
      server.middlewares.use((_req: unknown, res: unknown, next: () => void) => {
        const nodeRes = res as { setHeader: (k: string, v: string) => void }
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
          nodeRes.setHeader(k, v)
        }
        next()
      })
    },
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [securityHeadersPlugin(), devtools(), tailwindcss(), tanstackStart(), viteReact()],
})

export default config
