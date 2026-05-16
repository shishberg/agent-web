import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 4177;
const baseURL = `http://${host}:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "npm run dev",
    env: {
      HOST: host,
      PORT: String(port)
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
