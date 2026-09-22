import { expect, test, type Page } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const acquisitionUrl = `${base}/dashboards/public?design=dashboard-center&board=5.7`;

test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});
test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-compact-diagnostic-failure-${info.line}.png`, fullPage: true });
});

const landing = (page: Page) => page.getByRole("article", { name: "落地页转化诊断", exact: true });
const compact = (scope: ReturnType<typeof landing>, name: string) => scope.getByRole("article", { name: `${name}轻量诊断`, exact: true });

async function openAcquisition(page: Page, options: { compared?: boolean; mixed?: boolean; start?: string; end?: string } = {}) {
  await page.goto(acquisitionUrl);
  await expect(landing(page)).toBeVisible({ timeout: 20000 });
  const view = await page.evaluate(() => window.history.state.acquisitionView);
  view.filters = {
    ...view.filters,
    start: options.start ?? "2026-09-02",
    end: options.end ?? "2026-09-08",
    comparison: options.compared === false ? "none" : "previous"
  };
  view.mixed = options.mixed ?? false;
  await page.goto(`${acquisitionUrl}&view=${encodeURIComponent(JSON.stringify(view))}`);
  await expect(landing(page)).toBeVisible({ timeout: 20000 });
}

test("落地三量三率就地显示日末值、双日变化、小趋势和完整同口径详情", async ({ page }) => {
  await openAcquisition(page);
  const panel = landing(page);
  await expect(panel.locator(".compact-metric-reading")).toHaveCount(6);
  for (const name of ["落地页访问次数", "落地页下载点击次数", "新增用户数", "访问-下载点击转化率", "下载点击-注册转化率", "访问-注册转化率"]) {
    const item = compact(panel, name);
    await expect(item.locator(".metric-summary__context")).toHaveText("9-8（二）");
    await expect(item.locator(".metric-summary__comparison")).toHaveCount(2);
    await expect(item.locator(".compact-metric-reading__trend svg")).toBeVisible();
    await expect(item.locator(".compact-metric-reading__dates")).toContainText("09-02");
    await expect(item.locator(".compact-metric-reading__dates")).toContainText("09-08");
    await expect(item.locator(".metric-summary__supplementary")).toHaveCount(0);
  }
  const ratio = compact(panel, "访问-下载点击转化率");
  await ratio.getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "访问-下载点击转化率 · 完整趋势与数据", exact: true });
  await expect(dialog.getByRole("region", { name: "访问-下载点击转化率折线视图", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "访问-下载点击转化率逐日数据", exact: true }).getByRole("columnheader", { name: "落地页下载点击次数（分子）", exact: true })).toBeVisible();
  await expect(dialog.getByRole("table", { name: "访问-下载点击转化率逐日数据", exact: true }).getByRole("columnheader", { name: "对比落地页访问次数（分母）", exact: true })).toBeVisible();
  await expect(dialog.getByRole("table", { name: "访问-下载点击转化率逐日数据", exact: true }).getByRole("columnheader")).toHaveCount(10);
  await expect(dialog.getByRole("table", { name: "访问-下载点击转化率逐日数据", exact: true }).locator("tbody tr")).toHaveCount(7);
});

test("关闭比较后不残留变化或虚线；异常与单日均不补0", async ({ page }) => {
  await openAcquisition(page, { compared: false });
  let panel = landing(page);
  await expect(panel.locator(".metric-summary__comparison")).toHaveCount(0);
  await expect(panel.locator(".compact-metric-reading__trend path.is-comparison")).toHaveCount(0);

  await openAcquisition(page, { mixed: true });
  panel = landing(page);
  const missing = compact(panel, "落地页下载点击次数");
  await expect(missing.locator(".metric-summary__number strong")).toHaveText("—");
  await expect(missing).toContainText("行为发生日 · 事件次数");
  await expect(missing.getByRole("status").filter({ hasText: "当前数据尚未产出" })).toBeVisible();
  await expect(missing).not.toContainText(/^0$/);
  await expect(compact(panel, "访问-下载点击转化率")).toContainText("部分数据");
  const broken = compact(panel, "访问-下载点击转化率").locator(".compact-metric-reading__trend path.is-current");
  await expect(broken).toHaveAttribute("d", /^M[^M]+M[^M]+M/);
  await expect(compact(panel, "访问-下载点击转化率").locator(".compact-metric-reading__trend circle.is-current")).toHaveCount(2);

  await openAcquisition(page, { start: "2026-09-08", end: "2026-09-08" });
  panel = landing(page);
  const single = compact(panel, "落地页访问次数");
  await expect(single.locator(".compact-metric-reading__trend circle.is-current")).toHaveCount(1);
  await expect(single.locator(".compact-metric-reading__trend circle.is-comparison")).toHaveCount(1);
});

test("落地诊断三档宽度保持低高度趋势且无页面横溢出", async ({ page }) => {
  await openAcquisition(page);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const panel = landing(page);
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.locator(".compact-metric-reading__trend svg")).toHaveCount(6);
    expect(await panel.locator(".compact-metric-reading__trend svg").first().evaluate(element => Math.round(element.getBoundingClientRect().height))).toBeLessThanOrEqual(52);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.mouse.move(0, 0);
    await panel.screenshot({ path: `/private/tmp/ypbi-landing-diagnostic-${width}.png` });
    if (width === 390) {
      await panel.evaluate(element => element.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(100);
      await page.screenshot({ path: "/private/tmp/ypbi-landing-diagnostic-390-viewport.png", fullPage: false });
    }
  }
});

test("播放阶段纯数值摘要就地给出日期和变化，复用详情但不复制迷你图", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.12`);
  const panel = page.getByRole("article", { name: "播放阶段关系", exact: true });
  await expect(panel).toBeVisible({ timeout: 20000 });
  await expect(panel.locator(".compact-metric-reading")).toHaveCount(3);
  await expect(panel.locator(".compact-metric-reading__trend")).toHaveCount(0);
  for (const name of ["观影次数", "起播次数", "起播率"]) {
    const item = compact(panel, name);
    await expect(item.locator(".metric-summary__context")).toHaveText("9-8（二）");
    await expect(item.locator(".metric-summary__comparison")).toHaveCount(2);
  }
  await compact(panel, "观影次数").getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "观影次数 · 完整趋势与数据", exact: true });
  await expect(dialog.getByRole("region", { name: "观影次数折线视图", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/private/tmp/ypbi-playback-local-reading-1280.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 900 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/ypbi-playback-local-reading-390.png", fullPage: false });
});
