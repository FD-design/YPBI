import {selectReviewState} from './tools/qa-review-tools.mjs';
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
const url = `${base}/dashboards/public?design=dashboard-center&board=5.7`;
test.use({ channel: "chrome" });
test.beforeEach(async ({page}) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("ypbi.development-preview.query.v1")) sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({range:{start:"2026-09-02",end:"2026-09-08"},compared:true,scope:"official_overall"})); });
});
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) { await page.screenshot({ path: `/private/tmp/ypbi-acquisition-failure-${info.line}.png` }); console.log(await page.locator(".ui-chart-tooltip").evaluateAll(elements => elements.map(element => ({ style: element.getAttribute("style"), text: element.textContent })))); } });

test("收藏右对齐、标题无装饰箭头、明细工具区无重复基线", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 }); await page.goto(url);
  await page.getByRole("button", { name: "收藏看板", exact: true }).click();
  const entry = page.locator(".dashboard-directory__item").filter({ hasText: "获客与新增" }).first();
  const geometry = await entry.evaluate(el => ({ right: el.getBoundingClientRect().right, star: el.querySelector("svg").getBoundingClientRect().right, padding: parseFloat(getComputedStyle(el).paddingRight) }));
  expect(geometry.right - geometry.star).toBeCloseTo(geometry.padding, 0);
  await expect(page.locator(".dashboard-metric-card header a svg")).toHaveCount(0);
  const details = page.locator(".acquisition-preview__details");
  await expect(details.locator(".acquisition-preview__detail-block > header").first()).toHaveCSS("border-bottom-width", "0px");
  await expect(details.getByRole("tablist")).toHaveCSS("border-bottom-width", "0px");
  await expect(details.getByRole("tab", { selected: true })).toHaveCSS("border-bottom-width", "2px");
  await page.locator(".dashboard-metric-card header a").first().click();
  await expect(page.getByRole("dialog", { name: /指标分析$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/private/tmp/ypbi-table-toolbar-favorite.png" });
});

test("同口径表右上导出完整单指标文件，嵌套弹层焦点及窄屏稳定", async ({ page }) => {
  await page.goto(url);
  const card = page.locator(".dashboard-metric-card").nth(5);
  const openTable = card.getByRole("button", { name: "查看同口径数据表", exact: true });
  await openTable.click(); const table = page.getByRole("dialog", { name: "访问-注册转化率同口径数据表", exact: true });
  const trigger = table.getByRole("button", { name: /^导出/ }); await expect(trigger).toHaveCount(1);
  await trigger.click(); const exporter = page.getByRole("dialog", { name: /^导出/ });
  await exporter.getByRole("button", { name: "关闭导出", exact: true }).click(); await expect(trigger).toBeFocused();
  await page.keyboard.press("Tab"); await expect(table.getByRole("button", { name: "关闭数据表", exact: true })).toBeFocused();
  await trigger.click(); const downloading = page.waitForEvent("download"); await exporter.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  const file = await downloading; expect(file.suggestedFilename()).toBe("访问-注册转化率同口径数据表-演示数据.xlsx");
  await file.saveAs("/private/tmp/ypbi-metric-trend-export.xlsx");
  const raw = (await readFile(await file.path())).toString(); expect(raw).toContain("01_同口径数据表"); expect(raw).toContain("差值（百分点）"); expect(raw).not.toContain("二次有效观看用户数"); expect(raw).toContain("2026-08-26");
  await expect(table.locator("tbody tr")).toHaveCount(7); await expect(trigger).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const element of [table, trigger]) { const box = await element.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390); }
  await page.screenshot({ path: "/private/tmp/ypbi-metric-table-export-mobile.png" });
  await trigger.click(); await expect(exporter).toBeVisible(); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await page.keyboard.press("Escape"); await expect(openTable).toBeFocused();
});

test("获客九卡多端、真实图形空白区连续悬停与数值层级", async ({ page }) => {
  const errors = [], requests = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(`${base}/api/**`, route => { requests.push(route.request().url()); return route.abort(); });
  await page.goto(url);
  const cards = page.locator(".dashboard-metric-card.is-detailed");
  await expect(cards).toHaveCount(9);
  for (const width of [1800, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await cards.first().scrollIntoViewIfNeeded();
    const columns = await page.locator(".acquisition-preview__grid").first().evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(width >= 1600 ? 3 : width > 900 ? 2 : 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const index of [0, 3]) {
      const card = cards.nth(index); await card.scrollIntoViewIfNeeded();
      const chart = card.locator(".chart");
      await expect(chart.locator("canvas")).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const box = await chart.boundingBox();
      for (const x of [.35, .6, .85]) {
        await page.mouse.move(box.x + box.width * x, box.y + box.height * .30);
        const tip = page.locator(".ui-chart-tooltip:visible"); await expect(tip).toContainText("当前期 2026-09-"); await expect(tip).not.toContainText(/<span|style=|单位：/);
      }
      const type = await card.evaluate(element => ({ label: parseFloat(getComputedStyle(element.querySelector("header a")).fontSize), value: parseFloat(getComputedStyle(element.querySelector(".dashboard-metric-card__value strong")).fontSize), compare: parseFloat(getComputedStyle(element.querySelector(".ui-metric-comparison")).fontSize) }));
      expect(type.value).toBeGreaterThanOrEqual(type.label * 1.8); expect(type.compare).toBeLessThan(type.label);
    }
    await page.mouse.move(0, 0); await page.locator(".dashboard-workbench__content").evaluate(element => element.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: `/private/tmp/ypbi-acquisition-${width}.png` });
  }
  expect(errors).toEqual([]); expect(requests).toEqual([]);
});

test("局部分组、无对比、说明、真实0与单卡恢复", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("button", { name: /^明细行分组：/ })).toHaveCount(0);
  const table = page.locator('[data-acquisition-section="target"]');
  await expect(table).toContainText("Android"); await expect(table.getByRole("button", { name: "排序下载点击-注册转化率", exact: true })).toHaveCount(0);
  await table.scrollIntoViewIfNeeded();
  const cell = table.getByRole("button", { name: "Android · 新增用户数详情", exact: true }); await page.keyboard.press("Tab"); await cell.focus();
  await expect(page.locator(".ui-hint-panel")).toContainText("当前期");
  await expect(table.locator("tbody td").nth(6)).toHaveCSS("white-space", "nowrap");
  for (let column = 2; column <= 6; column++) {
    const edges = await table.locator(`tbody td:nth-child(${column}) .acquisition-preview__value`).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().right));
    expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(1);
  }
  await page.screenshot({ path: "/private/tmp/ypbi-acquisition-table-tooltip.png" }); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^对比周期：/ }).click(); await page.getByRole("option", { name: "不对比", exact: true }).click(); await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator(".dashboard-metric-card__comparison")).toHaveCount(0);
  const card = page.locator(".dashboard-metric-card").first(); await card.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    await card.locator(".chart").hover({ position: { x: 90, y: 80 } });
    await card.locator(".chart").hover({ position: { x: 120, y: 80 } });
    return page.locator(".ui-chart-tooltip:visible").count();
  }).toBe(1);
  await expect(page.locator(".ui-chart-tooltip:visible")).not.toContainText("对比期");
  await page.keyboard.press("Tab"); await card.getByRole("button", { name: /说明$/ }).focus(); await expect(page.locator(".ui-hint-panel")).toContainText("有效落地页访问记录数"); await page.keyboard.press("Escape");
  await selectReviewState(page, '组合异常态'); await expect(page.locator(".dashboard-metric-card.is-not_produced")).toHaveCount(1); await expect(page.locator(".dashboard-metric-card.is-failed")).toHaveCount(1);
  await page.getByRole("button", { name: "重试此卡", exact: true }).click(); await expect(page.locator(".dashboard-metric-card.is-failed")).toHaveCount(0); await expect(page.locator(".dashboard-metric-card.is-not_produced")).toHaveCount(1);
});

test("收藏跨刷新保留，复制还原视图，导出真实演示XLSX", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(url); await page.getByRole("button", { name: "收藏看板", exact: true }).click(); await page.reload(); await expect(page.getByRole("button", { name: "取消收藏", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "搜索来源渠道" }).fill("推广");
  await page.getByRole("button", { name: "复制当前视图链接", exact: true }).click(); const copied = await page.evaluate(() => navigator.clipboard.readText()); expect(copied).toContain("view=");
  await page.goto(copied); await expect(page.getByRole("textbox", { name: "搜索来源渠道" })).toHaveValue("推广");
  await page.getByRole("button", { name: "导出获客与新增", exact: true }).click(); await expect(page.getByRole("dialog", { name: "导出获客与新增" })).toContainText("演示数据");
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "下载演示 XLSX", exact: true }).click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain("演示数据.xlsx"); await download.saveAs("/private/tmp/ypbi-acquisition-export.xlsx");
  if (!await page.getByRole("button", { name: /^来源渠道：/ }).isVisible()) await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page.getByRole("button", { name: /^来源渠道：/ }).click(); await page.getByRole("option", { name: /^推广渠道 A/ }).click();
  if (await page.getByRole("button", { name: "完成", exact: true }).isVisible()) await page.getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click(); await expect(page.getByRole("heading", { name: "此条件暂不可展示" })).toBeVisible(); await expect(page.locator(".dashboard-metric-card")).toHaveCount(0);
  await page.getByRole("button", { name: "恢复默认体验", exact: true }).click(); await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
});

test("核心折线与柱状整幅日期带连续命中，无透明区域矩形边框", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${base}/dashboards/public?design=core-overview`);
  for (const index of [0, 1, 3, 4]) {
    const chart = page.locator(".dashboard-metric-card").nth(index).locator(".dashboard-mini-trend__canvas"); await chart.scrollIntoViewIfNeeded(); const box = await chart.boundingBox();
    for (const fraction of [.01, .1, .32, .55, .79, .99]) for (const y of [.2, .45, .8]) {
      await page.mouse.move(box.x + box.width * fraction, box.y + box.height * y);
      await expect(page.locator(".ui-hint-panel")).toHaveCount(1); await expect(page.locator(".ui-hint-panel")).toContainText(/当前(?:期)? 2026-09-/);
      const hovered = chart.locator(".dashboard-mini-trend__point:hover"); await expect(hovered).toHaveCSS("box-shadow", "none");
    }
    const last = chart.locator(".dashboard-mini-trend__point.is-current").last(); await page.keyboard.press("Tab"); await last.focus(); await expect(last).toHaveCSS("outline-style", "none"); await expect(page.locator(".ui-hint-panel")).toContainText("2026-09-08");
    const lastBox = await last.boundingBox();
    await page.mouse.move(lastBox.x + lastBox.width * .5, lastBox.y + lastBox.height * .5);
    await expect(page.locator(".ui-hint-panel")).toContainText("2026-09-08");
    await page.evaluate(() => { window.__hintOpens = 0; if (!window.__countHintOpen) { window.__countHintOpen = () => window.__hintOpens++; document.addEventListener("ui-hint-open", window.__countHintOpen); } });
    expect(await last.evaluate(el => getComputedStyle(el, "::before").pointerEvents)).toBe("none");
    for (const offset of [.3, .4, .5, .6, .7]) {
      await page.mouse.move(lastBox.x + lastBox.width * offset, lastBox.y + lastBox.height * .5);
      expect(await last.evaluate(el => el.matches(":hover"))).toBe(true);
    }
    expect(await page.evaluate(() => window.__hintOpens)).toBe(0);
    await page.keyboard.press("Escape");
  }
  await page.mouse.move(0, 0); await page.screenshot({ path: "/private/tmp/ypbi-continuous-hover-fixed.png" });
});

test("宽屏铺满工作区，桌面筛选靠右且窄屏全部可达", async ({ page }) => {
  await page.goto(url);
  for (const width of [2560, 1800, 1440, 1280, 1180, 1100, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const root = page.locator('.acquisition-preview'); await expect(root).toBeVisible();
    await expect.poll(async () => root.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    const geometry = await root.evaluate(el => { const parent = el.parentElement; const rect = el.getBoundingClientRect(); const outer = parent.getBoundingClientRect(); const style = getComputedStyle(parent); const title = el.querySelector('h1').getBoundingClientRect(); const filters = el.querySelector('.acquisition-preview__filters').getBoundingClientRect(); return { left: rect.left - outer.left, padding: parseFloat(style.paddingLeft), width: rect.width, available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), title, filters }; });
    expect(geometry.left).toBeCloseTo(geometry.padding, 0); expect(geometry.width).toBeCloseTo(geometry.available, 0);
    const dateIcons = await page.locator('.acquisition-preview__filters .ui-date-range__trigger svg').evaluateAll(els => els.map(el => el.getBoundingClientRect().width)); expect(dateIcons).toEqual([14, 14]);
    if (width >= 1600) { expect(geometry.filters.top).toBeLessThan(geometry.title.bottom); expect(geometry.filters.left).toBeGreaterThan(geometry.title.right); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const more = page.getByRole('button', { name: '更多筛选', exact: true });
    if (await more.isVisible()) { await more.click(); await expect(page.getByRole('button', { name: /^来源渠道：/ })).toBeVisible(); const panel = await page.locator('.ui-filter-popover__panel').boundingBox(); expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.x + panel.width).toBeLessThanOrEqual(width); await page.getByRole('button', { name: '完成', exact: true }).click(); }
    if ([2560, 1280, 390].includes(width)) await page.screenshot({ path: `/private/tmp/ypbi-review-layout-${width}.png` });
  }
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.getByRole('button', { name: '收起目录', exact: true }).click();
  await expect.poll(async () => page.locator('.acquisition-preview').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1700);
  await page.getByRole('button', { name: '切换全屏', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  expect(await page.locator('.acquisition-preview').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '切换全屏', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
});

test("数据表独立打开关闭不改变邻卡几何与阅读位置", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 }); await page.goto(url);
  const cards = page.locator('.dashboard-metric-card.is-detailed'); const card = cards.nth(8); const neighbor = cards.nth(7);
  await card.scrollIntoViewIfNeeded();
  const geometry = () => neighbor.evaluate(el => { const rect = el.getBoundingClientRect(), chart = el.querySelector('.chart').getBoundingClientRect(); return { x: rect.x, y: rect.y, height: rect.height, chartY: chart.y, scroll: el.closest('.dashboard-workbench__content').scrollTop }; });
  const before = await geometry();
  const trigger = card.getByRole('button', { name: '查看同口径数据表', exact: true }); await trigger.click();
  const dialog = page.getByRole('dialog', { name: '二次有效观看用户数同口径数据表' }); await expect(dialog).toBeVisible();
  await expect(dialog.locator('tbody tr')).toHaveCount(7); await expect(dialog.locator('thead')).toContainText('日期');
  expect(await geometry()).toEqual(before);
  await page.screenshot({ path: '/private/tmp/ypbi-review-data-dialog.png' });
  await dialog.getByRole('button', { name: '2026-09-02', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '二次有效观看用户数 · 趋势详情', exact: true }); await expect(detail).toBeVisible(); await expect(detail).toContainText('2,040');
  await page.keyboard.press('Escape'); await expect(detail).toHaveCount(0); await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); expect(await geometry()).toEqual(before);
  await trigger.click(); await dialog.getByRole('button', { name: '关闭数据表', exact: true }).click(); expect(await geometry()).toEqual(before);
  await page.setViewportSize({ width: 390, height: 844 }); await trigger.click(); await expect(dialog).toBeVisible(); const small = await dialog.boundingBox(); expect(small.x).toBeGreaterThanOrEqual(0); expect(small.x + small.width).toBeLessThanOrEqual(390); expect(small.y + small.height).toBeLessThanOrEqual(844); await expect(dialog.locator('thead')).toBeVisible(); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
});

test("同类筛选相邻、搜索单层焦点、悬停只强调当前卡且对比分隔弱化", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 }); await page.goto(url);
  const controls = page.locator('[data-acquisition-section="channel"] .acquisition-preview__table-controls'); const search = page.getByRole('textbox', { name: '搜索来源渠道' });
  await page.keyboard.press("Tab"); await search.focus(); await expect(search).toHaveCSS('outline-style', 'none'); await expect(search).toHaveCSS('box-shadow', 'none');
  const order = await controls.locator(':scope > .ui-menu-select, :scope > .ui-search').evaluateAll(els => els.map(el => el.classList.contains('ui-search') ? 'search' : 'select'));
  expect(order).toEqual(['select', 'search']);
  const ring = await search.locator('..').evaluate(el => getComputedStyle(el).boxShadow); expect(ring).not.toBe('none');
  const sizes = await controls.locator(':scope > .ui-menu-select > button, :scope > .ui-search').evaluateAll(els => els.map(el => el.getBoundingClientRect().height)); expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  const cards = page.locator('.dashboard-metric-card'); await cards.first().scrollIntoViewIfNeeded();
  const normal = await cards.nth(1).evaluate(el => getComputedStyle(el).borderColor);
  for (const index of [0, 1]) { const card = cards.nth(index); const before = await card.boundingBox(); await card.hover({ position: { x: 10, y: 10 } }); await expect.poll(async () => card.evaluate(el => getComputedStyle(el).borderColor)).not.toBe(normal); expect(await card.boundingBox()).toEqual(before); if(index) await expect(cards.first()).toHaveCSS('border-color', normal); }
  const newUsers = cards.filter({ has: page.getByRole('link', { name: '新增用户数', exact: true }) });
  await newUsers.getByRole('button', { name: '较前一天 -2.49%', exact: true }).hover();
  const tip = page.locator('.ui-hint-panel:visible');
  await expect(tip.locator('.ui-comparison-details__row')).toHaveText(['所选日6,826 人2026-09-08', '对比日7,000 人2026-09-07']);
  await expect(tip.locator('.ui-comparison-details__change')).toContainText(['-174.00 人', '-2.49%']);
  const rules = await tip.locator('.ui-comparison-details__change').evaluateAll(els => els.map(el => ({ width: getComputedStyle(el).borderTopWidth, color: getComputedStyle(el).borderTopColor })));
  expect(rules.map(rule => rule.width)).toEqual(['1px', '0px']); expect(rules[0].color).toContain('0.16');
  await page.screenshot({ path: '/private/tmp/ypbi-review-comparison.png' });
});
