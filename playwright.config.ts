import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 45000,
  use: { baseURL: "http://127.0.0.1:4088", headless: true },
  webServer: {
    command: "npx tsx tests/demo-server.ts",
    url: "http://127.0.0.1:4088/health",
    reuseExistingServer: false,
    timeout: 60000,
  },
  reporter: "list",
});
