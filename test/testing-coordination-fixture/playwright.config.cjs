const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests', testMatch: '*.spec.cjs', timeout: 10000, workers: 1, retries: 0,
  outputDir: './reports/browser',
  reporter: [['json',{outputFile:'reports/results.json'}]],
  use: { browserName: 'chromium', headless: true, baseURL: 'http://127.0.0.1:41739' },
  webServer: {command: 'node server.cjs', url: 'http://127.0.0.1:41739', reuseExistingServer: false, timeout: 10000}
});
