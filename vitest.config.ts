import { defineConfig } from 'vitest/config'

// Test dei servizi puri (nessun DOM): girano in Node, fuori dal tsc della build.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // blocca qualunque richiesta di rete verso servizi veri (vedi tests/setup.ts)
    setupFiles: ['tests/setup.ts'],
  },
})
