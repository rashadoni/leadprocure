import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', timeout: 90_000, retries: 0, workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'https://app.leadprocure.test:39443', headless: true,
    viewport: { width: 1440, height: 1000 },
    // Certificate verification stays enabled. fresh-tls.sh installs the test CA
    // in this ephemeral worker's NSS trust database.
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure', trace: 'off',
  },
  outputDir: process.env.FRESH_BROWSER_RESULTS_DIR,
});
