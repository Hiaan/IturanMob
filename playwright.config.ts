import { defineConfig, devices } from "@playwright/test";

/**
 * Testes end-to-end (Playwright).
 *
 *   pnpm test:e2e
 *
 * Sobe o painel em http://localhost:3200 apontando para um banco PRÓPRIO de e2e
 * (E2E_DATABASE_URL, padrão finance_ai_e2e), que é recriado a cada execução.
 * Para usar um servidor já em execução: E2E_BASE_URL=http://localhost:3000 pnpm test:e2e
 * (nesse caso o servidor precisa de ALLOW_REGISTRATION=true).
 * Navegador alternativo: PW_CHROMIUM_PATH=/caminho/do/chromium.
 */
const PORT = Number(process.env.E2E_PORT ?? 3200);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
export const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://finance:finance@localhost:5432/finance_ai_e2e?schema=public";

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    locale: "pt-BR",
    timezoneId: "America/Recife",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next dev -p ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        env: {
          DATABASE_URL: E2E_DATABASE_URL,
          ALLOW_REGISTRATION: "true",
          AI_DEFAULT_PROVIDER: "LOCAL",
          TRANSCRIPTION_PROVIDER: "none",
          WHATSAPP_ENABLE_SIMULATOR: "true",
          RATE_LIMIT_LOGIN_PER_15MIN: "1000",
          RATE_LIMIT_API_PER_MIN: "5000",
          LOG_LEVEL: "warn",
        },
      },
});
