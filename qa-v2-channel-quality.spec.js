import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { selectReviewState } from "./tools/qa-review-tools.mjs";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const url = `${base}/dashboards/public?design=dashboard-center&board=5.7`;
test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});
const details = page => page.locator('[data-acquisition-section="channel"]');
const table = page => details(page).getByRole("region", { name: "渠道质量结果", exact: true });
const group = (page, name) => details(page).getByRole("radio", { name, exact: true });
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-channel-quality-failure-${info.line}.png` }); });

test("原来源渠道表四组切换、搜索排序、成熟状态与逐日实名基数", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
  await expect(details(page).locator(".data-origin-badge--demo")).toHaveText("演示数据");
  await expect(table(page).locator("tbody tr")).toHaveCount(5);
  await expect(group(page, "规模与转化")).toHaveAttribute("aria-checked", "true");
  await table(page).getByRole("button", { name: "排序新增用户数", exact: true }).click();
  await expect(table(page).locator("th").filter({ hasText: "新增用户数" })).toHaveAttribute("aria-sort", "ascending");
  await expect(table(page).locator("tbody tr").first()).toContainText("未归类");
  const search = details(page).getByRole("textbox", { name: "搜索来源渠道" });
  await search.fill("推广"); await expect(table(page).locator("tbody tr")).toHaveCount(2);
  await search.fill("不存在的渠道"); await expect(table(page)).toContainText("没有匹配的渠道结果");
  await search.fill("");
  await group(page, "首次体验").click();
  await expect.poll(() => page.evaluate(() => window.history.state.acquisitionView.detail.sections.channel.sort)).toEqual({ id: "M008", descending: false });
  await expect(details(page)).toContainText("按新增用户数升序");
  await expect(table(page).locator("thead")).toContainText("首个视频页到达率");
  const trigger = table(page).getByRole("button", { name: "推广渠道 A · 首个视频页到达率详情", exact: true });
  await trigger.click();
  const reading = page.getByRole("dialog", { name: "推广渠道 A · 首个视频页到达率", exact: true });
  await expect(reading.getByRole("table", { name: "渠道指标逐日依据", exact: true }).locator("thead")).toContainText("首次体验启动成功用户数");
  await expect(reading.getByRole("table").locator("tbody tr")).toHaveCount(14);
  await expect(reading).toContainText("未成熟");
  await reading.getByRole("button", { name: "计算依据", exact: true }).first().click();
  const basis = page.getByRole("dialog", { name: "计算依据", exact: true });
  await expect(basis).toContainText("分母 · 首次体验启动成功用户数");
  await expect(basis).not.toContainText("待接入");
  await page.screenshot({ path: "/private/tmp/ypbi-channel-quality-calculation.png" });
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await group(page, "注册留存").click();
  await expect(table(page).locator("thead")).toContainText("注册用户D30留存率");
  await expect(table(page)).toContainText("成熟 6/7 批"); await expect(table(page)).toContainText("未成熟");
  await details(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: "/private/tmp/ypbi-channel-quality-retention.png" });
  await group(page, "付费价值").click();
  await expect(table(page).locator("thead")).toContainText("新增用户人均充值金额（ARPU）");
  await expect(details(page)).toContainText("注册当日"); await expect(table(page)).toContainText("USD/人");
  expect(errors).toEqual([]);
});

test("完整明细分页及演示XLSX不受搜索、指标组与局部分页裁剪", async ({ page }) => {
  await page.goto(url); await group(page, "付费价值").click();
  await details(page).getByRole("textbox", { name: "搜索来源渠道" }).fill("推广渠道 A");
  await details(page).getByRole("button", { name: "完整明细", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "渠道质量完整明细", exact: true });
  await expect(dialog).toContainText("1–50 / 共 190 条");
  await dialog.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(dialog).toContainText("51–100 / 共 190 条");
  await expect(dialog.getByRole("table").locator("thead")).not.toContainText("公式");
  await dialog.getByRole("button", { name: "导出渠道质量完整明细", exact: true }).click();
  const exporter = page.getByRole("dialog", { name: "导出渠道质量完整明细", exact: true });
  await expect(exporter).toContainText("演示数据");
  const downloading = page.waitForEvent("download"); await exporter.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  const download = await downloading; expect(download.suggestedFilename()).toBe("渠道质量-演示数据.xlsx");
  const path = "/private/tmp/ypbi-channel-quality-complete.xlsx"; await download.saveAs(path);
  const raw = (await readFile(path)).toString();
  for (const text of ["03_增长效果_来源渠道", "08_渠道质量逐日依据", "09_渠道质量口径", "未归类", "合作渠道 C", "注册用户D30留存率", "首次体验启动成功用户数", "对比分母值", "2026-08-26", "2026-09-08", "演示数据", "USD"]) expect(raw).toContain(text);
  await expect(dialog).toBeVisible(); await page.keyboard.press("Escape");
});

test("四组阅读选择、排序及搜索随复制深链和刷新还原", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(url); await group(page, "注册留存").click();
  await table(page).getByRole("button", { name: "排序注册用户D1留存率", exact: true }).click();
  await table(page).getByRole("button", { name: "排序注册用户D1留存率", exact: true }).click();
  await details(page).getByRole("textbox", { name: "搜索来源渠道" }).fill("推广");
  await page.getByRole("button", { name: "复制当前视图链接", exact: true }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText()); expect(link).toContain("view=");
  await page.goto(link); await expect(group(page, "注册留存")).toHaveAttribute("aria-checked", "true");
  await expect(details(page).getByRole("textbox", { name: "搜索来源渠道" })).toHaveValue("推广");
  await expect(table(page).locator("th").filter({ hasText: "注册用户D1留存率" })).toHaveAttribute("aria-sort", "ascending");
  await page.reload(); await expect(group(page, "注册留存")).toHaveAttribute("aria-checked", "true");
  await expect(table(page).locator("tbody tr")).toHaveCount(2);
});

test("三档视口四组可操作、区域内横滚，混合缺失不改成0", async ({ page }) => {
  await page.goto(url);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["规模与转化", "首次体验", "注册留存", "付费价值"]) { await group(page, name).click(); await expect(group(page, name)).toHaveAttribute("aria-checked", "true"); }
    await details(page).scrollIntoViewIfNeeded();
    const geometry = await table(page).evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, overflow: getComputedStyle(element).overflowX, scroll: element.scrollWidth, width: element.clientWidth }));
    expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width); expect(geometry.overflow).toBe("auto");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator(".acquisition-preview").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    if (width === 390) { expect(geometry.scroll).toBeGreaterThan(geometry.width); await table(page).evaluate(element => element.scrollLeft = element.scrollWidth); }
    await page.mouse.move(0, 0); await page.screenshot({ path: `/private/tmp/ypbi-channel-quality-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await selectReviewState(page, "组合异常态"); await group(page, "首次体验").click();
  const missing = table(page).getByRole("button", { name: "未归类 · 新增用户-有效观影转化率详情", exact: true });
  await expect(missing).toHaveText("—"); await expect(missing.locator("..").locator("..")).toContainText("缺失");
  await group(page, "规模与转化").click();
  await expect(table(page).getByRole("button", { name: "未归类 · 访问-下载点击转化率（去重）详情", exact: true })).toHaveText("—");
  const landing = page.getByRole("article", { name: "落地页转化诊断", exact: true });
  await expect(landing.locator("canvas")).toHaveCount(0); await expect(landing.locator(".acquisition-visuals__stages section")).toHaveCount(3);
  await expect(landing.getByRole("button", { name: "查看渠道明细", exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
  await details(page).scrollIntoViewIfNeeded(); await page.screenshot({ path: "/private/tmp/ypbi-channel-quality-mixed.png" });
});
