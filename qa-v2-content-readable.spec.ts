import { expect, test } from "@playwright/test";

test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test("分组悬浮提示分当前总体、组值占比与对比期，窄屏可读", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const chart = page.getByRole("img", { name: "分目标下载日趋势", exact: true });
    await chart.scrollIntoViewIfNeeded();
    const box = (await chart.boundingBox())!;
    await chart.hover({ position: { x: box.width * .4, y: box.height * .5 } });
    const hint = page.locator(".ui-chart-tooltip .grouped-trend-tooltip");
    await expect(hint).toBeVisible();
    await expect(hint.locator(".grouped-trend-tooltip__header")).toContainText("2026-09");
    await expect(hint.locator(".grouped-trend-tooltip__header")).toContainText("总体");
    await expect(hint).toContainText("占总体");
    await expect(hint.locator(".grouped-trend-tooltip__comparison")).toContainText("对比期");
    await expect(hint).not.toContainText("完整");
    const bounds = (await hint.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await hint.screenshot({ path: `/private/tmp/ypbi-grouped-tooltip-${width}.png` });
    await page.mouse.move(0, 0);
  }
});
test("视频曝光与点击简洁标题有定义，转化说明保留公式与基数", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13`);
  const panel = page.getByRole("article", { name: "内容发现总体与位置", exact: true });
  const summary = panel.getByLabel("内容发现总体摘要", { exact: true });
  await summary.getByRole("button", { name: "视频曝光数", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("符合已登记视频曝光规则");
  await summary.getByRole("button", { name: "视频点击数", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("不是产品全局全部视频点击");
  await summary.getByRole("button", { name: "曝光-点击转化率", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("公式");
  await expect(page.getByRole("tooltip")).toContainText("分子");
  await expect(page.getByRole("tooltip")).toContainText("分母");
  await page.mouse.move(0, 0);
  await summary.getByRole("button", { name: "视频点击数", exact: true }).focus();
  await expect(page.getByRole("tooltip")).toContainText("匹配到合格视频曝光");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("匹配到合格视频曝光");
});
