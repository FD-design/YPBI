import {selectReviewState} from './tools/qa-review-tools.mjs';
import { test, expect } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-topic-failure-${info.title.slice(0, 8)}.png`, fullPage: true }); });
async function dateRange(page, label, days) {
  if (label !== "统计日期") await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page.getByRole("group", { name: label, exact: true }).getByRole("button").click();
  const dialog = page.getByRole("dialog", { name: "选择日期范围" });
  if (days === 1) { await dialog.getByLabel("开始日期", { exact: true }).fill("2026-09-08"); await dialog.getByLabel("结束日期", { exact: true }).fill("2026-09-08"); }
  else await dialog.getByRole("button", { name: `过去 ${days} 天`, exact: true }).click();
  await dialog.getByRole("button", { name: "确认日期", exact: true }).click();
  if (label !== "统计日期") await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.locator(".topic-preview__query").getByRole("button", { name: "应用", exact: true }).click();
}
test("时长用数值摘要与类型精确比较，缺失不凑占比且原趋势保留", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9`);
  const panel = page.getByRole("article", { name: "观影时长结构与人均时长", exact: true });
  await expect(panel.getByLabel("观影时长数值摘要")).toBeVisible();
  await expect(panel.getByLabel("视频类型时长比较")).toBeVisible();
  await expect(panel.getByRole("table", { name: "长短视频时长明细" }).getByRole("row")).toHaveCount(4);
  await expect(panel).toContainText("长短视频的时长与用户基数尚未接入，暂不展示贡献比例。");
  await expect(panel.getByRole("table", { name: "长短视频时长明细" }).getByRole("cell", { name: "—", exact: true })).toHaveCount(9);
  await expect(panel).not.toContainText("100.00%");
  await expect(page.locator(".dashboard-metric-card")).toHaveCount(12);
  const total = page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name: "观影总时长", exact: true }) });
  await expect(total.getByRole("tab", { name: "折线", exact: true })).toHaveAttribute("aria-selected", "true");
  const summary = panel.getByRole("region", { name: "观影总时长摘要", exact: true });
  expect(await summary.locator("strong").innerText()).toBe(await total.locator(".dashboard-metric-card__value strong").innerText());
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await panel.screenshot({ path: `/private/tmp/ypbi-duration-${width}.png` });
  }
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "观影时长同口径数据表", exact: true });
  await expect(dialog).toContainText("不同类型的观影用户可重叠");
  await expect(dialog.getByRole("button", { name: "导出观影总时长同口径数据表", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "查看同口径数据表", exact: true })).toBeFocused();
});
test("时长单日分秒读法与精确值同步，对比与刷新保持", async ({ page }) => {
  const range = { start: "2026-09-08", end: "2026-09-08" };
  const view = { v: 1, active: range, cohort: range, failure: range, compared: true, mixed: false };
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9&view=${encodeURIComponent(JSON.stringify(view))}`);
  const panel = page.getByRole("article", { name: "观影时长结构与人均时长", exact: true });
  const average = panel.getByRole("region", { name: "观影用户人均观影时长摘要", exact: true });
  await expect(average.locator("strong")).toContainText(/分|秒|小时/);
  await expect(average).toContainText("精确值");
  await expect(average).not.toContainText("多日去重数据待接入");
  const content = await panel.innerText();
  await page.reload();
  await expect.poll(() => panel.innerText()).toBe(content);
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("观影用户数");
});
for (const [board, title, count] of [["5.8", "活跃与留存", 9], ["5.9", "视频消费表现", 12]]) test(`${title}布局、卡片阅读、导出与响应式`, async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-metric-card")).toHaveCount(count);
  const card = page.locator(".dashboard-metric-card").first();
  await card.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(card.locator("tbody tr")).toHaveCount(7);
  await card.getByRole("tab", { name: "折线", exact: true }).click();
  await card.getByRole("button", { name: "查看同口径数据表" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `导出${title}`, exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/演示.*xlsx/);
  for (const width of [1800, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const boxes = await page.locator(".dashboard-metric-card").evaluateAll(cards => cards.map(card => ({ left: card.getBoundingClientRect().left, right: card.getBoundingClientRect().right })));
    expect(boxes.every(box => box.left >= 0 && box.right <= width)).toBe(true);
    if (width === 1800 || width === 390) await page.screenshot({ path: `/private/tmp/ypbi-topic-${board}-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
test("活跃留存独立日期、长范围与成熟状态", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.8`);
  const original = await page.locator(".dashboard-metric-card").first().innerText();
  await dateRange(page, "注册日期", 90);
  await page.getByRole('article',{name:'注册留存明细',exact:true}).getByRole('radio',{name:'表格',exact:true}).click();
  await expect(page.getByRole("navigation", { name: "注册留存明细分页" })).toContainText("共 90 条");
  expect(await page.locator(".dashboard-metric-card").first().innerText()).toBe(original);
  const card = page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name: "注册用户D30留存率", exact: true }) });
  await expect(card).not.toHaveClass(/is-detailed/);
  await expect(card.getByRole("group", { name: /注册用户D30留存率当前期.*趋势/ })).toBeVisible();
  await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("注册用户D30留存率");
  await page.keyboard.press("Escape");
  await page.getByRole("navigation", { name: "注册留存明细分页" }).getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.locator('.ui-result-table__viewport[aria-label="注册留存明细"]')).toContainText("未成熟");
  await dateRange(page, "注册日期", 1);
  await expect(card).toContainText("当前范围暂无观察期已结束的用户");
  await dateRange(page, "统计日期", 30);
  await page.locator(".dashboard-metric-card").first().getByRole("tab", { name: "表格", exact: true }).click();
  await expect(page.locator(".dashboard-metric-card").first().locator("tbody tr")).toHaveCount(30);
  await page.reload();
  await expect(page.getByRole("group", { name: "统计日期", exact: true })).toContainText("2026.08.10");
});
test("紧凑留存与启动次数保留完整折线、柱状、表格和导出", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.8`);
  await dateRange(page, "注册日期", 90);
  for (const name of ["注册用户D3留存率", "注册用户D30留存率", "应用启动次数"]) {
    if (name === "应用启动次数") await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.15`);
    const card = page.locator(".dashboard-metric-card").filter({ has: page.getByRole("link", { name, exact: true }) });
    const trigger = card.getByRole("button", { name: `查看${name}完整趋势`, exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: `${name} · 完整趋势`, exact: true });
    for (const label of ["折线", "柱状", "表格"]) {
      await dialog.getByRole("tab", { name: label, exact: true }).click();
      await expect(dialog.getByRole("region", { name: `${name}${label}视图`, exact: true })).toBeVisible();
    }
    const exported = dialog.getByRole("button", { name: /^导出/ }).first();
    await exported.click();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
    expect((await download).suggestedFilename()).toContain("演示数据");
    await expect(dialog).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await dialog.getByRole("tab", { name: "折线", exact: true }).click();
      await dialog.screenshot({ path: `/private/tmp/ypbi-compact-full-trend-${name}-${width}.png` });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test("视频内容完整分页、筛选导出、独立留存与异常重试", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9`);
  await page.getByRole("article", { name: "内容排行", exact: true }).getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const ranking = page.getByRole("dialog", { name: "内容排行同口径数据表", exact: true });
  await expect(ranking.getByRole("navigation")).toContainText("1–50 / 共 126 条");
  await ranking.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(ranking.getByRole("navigation")).toContainText("51–100");
  await ranking.getByRole("textbox", { name: "搜索内容" }).fill("演示内容 001");
  await expect(ranking.getByRole("navigation")).toContainText("1–1 / 共 1 条");
  await ranking.getByRole("button", { name: "导出内容排行", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导出内容排行", exact: true })).toContainText("完整聚合结果");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await dateRange(page, "统计日期", 90);
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await expect(page.getByRole("group", { name: "首次有效观看日期", exact: true })).toContainText("2026.09.02");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await selectReviewState(page, '组合异常态');
  const failed = page.locator(".dashboard-metric-card").filter({ hasText: "当前指标加载失败" });
  await expect(failed).toHaveCount(1);
  await failed.getByRole("button", { name: /重试/ }).click();
  await expect(failed).toHaveCount(0);
  await page.screenshot({ path: "/private/tmp/ypbi-topic-video-long.png", fullPage: true });
});

test("手机 Cohort 区域滚动、冻结列和视图重开", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.8`);
  await dateRange(page, "注册日期", 180);
  await page.getByRole('article',{name:'注册留存明细',exact:true}).getByRole('radio',{name:'表格',exact:true}).click();
  const matrix = page.locator('.ui-result-table__viewport[aria-label="注册留存明细"]');
  await matrix.scrollIntoViewIfNeeded();
  const before = await matrix.locator("tbody tr").first().locator("td").nth(1).boundingBox();
  await matrix.evaluate(el => { el.scrollLeft = 500; el.scrollTop = 180; });
  const after = await matrix.locator("tbody tr").first().locator("td").nth(1).boundingBox();
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(await matrix.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await matrix.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await matrix.screenshot({ path: "/private/tmp/ypbi-topic-cohort-mobile.png" });
  await expect(page.getByRole("navigation", { name: "注册留存明细分页" })).toBeVisible();
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.9`);
  await page.getByRole("article", { name: "内容排行", exact: true }).getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索内容" }).fill("演示内容 006");
  await page.reload();
  await page.getByRole("article", { name: "内容排行", exact: true }).getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "搜索内容" })).toHaveValue("演示内容 006");
  await page.getByRole("dialog", { name: "内容排行同口径数据表", exact: true }).screenshot({ path: "/private/tmp/ypbi-topic-ranking-mobile.png" });
});
