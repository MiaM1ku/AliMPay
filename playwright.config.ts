import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "bun run build && DATA_DIR=$(mktemp -d /tmp/alimpay-e2e.XXXXXX) NODE_ENV=development PORT=3100 PUBLIC_BASE_URL=http://127.0.0.1:3100 bun start",
    url: "http://127.0.0.1:3100/healthz",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
