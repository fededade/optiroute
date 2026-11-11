import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// In `vite dev` le funzioni serverless in /api (retell-call, call-status,
// directions) NON esistono: girano solo su Vercel. Senza questo plugin, una
// fetch a /api/... farebbe provare a Vite a trasformare il file .ts con
// esbuild, generando l'errore "Invalid loader value".
// Qui rispondiamo 404 a tutte le richieste /api/* in locale: i servizi che
// le usano hanno già un fallback (es. il routing ripiega su OSRM), mentre le
// chiamate Retell vanno testate sul deploy Vercel.
const ignoreApiRoutesInDev = (): Plugin => ({
  name: 'ignore-api-routes-in-dev',
  configureServer(server) {
    // Middleware registrato PRIMA di quelli interni di Vite, così intercetta
    // /api prima che Vite provi a trasformare il file.
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.startsWith('/api/')) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          error: 'Le funzioni /api girano solo su Vercel, non nel server di sviluppo locale.',
        }))
        return
      }
      next()
    })
  },
})

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), ignoreApiRoutesInDev()],
})
