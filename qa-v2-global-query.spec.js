import { expect, test } from "@playwright/test";
test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
const url = board => `${base}/dashboards/public?design=dashboard-center&board=${board}`;
const key = "ypbi.development-preview.query.v1";
const header = page => page.locator(".dashboard-header").first();
const date = page => header(page).getByRole("button", { name: /^日期范围：/ });
async function expectComparison(page, label) {
  const control = page.getByRole("button", { name: `对比周期：${label}`, exact: true });
  if (await control.isVisible()) return;
  await header(page).getByRole("button", { name: "更多筛选", exact: true }).click();
  await expect(control).toBeVisible();
  await page.keyboard.press("Escape");
}
async function chooseDate(page, start, end) {
  await date(page).click();
  const picker = page.getByRole("dialog", { name: "选择日期范围" });
  await picker.getByLabel("开始日期", { exact: true }).fill(start);
  await picker.getByLabel("结束日期", { exact: true }).fill(end);
  await picker.getByRole("button", { name: "确认日期", exact: true }).click();
}
async function switchBoard(page, title) {
  await page.getByRole("navigation", { name: "公共看板列表" }).getByRole("link", { name: title, exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
for (const board of ["5.2", "5.5", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15"]) test(`看板 ${board} 统一默认不对比，实际卡片不显示比较结果`, async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(url(board));
    await expect(header(page)).toBeVisible();
    await expectComparison(page, "不对比");
    if (board === "5.11") await expect(page.getByRole("article",{name:"拉单与充值转化",exact:true})).toBeVisible();
    else if (board !== "5.5") await expect(page.locator(".dashboard-metric-card").first()).toBeVisible();
    else await expect(page.getByRole("article", { name: "各功能使用概览", exact: true })).toBeVisible();
    await expect(page.locator(".dashboard-metric-card").filter({ hasText: "较对比周期" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => JSON.parse(sessionStorage.getItem(key)).compared, key)).toBe(false);
  expect(errors).toEqual([]);
});
test("已应用条件跨看板保留，草稿不带走；历史和显式视图优先", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto(url("5.7"));
  await chooseDate(page, "2026-08-01", "2026-08-31");
  await header(page).getByRole("button", { name: /^对比周期：/ }).click();
  await page.getByRole("option", { name: "上一等长周期", exact: true }).click();
  await header(page).getByRole("button", { name: "应用", exact: true }).click();
  for (const title of ["核心经营总览", "活跃与留存", "视频消费表现", "会员与付费经营", "功能使用概览"]) {
    await switchBoard(page, title);
    await expect(date(page)).toContainText("2026.08.01");
    await expectComparison(page, "上一等长周期");
  }
  await chooseDate(page, "2026-08-20", "2026-08-20");
  await switchBoard(page, "获客与新增");
  await expect(date(page)).toContainText("2026.08.01");
  await page.goBack();
  await expect(date(page)).toContainText("2026.08.01");
  await page.reload();
  await expect(date(page)).toContainText("2026.08.01");
  const view = { range: { start: "2026-09-03", end: "2026-09-03" }, compared: false, mixed: false };
  await page.goto(url("5.10") + "&view=" + encodeURIComponent(JSON.stringify(view)));
  await expect(date(page)).toContainText("2026.09.03");
  await expect(header(page)).toContainText("不对比");
  await switchBoard(page, "获客与新增");
  await expect(date(page)).toContainText("2026.09.03");
});
test("超出目标看板范围保留条件并提供修正入口，不自动改日期", async ({ page }) => {
  await page.goto(url("5.7"));
  await chooseDate(page, "2026-01-01", "2026-09-08");
  await header(page).getByRole("button", { name: "应用", exact: true }).click();
  await switchBoard(page, "活跃与留存");
  await expect(page.getByRole("heading", { name: "当前日期超出本看板可查询范围" })).toBeVisible();
  await expect(date(page)).toContainText("2026.01.01");
  await expect(header(page).getByRole("button", { name: "应用", exact: true })).toBeDisabled();
  await chooseDate(page, "2026-08-01", "2026-08-31");
  await header(page).getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.getByRole("heading", { name: "当前日期超出本看板可查询范围" })).toHaveCount(0);
  await expect(page.locator(".dashboard-metric-card").first()).toBeVisible();
  await expect(date(page)).toContainText("2026.08.01");
});
test("收藏进入公共概览分组，同一对象可进入、恢复和取消", async ({ page }) => {
  await page.goto(url("5.7"));
  const favorites = page.getByRole("region", { name: "我的收藏", exact: true });
  await expect(favorites).toContainText("点击看板右上角星标收藏");
  expect(await favorites.locator("p").evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(["12px", "400"]);
  await header(page).getByRole("button", { name: "收藏看板", exact: true }).click();
  await expect(favorites.getByRole("link", { name: "获客与新增", exact: true })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-query-favorite-added-1440.png" });
  await page.getByRole("searchbox", { name: "搜索看板" }).fill("获客");
  await expect(page.getByRole("navigation", { name: "公共看板列表" }).getByRole("link")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "搜索看板" }).fill("");
  await switchBoard(page, "活跃与留存");
  await favorites.getByRole("link", { name: "获客与新增", exact: true }).click();
  await expect(page.getByRole("heading", { name: "获客与新增", exact: true })).toBeVisible();
  await page.reload();
  await expect(favorites.getByRole("link", { name: "获客与新增", exact: true })).toBeVisible();
  await header(page).getByRole("button", { name: "取消收藏", exact: true }).click();
  await expect(favorites.getByRole("link")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "公共看板列表" }).getByRole("link", { name: "获客与新增", exact: true })).toHaveCount(1);
  await page.screenshot({ path: "/private/tmp/ypbi-query-favorites-1440.png" });
});
test("指标与事件中心利用可用宽度，窄屏只在表内滚动", async ({ page }) => {
  for (const width of [1920, 1024, 390]) for (const kind of ["metrics", "events"]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`${base}/data/${kind}?design=catalog-center`);
    const panel = page.locator(".catalog-page");
    await expect(panel).toBeVisible();
    const bounds = await panel.boundingBox();
    expect(bounds.width).toBeGreaterThan(width - 100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-catalog-fluid-${kind}-${width}.png` });
  }
});
