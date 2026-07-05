import { defineConfig } from '@playwright/test';

// UI smoke over the real stack. Expects the API (:3000) and the web dev server (:5173)
// to be running against the seeded dev database:
//   pnpm --filter api start:dev   &   pnpm --filter web dev
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  webServer: undefined, // servers are managed externally (see header comment)
});
