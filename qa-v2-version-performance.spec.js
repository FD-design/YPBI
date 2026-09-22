import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
test.use({ channel: "chrome" });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const range = { start: "2026-09-02", end: "2026-09-08" };
const experience = { v: 1, panel: "version", client: "overall", version: "android:6.8.0", comparison: "none", distribution: "active_users", metric: "M080", audience: "overall", search: "", versionRange: "all", display: "groups" };
const boardUrl = (patch = {}) => `${base}/dashboards/public?design=dashboard-center&board=5.15&view=${encodeURIComponent(JSON.stringify({ range, compared: false, mixed: false, experience, ...patch }))}`;
const region = page => page.getByRole("region", { name: "版本表现", exact: true });
const scope = page => region(page).getByRole("region", { name: "版本分析范围", exact: true });
const panel = (page, name) => region(page).getByRole("article", { name, exact: true });
const matrix = page => panel(page, "核心表现").getByRole("table", { name: "版本核心表现客户端比较表", exact: true });
const summary = page => panel(page, "版本分布").getByRole("table", { name: "版本分布摘要", exact: true });
const client = (page, name) => scope(page).getByRole("group", { name: "客户端分组", exact: true }).getByRole("button", { name, exact: true });
const mode = (page, name) => scope(page).getByRole("radiogroup", { name: "展示方式", exact: true }).getByRole("radio", { name, exact: true });
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-233-version-failure-${info.line}-${info.workerIndex}.png`, fullPage: true }); });

test("启动诊断保持独立，版本仅有两端且分布与核心每版本一行", async ({ page }) => {
  await page.goto(boardUrl());
  await expect(page.getByRole("region", { name: "启动诊断", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "产品体验视图", exact: true })).toHaveCount(0);
  await expect(mode(page, "分组对比")).toBeChecked();
  for (const name of ["Android", "iOS"]) await expect(client(page, name)).toHaveAttribute("aria-pressed", "true");
  await expect(scope(page).getByRole("group", { name: "用户人群分组", exact: true })).toHaveCount(0);
  await expect(summary(page).locator("tbody tr")).toHaveCount(6);
  await expect(matrix(page).locator("tbody tr")).toHaveCount(6);
  await expect(summary(page).getByText("版本未知", { exact: true })).toHaveCount(1);
  await expect(matrix(page).locator("thead")).not.toContainText("新用户");
  await expect(matrix(page).locator("thead")).not.toContainText("老用户");
  await expect(panel(page, "核心表现").locator("button.version-performance__metric")).toHaveCount(9);
  await expect(region(page).getByRole("region", { name: "启动成功率分组摘要", exact: true }).locator("section")).toHaveCount(2);
  const diagnosis = page.getByRole("article", { name: "启动结构与质量诊断", exact: true });
  await diagnosis.getByRole("button", { name: "启动成功率", exact: true }).click();
  await diagnosis.getByRole("button", { name: /^启动结构与质量诊断分组：/ }).click();
  await expect(page.getByRole("option", { name: "网络", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "启动类型", exact: true }).click();
  await client(page, "iOS").click();
  await expect(diagnosis.getByRole("button", { name: "启动成功率", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("两端显隐联动，总体只展示一个独立结果，模式可恢复", async ({ page }) => {
  await page.goto(boardUrl());
  await client(page, "iOS").click();
  await expect(summary(page).locator("thead th")).toHaveCount(2);
  await expect(matrix(page).locator("thead th")).toHaveCount(2);
  await expect(summary(page).locator("tbody tr")).toHaveCount(6);
  await expect(region(page).getByRole("region", { name: "启动成功率分组摘要", exact: true }).locator("section")).toHaveCount(1);
  await scope(page).getByRole("button", { name: "恢复全部分组", exact: true }).click();
  await expect(matrix(page).locator("thead th")).toHaveCount(3);
  await mode(page, "总体").click();
  await expect(matrix(page).locator("thead th")).toHaveText(["版本", "总体"]);
  await expect(summary(page).locator("tbody tr")).toHaveCount(6);
  await expect(summary(page).locator("thead")).not.toContainText("Android");
  await expect(region(page).getByRole("img", { name: "总体活跃人数版本分布", exact: true })).toBeVisible();
  await expect(region(page).getByRole("region", { name: "启动成功率分组摘要", exact: true })).toHaveCount(0);
  await panel(page, "版本分布").getByRole("radio", { name: "启动次数", exact: true }).click();
  await page.reload();
  await expect(mode(page, "总体")).toBeChecked();
  await expect(panel(page, "版本分布").getByRole("radio", { name: "启动次数", exact: true })).toBeChecked();
});

test("版本客户端格联动摘要趋势，公式与固定留存指标保留", async ({ page }) => {
  await page.goto(boardUrl());
  await matrix(page).getByRole("button", { name: /^6\.8\.0 · iOS ·/ }).click();
  await expect(scope(page).getByRole("button", { name: "版本条件：6.8.0", exact: true })).toBeVisible();
  await expect(matrix(page).locator("tbody tr")).toHaveCount(6);
  await expect(panel(page, "核心表现").locator("button.version-performance__metric").filter({ hasText: "启动成功率" })).toContainText("iOS · 当前版本范围");
  await expect(region(page).getByRole("region", { name: "启动成功率分组摘要", exact: true }).locator("section")).toHaveCount(1);
  await panel(page, "核心表现").getByRole("button", { name: "计算依据", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("6.8.0");
  await expect(page.getByRole("dialog")).toContainText("iOS");
  await page.keyboard.press("Escape");
  await panel(page, "核心表现").getByRole("button", { name: /注册用户D1留存率/ }).click();
  await expect(panel(page, "核心表现")).toContainText("固定注册批次");
  await expect(matrix(page).locator("tbody tr").filter({ hasText: "6.8.0" })).toContainText("6/7 个成熟批次");
  await expect(panel(page, "变化趋势")).toContainText("固定注册批次");
  await scope(page).getByRole("button", { name: "恢复全部版本", exact: true }).click();
  await expect(scope(page).getByRole("button", { name: "版本条件：全部 Android / iOS 版本", exact: true })).toBeVisible();
});

test("搜索、精确旧链接与120版本分页保留", async ({ page }) => {
  await page.goto(boardUrl());
  const search = panel(page, "核心表现").getByRole("searchbox", { name: "搜索版本", exact: true });
  await search.fill("6.8"); await expect(matrix(page).locator("tbody tr")).toHaveCount(1);
  await page.reload(); await expect(search).toHaveValue("6.8");
  await page.goto(boardUrl({ experience: { v: 1, panel: "version", client: "android", version: "android:6.8.0", comparison: "android:6.7.2", distribution: "active_users", metric: "M080", audience: "new" } }));
  await expect(scope(page).getByRole("button", { name: /版本条件：Android · 6.8.0/ })).toBeVisible();
  await expect(scope(page).getByRole("button", { name: "对比版本：Android · 6.7.2", exact: true })).toBeVisible();
  await expect(scope(page)).not.toContainText("新用户");
  await expect(panel(page, "变化趋势")).toContainText("Android · 6.7.2 · 对比版本");
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { PivotTable } = await import("/src/components/ui/PivotTable.tsx");
    const host = document.createElement("div"); host.id = "version-pivot-pressure"; host.className = "ypbi-v2";
    Object.assign(host.style, { position: "fixed", inset: "12px", zIndex: "9999", overflow: "auto", background: "white", padding: "12px" }); document.body.append(host);
    function Harness() { const [selected, setSelected] = React.useState(null); return React.createElement(PivotTable, { label: "版本压力比较表", rowHeading: "版本", columns: ["Android", "iOS"], rows: Array.from({ length: 120 }, (_, index) => ({ key: `6.${index}`, label: `合成版本 ${index + 1}`, values: [`${index + 1}00`, `${index + 1}1`] })), selectedCell: selected, onSelectCell: setSelected }); }
    window.__versionPivotRoot = createRoot(host); window.__versionPivotRoot.render(React.createElement(Harness));
  });
  const pressure = page.getByRole("region", { name: "版本压力比较表", exact: true });
  await expect(pressure.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const cell = pressure.getByRole("button", { name: /^合成版本 51 · iOS ·/ }); await cell.click(); await expect(cell).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.evaluate(() => { window.__versionPivotRoot.unmount(); document.getElementById("version-pivot-pressure")?.remove(); });
});

test("隐藏端别不裁剪导出，保留两期两端与固定批次", async ({ page }) => {
  await page.goto(boardUrl({ compared: true }));
  await client(page, "iOS").click();
  await page.getByRole("button", { name: "导出版本表现", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "导出版本表现", exact: true }).getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  const download = await downloading, content = (await readFile(await download.path())).toString("utf8");
  expect(download.suggestedFilename()).toBe("版本表现-演示数据.xlsx");
  for (const value of ["01_版本分布", "02_核心表现", "03_变化趋势", "04_D1批次核对", "当前期", "上一等长周期", "Android", "iOS", "6.8.0", "固定注册批次", "固定为注册满 2 天的存量用户", "次日观察未结束", "2026-08-26 至 2026-09-01"]) expect(content).toContain(value);
  for (const value of ["Android · 新用户", "iOS · 老用户", ">人群<"]) expect(content).not.toContain(value);
});

test("三档视口无横溢、同名版本不重复、表格不撑高图表", async ({ page }) => {
  for (const width of [1320, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 }); await page.goto(boardUrl());
    await expect(summary(page).locator("tbody tr")).toHaveCount(6);
    await expect(matrix(page).locator("tbody tr")).toHaveCount(6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await panel(page, "版本分布").scrollIntoViewIfNeeded(); await panel(page, "版本分布").screenshot({ path: `/private/tmp/ypbi-232-version-distribution-${width}.png` });
    const comparison = panel(page, "核心表现").locator(".version-core-client__comparison"); await comparison.scrollIntoViewIfNeeded(); await comparison.screenshot({ path: `/private/tmp/ypbi-232-version-matrix-${width}.png` });
    await panel(page, "变化趋势").screenshot({ path: `/private/tmp/ypbi-232-version-trend-${width}.png` });
    const viewport = panel(page, "版本分布").locator(".version-performance__distribution-summary .ui-result-table__viewport");
    await expect(viewport).toHaveCount(1);
    expect((await viewport.boundingBox()).height).toBeLessThanOrEqual(580);
    expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await matrix(page).evaluate(element => element.scrollWidth - element.parentElement.clientWidth)).toBeLessThanOrEqual(1);
  }
});

async function expectNoDetachedDocumentScroll(page, context) {
  const dimensions = await page.evaluate(() => {
    const root = document.getElementById("root");
    const content = document.querySelector(".dashboard-workbench__content");
    return {
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight,
      rootHeight: root?.scrollHeight ?? 0,
      viewportHeight: innerHeight,
      outerScroll: scrollY,
      contentScroll: content?.scrollTop ?? 0,
      contentHeight: content?.clientHeight ?? 0,
      contentScrollHeight: content?.scrollHeight ?? 0
    };
  });
  const layoutHeight = Math.max(dimensions.bodyHeight, dimensions.rootHeight, dimensions.viewportHeight);
  expect(dimensions.documentHeight, `${context}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(layoutHeight + 1);
  expect(dimensions.outerScroll, `${context}: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(Math.max(0, layoutHeight - dimensions.viewportHeight) + 1);
}

for (const width of [1320, 1024, 390]) for (const display of ["overall", "groups"]) {
  test(`滚动后看板不产生外层空白 ${width} ${display}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(boardUrl({ experience: { ...experience, metric: "M091", display } }));
    await page.getByRole("radiogroup", { name: "指标卡展示", exact: true }).getByRole("radio", { name: "纯数值", exact: true }).click();
    await expect(mode(page, display === "overall" ? "总体" : "分组对比")).toBeChecked();
    await expect(panel(page, "核心表现").getByRole("button", { name: /^应用启动次数/ })).toHaveAttribute("aria-pressed", "true");
    if (display === "groups") for (const name of ["Android", "iOS"]) await expect(client(page, name)).toHaveAttribute("aria-pressed", "true");

    const search = panel(page, "核心表现").getByRole("searchbox", { name: "搜索版本", exact: true });
    await search.fill("6.8");
    await expect(matrix(page).locator("tbody tr")).toHaveCount(1);
    await search.fill("");
    await expect(matrix(page).locator("tbody tr")).toHaveCount(6);
    const content = page.locator(".dashboard-workbench__content");
    const contentBox = await content.boundingBox();
    const beforeWheel = await content.evaluate(element => element.scrollTop);
    await page.mouse.move(contentBox.x + contentBox.width - 24, Math.min(900, contentBox.y + contentBox.height - 30));
    await page.mouse.wheel(0, 500);
    await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel);

    const core = panel(page, "核心表现"), trend = panel(page, "变化趋势");
    const coreData = core.getByRole("button", { name: "查看同口径数据表", exact: true });
    await coreData.scrollIntoViewIfNeeded();
    await expect(coreData).toBeInViewport();
    const [coreBox, trendBox, dataBox] = await Promise.all([core.boundingBox(), trend.boundingBox(), coreData.boundingBox()]);
    const betweenPanels = trendBox.y - (coreBox.y + coreBox.height);
    const trailingSpace = coreBox.y + coreBox.height - (dataBox.y + dataBox.height);
    expect(betweenPanels, "核心表现与变化趋势使用统一区块间距").toBeGreaterThanOrEqual(12);
    expect(betweenPanels, "核心表现与变化趋势之间不得出现空白屏").toBeLessThanOrEqual(32);
    expect(trailingSpace, "核心数据入口后不得保留大块空白").toBeGreaterThanOrEqual(0);
    expect(trailingSpace, "核心数据入口贴近区块尾部").toBeLessThanOrEqual(24);
    await expectNoDetachedDocumentScroll(page, `${width}/${display} 核心尾部`);

    await coreData.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "版本核心表现同口径数据表", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(coreData).toBeFocused();
    const trendData = trend.getByRole("button", { name: "查看同口径数据表", exact: true });
    await trendData.scrollIntoViewIfNeeded(); await expect(trendData).toBeInViewport();
    await trendData.focus(); await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "应用启动次数版本趋势同口径数据表", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(trendData).toBeFocused();
    await page.mouse.move(width - 8, 20); await page.mouse.wheel(0, 2000);
    await expectNoDetachedDocumentScroll(page, `${width}/${display} 趋势末端外层滚轮`);
    await page.screenshot({ path: `/private/tmp/ypbi-233-version-scroll-${width}-${display}.png` });
  });
}

test("共享搜索定位回归保留目录标签与键盘访问", async ({ page }) => {
  for (const width of [1320, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(`${base}/data/metrics?design=catalog-center`);
    const search = page.getByRole("textbox", { name: "搜索指标", exact: true });
    await expect(search).toBeVisible();
    await expect(search).toHaveAccessibleName("搜索指标");
    await search.focus(); await page.keyboard.type("日活跃用户数");
    await expect(search).toHaveValue("日活跃用户数");
    const table = page.getByRole("table", { name: "指标目录", exact: true });
    await expect(table).toContainText("日活跃用户数");
    await table.scrollIntoViewIfNeeded();
    await expectNoDetachedDocumentScroll(page, `${width} 指标目录搜索后`);
    await search.fill("");
    await expect(table.locator("tbody tr")).toHaveCount(50);
    await page.mouse.move(width - 10, 900); await page.mouse.wheel(0, 1600);
    await expectNoDetachedDocumentScroll(page, `${width} 指标目录滚动后`);
    await search.scrollIntoViewIfNeeded(); await search.focus();
    await expect(search).toBeFocused();
    await expect(search).toHaveAccessibleName("搜索指标");
  }
});
