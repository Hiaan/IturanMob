import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = { "@": path.resolve(__dirname, "src") };

const testEnv = {
  NODE_ENV: "test",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://finance:finance@localhost:5432/finance_ai_test?schema=public",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  APP_URL: "http://localhost:3000",
  SESSION_SECRET: "test-session-secret-0123456789abcdefghijklmnop",
  ENCRYPTION_KEY: "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1sb25nISE=",
  LOG_LEVEL: "silent",
  STORAGE_DIR: "./storage-test",
  AI_DEFAULT_PROVIDER: "LOCAL",
  TRANSCRIPTION_PROVIDER: "none",
  ALLOW_REGISTRATION: "true",
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          env: testEnv,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          env: testEnv,
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 30_000,
          hookTimeout: 60_000,
          globalSetup: ["tests/integration/global-setup.ts"],
        },
      },
    ],
  },
});
