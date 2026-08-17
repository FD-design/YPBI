import { test, expect } from "@playwright/test";

test.use({
  viewport: { width: 1024, height: 700 },
  ignoreHTTPSErrors: true,
  channel: "chrome"
});

test("小屏模板卡片库保留完整滚动区域", async ({ page }) => {
  await page.goto("https://187.77.129.207.nip.io", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "模板管理" }).click();
  await page.getByRole("button", { name: "添加卡片", exact: true }).first().click();

  const drawer = page.locator(".asset-drawer");
  const list = page.locator(".asset-source-list");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("添加分析卡片", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "关闭卡片库" })).toBeVisible();
  await expect(list).toBeVisible();

  const layout = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY
  }));
  expect(layout.clientHeight).toBeGreaterThanOrEqual(220);
  expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
  expect(layout.overflowY).toBe("auto");

  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => list.evaluate((element) => Math.round(element.scrollTop + element.clientHeight))).toBeGreaterThanOrEqual(layout.scrollHeight - 2);

  await page.screenshot({ path: "qa/small-drawer-1024x700.png", fullPage: false });
});
