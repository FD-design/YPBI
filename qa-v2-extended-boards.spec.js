import {selectReviewState} from './tools/qa-review-tools.mjs';
import { test, expect } from "@playwright/test";
test.use({ channel: "chrome" });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
const boards = { "5.10": "会员与付费经营", "5.11": "支付链路与到账质量", "5.12": "播放与观看质量", "5.13": "内容发现与互动", "5.14": "运营玩法概览", "5.15": "产品体验与启动质量" };
const capturePanel = async (page, panel, path) => { await panel.evaluate(element => element.scrollIntoView({ block: "start" })); await page.waitForTimeout(100); await page.screenshot({ path }); };
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: "/private/tmp/ypbi-extended-failure.png", fullPage: true }); });
test("六张专题实际渲染、统一标题、桌面与移动边界、数据表单一关闭", async ({ page }) => {
  test.setTimeout(90000);
  for (const [board, title] of Object.entries(boards)) for (const width of [1800, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board}`);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    if(board==="5.11")await page.getByText("提交、下单、回调与到账指标",{exact:true}).click();
    await expect(page.locator(".dashboard-metric-card").first()).toContainText("2026-09-02");
    expect(await page.locator(".dashboard-header h1").evaluate(el => ({ size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }))).toEqual({ size: "24px", weight: "700" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const card = page.locator(".dashboard-metric-card").first();
    await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("tbody tr")).toHaveCount(7);
    await expect(dialog.getByRole("button", { name: /^关闭/ })).toHaveCount(1);
    await expect(dialog.locator("footer")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `/private/tmp/ypbi-board-${board}-${width}.png` });
  }
});
test("单日整月长区间、真实应用和刷新保留；异常重试不清空相邻结果", async ({ page }) => {
  test.setTimeout(90000);
  for (const board of Object.keys(boards)) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const range of [{ start: "2026-09-03", end: "2026-09-03" }, { start: "2026-08-01", end: "2026-08-31" }, { start: "2026-06-01", end: "2026-08-31" }]) {
      const view = { range, compared: false, mixed: false };
      await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board}&view=${encodeURIComponent(JSON.stringify(view))}`);
      if(board==="5.11")await page.getByText("提交、下单、回调与到账指标",{exact:true}).click();
      const card = page.locator(".dashboard-metric-card").first();
      await expect(card).toContainText(range.start);
      const text = await card.textContent();
      await page.getByRole("button", { name: "刷新看板", exact: true }).click();
      await expect(card).toHaveText(text);
      await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
      await expect(page.getByRole("dialog").locator("tbody tr").first()).toContainText(range.start);
      await page.keyboard.press("Escape");
    }
    await selectReviewState(page, '组合异常态');
    if (board !== "5.11") {
      await expect(page.getByText("当前指标加载失败", { exact: true }).first()).toBeVisible();
      const retry = page.getByRole("button", { name: /重试/ }).first(); await retry.click();
      await expect(page.getByText("当前指标加载失败", { exact: true })).toHaveCount(0);
    }
  }
});
test("二维交叉、一级分类全集与高基数排行保留完整表", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.10`);
  await page.getByText("更多付费拆解",{exact:true}).click();
  await page.getByRole("button", { name: /^付费结构分组：/ }).click();
  await page.getByRole("option", { name: "平台 × 新老用户", exact: true }).click();
  const pivot = page.getByRole("table", { name: "付费结构二维交叉表" });
  await expect(pivot.locator("thead th")).toHaveText(["平台 × 新老用户", "新用户", "老用户"]);
  await expect(pivot.locator("tbody tr")).toHaveCount(3);
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13`);
  const panel = page.getByRole("article", { name: "一级分类导航比较", exact: true });
  await expect(panel.locator(".board-preview__category-scroll")).toBeVisible();
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(12);
  await page.keyboard.press("Escape");
  const ranking = page.getByRole("article", { name: "视频互动排行", exact: true });
  await ranking.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("navigation")).toContainText("共 126 条");
  await page.getByRole("dialog").getByRole("button", { name: "第 3 页", exact: true }).click();
  await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(26);
});

test("内容发现与搜索常驻同源明细，排序及单行趋势可核对", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13`);

  const discovery = page.getByRole("article", { name: "内容发现总体与位置", exact: true });
  await expect(discovery.getByLabel("内容发现总体摘要")).toContainText("曝光-点击转化率");
  await expect(page.locator(".dashboard-metric-card").filter({ hasText: "视频内容曝光-点击转化率" })).toHaveCount(0);
  const positions = discovery.getByRole("table", { name: "内容发现位置完整结果" });
  await expect(positions.locator("tbody tr")).toHaveCount(8);
  await expect(positions.locator("tbody tr").first().locator("td").nth(2)).toHaveText("演示位置 01");
  await expect(discovery).not.toContainText("demo-位置-");
  await discovery.getByRole("button", { name: /^内容发现总体与位置排序：/ }).click();
  await page.getByRole("option", { name: "按转化率降序", exact: true }).click();
  await expect(positions.locator("tbody tr").first().locator("td").nth(2)).toHaveText("演示位置 04");
  await positions.locator("tbody tr").first().getByRole("button", { name: "查看趋势", exact: true }).click();
  const positionDialog = page.getByRole("dialog");
  await expect(positionDialog).toContainText("演示位置 04 · 曝光点击趋势");
  await positionDialog.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const trendTable = page.getByRole("dialog", { name: "视频内容曝光-点击转化率同口径数据表" });
  await expect(trendTable.getByRole("button", { name: /导出演示位置 04曝光点击趋势/ })).toBeVisible();
  await expect(trendTable.getByRole("table", { name: "视频内容曝光-点击转化率逐日数据" }).locator("tbody tr")).toHaveCount(7);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  const search = page.getByRole("article", { name: "搜索需求", exact: true });
  const searchTable = search.getByRole("table", { name: "搜索需求完整结果" });
  await expect(searchTable.locator("thead")).toContainText("搜索次数");
  await expect(searchTable.locator("thead")).toContainText("搜索用户数");
  await expect(searchTable.locator("thead")).toContainText("搜索承接率");
  await expect(search.getByRole("navigation", { name: "搜索需求完整结果分页" })).toContainText("共 126 条");
  await expect(search).not.toContainText("demo-搜索词-");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await capturePanel(page, discovery, "/private/tmp/ypbi-227-content-discovery-1280.png");
  await capturePanel(page, search, "/private/tmp/ypbi-227-search-demand-1280.png");
  await page.setViewportSize({ width: 390, height: 1000 });
  await capturePanel(page, discovery, "/private/tmp/ypbi-227-content-discovery-390.png");
  await capturePanel(page, search, "/private/tmp/ypbi-227-search-demand-390.png");
});

test("M109 全局来源与视频首页分类同屏，TopN 不裁表格和导出", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.13`);

  const section = page.locator('section[aria-label="视频点击来源"]');
  const overall = section.getByLabel("视频点击来源总体");
  const sources = section.getByRole("article", { name: "全局页面与列表来源", exact: true });
  const categories = section.getByRole("article", { name: "视频首页一级分类内容点击", exact: true });
  await expect(overall.locator(".dashboard-metric-card")).toHaveCount(1);
  await expect(overall).toContainText("视频内容点击次数");
  await expect(overall).toContainText("全局来源合计");
  await expect(sources).toBeVisible();
  await expect(categories).toBeVisible();
  await expect(categories).toContainText("分类层级：一级");
  const sourceTable = sources.getByRole("table", { name: "视频点击来源完整结果" });
  await expect(sourceTable.locator("tbody tr")).toHaveCount(19);
  await expect(sourceTable).toContainText("未知来源");
  await expect(sourceTable).toContainText("不受 Tab 控制");
  await expect(sources.getByRole("navigation", { name: "视频点击来源完整结果分页" })).toContainText("共 19 条");
  const readCount = text => Number(text.replace(/[^\d.-]/g, ""));
  const globalCount = readCount(await overall.locator(".dashboard-metric-card__value strong").innerText());
  const sourceRows = sourceTable.locator("tbody tr");
  const sourceCount = (await sourceRows.locator("td:nth-child(4)").allInnerTexts()).reduce((sum, value) => sum + readCount(value), 0);
  const videoHomeCount = await sourceRows.evaluateAll(rows => rows.reduce((sum, row) => {
    const cells = row.querySelectorAll("td");
    return sum + (cells[0]?.textContent?.trim() === "视频首页" ? Number((cells[3]?.textContent ?? "").replace(/[^\d.-]/g, "")) : 0);
  }, 0));
  expect(sourceCount).toBe(globalCount);

  const sourceAndCategory = await Promise.all([sources, categories].map(item => item.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  })));
  expect(sourceAndCategory[1].top - sourceAndCategory[0].bottom).toBeGreaterThanOrEqual(14);

  await overall.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(7);
  await page.keyboard.press("Escape");

  await categories.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const categoryDialog = page.getByRole("dialog");
  await expect(categoryDialog.locator("tbody tr")).toHaveCount(12);
  await expect(categoryDialog.getByRole("button", { name: "查看趋势", exact: true }).first()).toBeVisible();
  const categoryCount = (await categoryDialog.locator("tbody tr td:nth-child(3)").allInnerTexts()).reduce((sum, value) => sum + readCount(value), 0);
  expect(categoryCount).toBe(videoHomeCount);
  expect(categoryCount).toBeLessThanOrEqual(globalCount);
  await page.keyboard.press("Escape");

  await sources.getByRole("button", { name: "导出全局视频点击来源", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出全局视频点击来源" });
  const downloadPromise = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await section.evaluate(element => element.scrollIntoView({ block: "start" }));
    await expect(section).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-228-video-click-source-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await capturePanel(page, categories, "/private/tmp/ypbi-228-video-home-category-1280.png");
  await page.setViewportSize({ width: 390, height: 1000 });
  await capturePanel(page, categories, "/private/tmp/ypbi-228-video-home-category-390.png");

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.10`);
  const paymentSection = page.locator('section[aria-label="新用户与用户价值"]');
  const paymentPanel = paymentSection.getByRole("article", { name: "新老用户付费表现", exact: true });
  const paymentGrid = paymentSection.locator(".topic-preview__grid");
  const paymentGap = await Promise.all([paymentPanel, paymentGrid].map(item => item.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  })));
  expect(paymentGap[1].top - paymentGap[0].bottom).toBeGreaterThanOrEqual(14);
});

test("播放与启动移除网络展示，诊断表保留直接计算输入", async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.12`);
  const playback = page.getByRole("article", { name: "播放质量诊断", exact: true });
  await playback.getByRole("button", { name: /^播放质量诊断分组：/ }).click();
  await expect(page.getByRole("option", { name: "网络", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "平台 × 网络", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const playbackInputs = playback.getByRole("region", { name: "播放质量诊断计算输入表" });
  await expect(playbackInputs.locator("tbody tr")).toHaveCount(3);
  await expect(playbackInputs).not.toContainText("待接入");

  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.15`);
  await expect(page.getByRole("heading", { name: "启动诊断", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全局导航", exact: true })).toHaveCount(0);
  const startupGrid = page.locator(".board-preview__startup-grid");
  const success = page.locator(".dashboard-metric-card").filter({ hasText: "启动成功率" });
  const starts = page.locator(".dashboard-metric-card").filter({ hasText: "应用启动次数" });
  await expect(success).toHaveClass(/is-detailed/);
  await expect(starts).not.toHaveClass(/is-detailed/);
  const widths = await Promise.all([success, starts].map(card => card.evaluate(element => element.getBoundingClientRect().width)));
  expect(widths[0]).toBeGreaterThan(widths[1] * 1.35);
  await expect(success.getByRole("button", { name: "计算依据", exact: false })).toBeVisible();
  const startup = page.getByRole("article", { name: "启动结构与质量诊断", exact: true });
  await startup.getByRole("button", { name: /^启动结构与质量诊断分组：/ }).click();
  await expect(page.getByRole("option", { name: "网络", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "平台 × 网络", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(startup.getByRole("region", { name: "启动结构与质量诊断计算输入表" })).not.toContainText("待接入");
  await startupGrid.screenshot({ path: "/private/tmp/ypbi-227-startup-main-auxiliary-1280.png" });
  await page.setViewportSize({ width: 390, height: 900 });
  await startupGrid.screenshot({ path: "/private/tmp/ypbi-227-startup-main-auxiliary-390.png" });
});
