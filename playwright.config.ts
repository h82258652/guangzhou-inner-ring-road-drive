import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke test. Uses the bundled Chromium by default; set
 * PW_CHANNEL=msedge (or chrome) to use an installed browser instead.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
