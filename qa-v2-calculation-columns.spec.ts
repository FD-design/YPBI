import { expect, test } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});

test("新增有效观影同口径表以实名表头承载双期输入，窄屏与缺失完整保留", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  const card = page.getByRole("article", { name: "新增用户-有效观影转化率", exact: true });
  await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增用户-有效观影转化率同口径数据表", exact: true });
  const table = dialog.getByRole("table", { name: "新增用户-有效观影转化率逐日数据", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText(["日期", "新增用户有效观影人数（分子）", "新增用户数（分母）", "当前值", "对比日期", "对比新增用户有效观影人数（分子）", "对比新增用户数（分母）", "对比值", "差值", "状态"]);
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(table.locator("tbody tr").first().locator("td")).toHaveCount(10);
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText("待接入");
  await expect(table.locator("tbody tr").first().locator("td").nth(6)).toHaveText("待接入");
  await expect(table.locator("tbody tr").first()).toContainText("计算输入待接入");
  await expect(table.locator("tbody")).not.toContainText("新增用户有效观影人数");
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(dialog.getByRole("button", { name: "关闭数据表", exact: true })).toBeVisible();
    await dialog.screenshot({ path: `/private/tmp/ypbi-calculation-columns-${width}.png` });
  }
  await dialog.getByRole("button", { name: "关闭数据表", exact: true }).click();
  await expect(card.getByRole("button", { name: "查看同口径数据表", exact: true })).toBeFocused();
});
