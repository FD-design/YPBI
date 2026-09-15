import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const url = `${base}/dashboards/public?design=dashboard-center&board=5.7`;
const section = (page, key) => page.locator(`[data-acquisition-section="${key}"]`);
const legacy = { v: 1, filters: { start: "2026-09-02", end: "2026-09-08", scope: "all", channel: "all", comparison: "previous" }, detail: { tab: "growth", dimension: "target", search: "Android", showChange: "previous", page: 0, sort: { id: "M005", descending: false } }, mixed: false };
test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-acquisition-sections-failure-${info.line}.png` }); });

test("三类增长结果同时展示，少量目标完整可读，各块状态与结算独立", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  for (const key of ["channel", "target", "type"]) await expect(section(page, key)).toBeVisible();
  await expect(page.getByRole("button", { name: /^明细行分组/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看来源明细", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "搜索下载目标", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "搜索获客类型", exact: true })).toHaveCount(0);
  await expect(section(page, "target").locator("tbody tr")).toHaveCount(3);
  await expect(section(page, "type").locator("tbody tr")).toHaveCount(2);
  await expect(section(page, "type").locator("thead")).not.toContainText("占比");
  await expect(section(page, "target").locator("canvas")).toHaveCount(0);
  await expect(section(page, "type").locator("canvas")).toHaveCount(0);
  await section(page, "channel").getByRole("textbox", { name: "搜索来源渠道" }).fill("推广");
  await section(page, "channel").getByRole("radio", { name: "注册留存", exact: true }).check();
  await section(page, "target").getByRole("button", { name: "排序新增用户数", exact: true }).click();
  await section(page, "target").getByRole("button", { name: /^下载目标变化参考/ }).click();
  await page.getByRole("option", { name: "较对比周期", exact: true }).click();
  await expect(section(page, "target").locator(".ui-metric-comparison")).toHaveCount(15);
  await expect(section(page, "type").locator(".ui-metric-comparison")).toHaveCount(0);
  await expect(section(page, "channel").getByRole("region", { name: "渠道质量结果", exact: true }).locator("tbody tr")).toHaveCount(2);
  await page.getByRole("tab", { name: "渠道结算", exact: true }).click();
  await expect(section(page, "channel")).toHaveCount(0);
  await section(page, "settlement").getByRole("textbox").fill("推广");
  await expect(section(page, "settlement")).toContainText("扣后新增仅用于渠道结算核对");
  await page.getByRole("tab", { name: "增长效果", exact: true }).click();
  await expect(section(page, "channel").getByRole("radio", { name: "注册留存", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(section(page, "channel").getByRole("textbox")).toHaveValue("推广");
  await expect(section(page, "target").locator(".ui-metric-comparison")).toHaveCount(15);
  await expect(section(page, "type").locator("tbody tr")).toHaveCount(2);
  const nature = section(page, "type").getByRole("button", { name: "自然新增 · 新增用户数详情", exact: true });
  const natureValue = await nature.innerText(); await nature.click();
  await expect(page.getByRole("dialog", { name: "自然新增 · 新增用户数", exact: true })).toContainText(`${natureValue} 人`);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "渠道结算", exact: true }).click();
  await page.getByRole("button", { name: "查看下载明细", exact: true }).click();
  await expect(page.getByRole("tab", { name: "增长效果", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(section(page, "target")).toBeFocused();
  for (const key of ["channel", "target", "type"]) await expect(section(page, key)).toBeVisible();
  expect(errors).toEqual([]);
});

test("旧分组深链保留可见筛选，新链接恢复三块且搜索清空不留下隐性条件", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${url}&view=${encodeURIComponent(JSON.stringify(legacy))}`);
  await expect(section(page, "target").getByRole("textbox")).toHaveValue("Android");
  await expect(section(page, "target").locator("tbody tr")).toHaveCount(1);
  await expect(section(page, "channel").getByRole("textbox")).toHaveValue("");
  await expect(section(page, "type").locator("tbody tr")).toHaveCount(2);
  await section(page, "channel").getByRole("textbox").fill("合作");
  await section(page, "type").getByRole("button", { name: /^获客类型变化参考/ }).click();
  await page.getByRole("option", { name: "较对比周期", exact: true }).click();
  await page.getByRole("button", { name: "复制当前视图链接", exact: true }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const reading = JSON.parse(new URL(link).searchParams.get("view"));
  expect(reading.v).toBe(2); expect(reading.detail.sections.channel.search).toBe("合作"); expect(reading.detail.sections.target.search).toBe("Android"); expect(reading.detail.sections.type.showChange).toBe("previous");
  await page.goto(link); await page.reload();
  await expect(section(page, "target").getByRole("textbox")).toHaveValue("Android");
  await expect(section(page, "channel").getByRole("textbox")).toHaveValue("合作");
  await expect(section(page, "type").locator(".ui-metric-comparison")).toHaveCount(2);
  await section(page, "target").getByRole("textbox").fill("不存在");
  await expect(section(page, "target")).toContainText("没有匹配的维度结果");
  await section(page, "target").getByRole("textbox").fill("");
  await expect(section(page, "target").getByRole("textbox")).toHaveCount(0);
  await expect(section(page, "target").locator("tbody tr")).toHaveCount(3);
});

test("下载目标与获客类型局部导出含完整自身结果，不混入相邻渠道或结算", async ({ page }) => {
  await page.goto(`${url}&view=${encodeURIComponent(JSON.stringify(legacy))}`);
  for (const [key, name, sheet] of [["target", "下载目标", "04_增长效果_下载目标"], ["type", "获客类型", "05_增长效果_获客类型"]]) {
    await section(page, key).getByRole("button", { name: `导出${name}`, exact: true }).click();
    const exporter = page.getByRole("dialog", { name: `导出${name}`, exact: true });
    await expect(exporter).toContainText("不受搜索、分页与变化显隐限制");
    const downloading = page.waitForEvent("download"); await exporter.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
    const download = await downloading; expect(download.suggestedFilename()).toBe(`${name}-演示数据.xlsx`);
    const path = `/private/tmp/ypbi-acquisition-${key}-only.xlsx`; await download.saveAs(path); const raw = (await readFile(path)).toString();
    expect(raw).toContain(sheet); expect(raw).toContain("演示数据"); expect(raw).toContain("2026-08-26"); expect(raw).not.toContain("03_增长效果_来源渠道"); expect(raw).not.toContain("06_渠道结算");
    if (key === "target") { expect(raw).toContain("App Store"); expect(raw).toContain("Android"); expect(raw).not.toContain("05_增长效果_获客类型"); }
    else { expect(raw).toContain("自然新增"); expect(raw).toContain("内部导量"); expect(raw).not.toContain("04_增长效果_下载目标"); }
  }
});

test("三档宽度纵向顺序、局部横滚与控件可达，保留顶部九卡", async ({ page }) => {
  await page.goto(url);
  await expect(page.locator("[data-acquisition-section]")).toHaveCount(3);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.locator("[data-acquisition-section]").evaluateAll(elements => elements.map(el => ({ key: el.getAttribute("data-acquisition-section"), top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
    expect(metrics.map(item => item.key)).toEqual(["channel", "target", "type"]);
    expect(metrics[1].top).toBeGreaterThan(metrics[0].bottom); expect(metrics[2].top).toBeGreaterThan(metrics[1].bottom);
    for (const key of ["channel", "target", "type"]) {
      const block = section(page, key); await block.scrollIntoViewIfNeeded();
      const box = await block.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      const viewport = block.locator(".ui-result-table__viewport").first();
      expect(await viewport.evaluate(el => getComputedStyle(el).overflowX)).toBe("auto");
      if (key === "target" && width === 390) { await viewport.evaluate(el => el.scrollLeft = el.scrollWidth); expect(await viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(0); }
      await page.mouse.move(0, 0); await block.screenshot({ path: `/private/tmp/ypbi-acquisition-${key}-block-${width}.png` });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.locator(".acquisition-preview").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
  }
});
