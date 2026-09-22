import { expect, test, type Page } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
const visitCard = (page: Page) => page.getByRole("article", { name: "落地页访问次数", exact: true });

async function acquisition(page: Page, start = "2026-09-02", end = "2026-09-08", compared = true) {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  await expect(visitCard(page)).toBeVisible({ timeout: 20000 });
  const view = await page.evaluate(() => window.history.state.acquisitionView);
  view.filters = { ...view.filters, start, end, comparison: compared ? "previous" : "none" };
  view.mixed = false;
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7&view=${encodeURIComponent(JSON.stringify(view))}`);
  await expect(visitCard(page).locator("time.metric-summary__date")).toHaveAttribute("datetime", end);
  await expect(visitCard(page).locator(".metric-summary__context")).not.toContainText("所选日");
}

test("末日值不随起日变化，两个日基准不随区间比较错位", async ({ page }) => {
  test.setTimeout(60000);
  await acquisition(page);
  const card = visitCard(page);
  await expect(card.locator(".dashboard-metric-card__value strong")).toHaveText("89,804");
  const before = await card.locator(".metric-summary__comparisons").innerText();
  await expect(card.locator(".metric-summary__comparison")).toHaveCount(2);
  await card.getByRole("button", { name: /较前一天/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("2026-09-07");
  await expect(page.getByRole("tooltip")).toContainText("2026-09-08");
  await page.mouse.move(0, 0);
  await card.getByRole("button", { name: /较上周同日/ }).click();
  await expect(page.getByRole("tooltip")).toContainText("2026-09-01");
  await page.keyboard.press("Escape");
  await expect(card.locator(".metric-summary__supplementary")).toContainText("621,804");
  await acquisition(page, "2026-08-01");
  await expect(card.locator(".dashboard-metric-card__value strong")).toHaveText("89,804");
  expect(await card.locator(".metric-summary__comparisons").innerText()).toBe(before);
  await expect(card.locator(".metric-summary__supplementary")).not.toContainText("621,804");
  await expect(card.locator(".dashboard-metric-card__trend-context")).toHaveCount(0);
  await card.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(card.getByRole("region", { name: /表格视图/ })).toBeVisible();
});

test("关闭比较清除双日变化和虚线，比率保留周期整体而非合计均值", async ({ page }) => {
  await acquisition(page, "2026-09-02", "2026-09-08", false);
  const card = visitCard(page);
  await expect(card.locator(".metric-summary__comparison")).toHaveCount(0);
  await expect(card.locator(".dashboard-metric-card__trend-context")).toHaveCount(0);
  const ratio = page.getByRole("article", { name: "访问-下载点击转化率", exact: true });
  await expect(ratio.locator(".metric-summary__supplementary")).toContainText("周期转化率");
  await expect(ratio.locator(".metric-summary__supplementary")).not.toContainText(/周期合计|日均/);
  await acquisition(page);
  await expect(ratio.locator(".metric-summary__comparisons")).toContainText("百分点");
});

for (const board of ["5.2", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15"]) {
  test(`共享末日卡在看板 ${board} 沿用，固定批次保持实际语义`, async ({ page }) => {
    await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board}`);
    if (board === "5.11") await page.locator("summary").filter({ hasText: "提交、下单、回调与到账指标" }).click();
    await expect(page.locator(".dashboard-metric-card.has-daily-reading").first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    if (board === "5.8") {
      const retention = page.getByRole("article", { name: "注册用户D1留存率", exact: true });
      await expect(retention.locator(".metric-summary__context")).toContainText(/批次|注册/);
      await expect(retention.getByRole("button", { name: /较前一天/ })).toHaveCount(0);
    }
  });
}

test("末日摘要与两组比较在桌面及窄屏可读，切图表不跳高", async ({ page }) => {
  await acquisition(page);
  for (const width of [1800, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const card = visitCard(page);
    await card.scrollIntoViewIfNeeded();
    const start = await card.boundingBox();
    for (const name of ["表格", "柱状", "折线"]) {
      await card.getByRole("tab", { name, exact: true }).click();
      expect((await card.boundingBox())!.height).toBe(start!.height);
    }
    for (const child of await card.locator(".metric-summary__primary,.metric-summary__comparisons,.metric-summary__supplementary").all()) {
      const box = await child.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(start!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(start!.x + start!.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await card.screenshot({ path: `/private/tmp/ypbi-daily-card-${width}.png` });
  }
});
