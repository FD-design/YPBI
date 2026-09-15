import { expect, test } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});

test("活跃结构独占整行，月活卡保持普通卡宽度和自身高度", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.8`);
  const section = page.getByRole("region", { name: "活跃规模与结构", exact: true });
  const grid = section.locator(".topic-preview__grid");
  const card = grid.locator(".dashboard-metric-card");
  const structure = section.getByRole("article", { name: "活跃结构", exact: true });
  await expect(card).toHaveCount(1);
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const gridBox = await grid.boundingBox();
    const cardBox = await card.boundingBox();
    const structureBox = await structure.boundingBox();
    expect(Math.abs(structureBox!.width - gridBox!.width)).toBeLessThan(2);
    expect(Math.abs(structureBox!.x - gridBox!.x)).toBeLessThan(2);
    expect(structureBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height + 12);
    const gridColumns = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(cardBox!.width / gridBox!.width).toBeGreaterThan(gridColumns === 2 ? 0.45 : 0.99);
    expect(cardBox!.width / gridBox!.width).toBeLessThan(gridColumns === 2 ? 0.51 : 1.01);
    for (const mode of ["总体", "分组对比"]) {
      await structure.getByRole("radio", { name: mode, exact: true }).click();
      expect((await card.boundingBox())!.height).toBeCloseTo(cardBox!.height, 0);
    }
    await expect(structure.getByRole("table", { name: "活跃结构二维交叉表", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await section.screenshot({ path: `/private/tmp/ypbi-active-structure-layout-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const ordinary = page.getByRole("region", { name: "核心判断", exact: true }).locator(".dashboard-metric-card");
  await expect(ordinary).toHaveCount(4);
  const pair = await ordinary.evaluateAll(elements => elements.slice(0, 2).map(element => ({ x: element.getBoundingClientRect().x, y: element.getBoundingClientRect().y })));
  expect(pair[0].y).toBeCloseTo(pair[1].y, 0);
  expect(pair[1].x).toBeGreaterThan(pair[0].x);
});

test("消费结构继续独占整行，核心指标保留卡片栅格", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9`);
  const structure = page.getByRole("article", { name: "消费结构", exact: true });
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const structureBox = await structure.boundingBox();
    const boardBox = await page.locator(".topic-preview").boundingBox();
    expect(Math.abs(structureBox!.width - boardBox!.width)).toBeLessThan(2);
    await expect(page.getByRole("region", { name: "消费核心结果", exact: true }).locator(".dashboard-metric-card")).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("有效观影留存按摘要、留存明细、用户去向顺序阅读", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9`);
  const diagnosis = page.getByRole("region", { name: "观影与留存诊断", exact: true });
  await expect(diagnosis.locator(":scope > .topic-preview__grid .dashboard-metric-card")).toHaveCount(3);
  await expect(diagnosis.getByRole("article", { name: "有效观影留存明细", exact: true })).toBeVisible();
  await expect(diagnosis.getByRole("article", { name: "观影后用户去向", exact: true })).toBeVisible();
  expect(await diagnosis.evaluate(element => [...element.children]
    .filter(child => child.classList.contains("topic-preview__grid") || child.matches("article.dashboard-panel"))
    .map(child => child.classList.contains("topic-preview__grid") ? "留存率摘要" : child.getAttribute("aria-label"))
  )).toEqual(["留存率摘要", "有效观影留存明细", "观影后用户去向"]);
});
