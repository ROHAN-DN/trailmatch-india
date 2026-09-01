import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 15000,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', '.next'],
    env: {
      // Dummy values so importing route modules (which transitively
      // initialise lib/supabase.ts at module load time) doesn't throw in
      // tests that never actually call Supabase. Never real credentials.
      NEXT_PUBLIC_SUPABASE_URL:      'https://placeholder.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'placeholder-anon-key',
      SUPABASE_SERVICE_ROLE_KEY:     'placeholder-service-role-key',
    },
  },
})
