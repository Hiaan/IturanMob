import { test } from "@playwright/test";
test("shots", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.screenshot({ path: "/tmp/claude-0/-home-user-IturanMob/5de344ad-0df6-5c48-8a04-2c7cd1c90015/scratchpad/site-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await page.screenshot({ path: "/tmp/claude-0/-home-user-IturanMob/5de344ad-0df6-5c48-8a04-2c7cd1c90015/scratchpad/site-mobile.png", fullPage: false });
});
