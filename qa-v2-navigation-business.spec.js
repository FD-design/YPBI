import {selectReviewState} from './tools/qa-review-tools.mjs';
import { expect, test } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
const core = `${base}/dashboards/public?design=core-overview`;
// 本组验证开启比较后的图形、提示和导出；首次不对比由 global-query 回归覆盖。
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("ypbi.development-preview.query.v1", JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared: true, scope: "official_overall" })));
});

test("核心九卡时间趋势的纵轴、连续悬停、键盘与零值统一验收", async ({ page }) => {
  test.setTimeout(90_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(core);
  const cards = page.locator(".dashboard-metric-card:not(.is-value)");
  await expect(cards).toHaveCount(9);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const card of await cards.all()) {
      const labels = await card.locator(".dashboard-mini-trend__y-axis span").allTextContents();
      expect(labels.length).toBeGreaterThanOrEqual(2);
      expect(labels.length).toBeLessThanOrEqual(5);
      expect(new Set(labels).size).toBe(labels.length);
      expect(labels.join(" ")).not.toMatch(/千|万/);
      await expect(card.locator(".dashboard-mini-trend__unit")).toHaveCount(0);
      const values = labels.map(label => Number(label.replaceAll(",", "").replace("%", "")));
      const interval = values[0] - values[1];
      for (let i = 2; i < values.length; i++) expect(values[i - 1] - values[i]).toBeCloseTo(interval, 8);
      const ticks = await card.locator(".dashboard-mini-trend__y-axis span").evaluateAll(elements => elements.map(el => ({ y: el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2 })));
      const canvas = await card.locator(".dashboard-mini-trend__canvas").boundingBox();
      const grids = await card.locator(".dashboard-mini-trend svg > line").evaluateAll(elements => elements.map(el => Number(el.getAttribute("y1"))));
      expect(grids).toHaveLength(ticks.length);
      for (const [index, tick] of ticks.entries()) {
        expect(Math.abs(tick.y - canvas.y - canvas.height * grids[index] / 58)).toBeLessThan(1);
        if (index > 0) expect(tick.y - ticks[index - 1].y).toBeGreaterThan(15);
      }
      const info = card.getByRole("button", { name: /说明$/ }).first();
      await page.keyboard.press("Tab"); await info.focus();
      await expect(page.locator(".ui-hint-panel")).toBeVisible();
      await expect(page.locator(".ui-hint-panel")).not.toContainText(/[a-z]+_[a-z]+|COUNT\(|<span|单位：/);
      await page.keyboard.press("Escape");
    }
    await expect(cards.nth(1).locator(".dashboard-mini-trend.is-line")).toBeVisible();
    await expect(cards.nth(0).locator(".dashboard-mini-trend__y-axis span")).toHaveText(["210,000", "200,000", "190,000", "180,000", "170,000"]);
    const bars = page.locator(".dashboard-mini-trend.is-line");
    await expect(bars).toHaveCount(9);
    for (const bar of (await bars.all()).slice(0, 3)) {
      await bar.scrollIntoViewIfNeeded();
      for (const series of ["current", "comparison"]) {
        for (const index of [0, 3, 6]) {
          const point = bar.locator(`.dashboard-mini-trend__point.is-${series}`).nth(index);
          const box = await point.boundingBox();
          expect(box.height).toBeGreaterThan(50);
          for (const fraction of [.15, .5, .9]) {
            await point.hover({ position: { x: box.width / 2, y: box.height * fraction } });
            const tip = page.locator(".ui-hint-panel");
            await expect(tip).toHaveCount(1);
            await expect(tip).toContainText("当前 2026-09-");
            await expect(tip).toContainText("对比 2026-");
            await expect(tip).not.toContainText(/<span|style=|单位：/);
            const bounds = await tip.boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
            await page.keyboard.press("Escape");
          }
        }
      }
    }
    await cards.nth(3).scrollIntoViewIfNeeded();
    await page.keyboard.press("Tab"); await cards.nth(3).locator(".dashboard-mini-trend__point.is-current").nth(3).focus();
    await expect(page.locator(".ui-hint-panel")).toBeVisible();
    await page.screenshot({ path: `/private/tmp/ypbi-bar-body-${width}.png` });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/private/tmp/ypbi-core-final-${width}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await selectReviewState(page, '组合异常态');
  const zero = cards.filter({ has: page.getByRole("link", { name: "观影总时长", exact: true }) });
  await expect(zero.locator(".dashboard-metric-card__value strong")).toHaveText("0");
  for (const rect of await zero.locator("rect.is-current").all()) await expect(rect).toHaveAttribute("height", "0");
  await selectReviewState(page, '正常态');
  expect(errors).toEqual([]);
});

test("双月日期组件保持草稿、跨月、取消、上限及窄屏一致", async ({ page }) => {
  await page.goto(core);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const trigger = page.getByRole("button", { name: /^日期范围：/ });
    const original = await trigger.innerText();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "选择日期范围" });
    await expect(dialog.locator(".ui-date-panel__months > section")).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: /^今天/ })).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("button", { name: "过去 180 天", exact: true }).click();
    await expect(dialog.getByLabel("开始日期", { exact: true })).toHaveValue("2026-03-13");
    await expect(trigger).toHaveText(original);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole("button", { name: "2026.08.28", exact: true }).click();
    await dialog.getByRole("button", { name: "2026.09.03", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(trigger).toHaveText(original);
    await dialog.getByRole("button", { name: "确认日期", exact: true }).click();
    await expect(trigger).toHaveText("2026.08.28 — 2026.09.03");
    await expect(page.locator(".core-review__detail-actions time")).toHaveText("数据日 2026-09-08");
    await trigger.click();
    await dialog.getByLabel("开始日期", { exact: true }).fill("2026-09-07");
    await dialog.getByLabel("结束日期", { exact: true }).fill("2026-09-03");
    await expect(dialog.getByRole("button", { name: "确认日期", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "过去 7 天", exact: true }).click();
    await dialog.screenshot({ path: `/private/tmp/ypbi-dual-calendar-${width}.png` });
    await dialog.getByRole("button", { name: "确认日期", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("表格单位与辅助比较层级在核心总览和体验页共用规范", async ({ page }) => {
  await page.goto(core);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const table = page.locator(".core-review__comparison-table");
    await expect(table.locator("thead th > small")).toHaveCount(0);
    for (const [key, unit] of [["M102:overall", "小时"], ["M058:overall", "USD"], ["M067:overall", "USD/人"], ["M110:overall", "次/人"], ["M081:overall", "%"]]) {
      await expect(table.locator(`th[data-column-key="${key}"] .metric-heading-unit`)).toHaveText(`（${unit}）`);
    }
    for (const key of ["M001:overall", "M003:overall", "M060:overall"]) {
      await expect(table.locator(`th[data-column-key="${key}"] .metric-heading-unit`)).toHaveCount(0);
    }
    const units = await table.locator(".metric-heading-unit").allTextContents();
    expect(units.every(unit => ["（小时）", "（USD）", "（USD/人）", "（次/人）", "（%）", "（Android:iOS）"].includes(unit))).toBe(true);
    for (const unit of await table.locator(".metric-heading-unit").all()) {
      const geometry = await unit.evaluate(el => ({ unit: el.getBoundingClientRect().toJSON(), name: el.previousElementSibling.getBoundingClientRect().toJSON(), size: parseFloat(getComputedStyle(el).fontSize) }));
      expect(Math.abs(geometry.unit.y + geometry.unit.height / 2 - geometry.name.y - geometry.name.height / 2)).toBeLessThan(2);
      expect(geometry.size).toBe(11);
    }
    const comparisonSelect = page.getByRole("button", { name: /^经营明细变化参考：/ });
    await comparisonSelect.click();
    await page.getByRole("option", { name: "较昨日", exact: true }).click();
    const tableChanges = table.locator(".core-review__selected-change [data-change-direction]");
    expect(await tableChanges.count()).toBeGreaterThan(0);
    for (const change of await tableChanges.all()) {
      await expect(change).toHaveCSS("font-size", "11px");
      await expect(change).toHaveCSS("font-weight", "500");
    }
    await comparisonSelect.click();
    await page.getByRole("option", { name: "不显示", exact: true }).click();
    for (const tab of ["内容消费", "获客转化", "支付链路"]) {
      await page.getByRole("tab", { name: tab, exact: true }).click();
      const summary = await page.locator(".ui-metric-comparison").evaluateAll(elements => elements.filter(el => el.checkVisibility()).map(el => {
        const change = el.querySelector("[data-change-direction]");
        return { size: parseFloat(getComputedStyle(el).fontSize), valueSize: parseFloat(getComputedStyle(change).fontSize), weight: getComputedStyle(change).fontWeight };
      }));
      expect(summary.length).toBeGreaterThan(9);
      for (const item of summary) { expect(item.size).toBe(11); expect(item.valueSize).toBe(11); expect(item.weight).toBe("500"); }
    }
    if (width === 1280) {
      await page.locator('section[aria-labelledby="core-key-chains"]').screenshot({ path: "/private/tmp/ypbi-payment-comparison-refined.png" });
      await page.locator(".core-review__detail").screenshot({ path: "/private/tmp/ypbi-table-units-refined.png" });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  for (const item of await page.locator(".metric-summary__comparison [data-change-direction]").all()) {
    await expect(item).toHaveCSS("font-size", "11px");
    await expect(item).toHaveCSS("font-weight", "500");
  }
});

test("表头提示无遮挡、对比按行分层、导出诚实展示可用性", async ({ page }) => {
  await page.goto(core);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const header = page.locator(".core-review__comparison-table th.is-number").first();
    await expect(header).toHaveCSS("text-align", "right");
    await header.getByRole("button", { name: "查看日活跃用户数说明", exact: true }).hover();
    const tip = page.locator(".ui-hint-panel");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("统计方式");
    expect(await tip.evaluate(el => { const b = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })).toBe(true);
    await page.screenshot({ path: `/private/tmp/ypbi-header-hint-${width}.png` });
    const cell = page.locator(".core-review__detail-trigger").first();
    await page.keyboard.press("Tab"); await cell.focus();
    await expect(tip.locator(".core-review__tip-current strong")).toHaveCSS("font-size", "20px");
    await expect(tip.locator(".core-review__tip-current small")).toHaveCSS("font-size", "11px");
    const b = await tip.boundingBox(); expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: `/private/tmp/ypbi-table-hint-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    const rate = page.locator('#core-chain-panel-content [data-chain-item="relationship"] .metric-summary__comparison button');
    await page.keyboard.press("Tab"); await rate.focus();
    await expect(tip.locator(".ui-comparison-details__row")).toHaveCount(2);
    await expect(tip).toContainText("78.13 %");
    await expect(tip).toContainText("76.89 %");
    expect((await tip.boundingBox()).width).toBeLessThanOrEqual(360);
    await page.screenshot({ path: `/private/tmp/ypbi-comparison-hint-${width}.png` });
    await page.keyboard.press("Escape");
    const exportButton = page.getByRole("button", { name: "导出经营明细", exact: true });
    await exportButton.click();
    const dialog = page.getByRole("dialog", { name: "导出经营明细" });
    await expect(dialog).toContainText("不是正式业务结果");
    await expect(dialog.getByRole("button", { name: "下载演示 XLSX" })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: /^关闭/ })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(exportButton).toBeFocused();
  }
});

test("实际 ECharts 悬停渲染保留涨跌色且不显示标记代码", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 950 });
  for (const kind of ["kpi-detailed", "line-single", "line-comparison", "bar-time"]) {
    const panel = page.locator(`[data-chart-kind="${kind}"]`);
    await expect(panel).toBeVisible();
    const chart = panel.locator(".chart").first(); await chart.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const b = await chart.boundingBox();
    await page.mouse.move(b.x + b.width * .35, b.y + b.height * .35);
    const tip = page.locator(".ui-chart-tooltip").filter({ visible: true });
    await expect(tip, `真实图表 ${kind} 的悬停提示`).toBeVisible();
    await expect(tip).not.toContainText(/<span|data-change-direction|style=|var\(--/);
    await expect(tip).toHaveCSS("background-color", "rgb(31, 41, 55)");
    if (kind === "kpi-detailed" || kind === "line-comparison") {
      await expect(tip.locator("[data-change-direction]")).toHaveCount(1);
      await expect(tip.locator("[data-change-direction]")).toHaveCSS("color", "rgb(101, 214, 165)");
    }
    await page.screenshot({ path: `/private/tmp/ypbi-real-tooltip-${kind}.png` });
    await page.mouse.move(0, 0);
  }
  expect(errors).toEqual([]);
});

test("顶部导航悬停、键盘、跨菜单与点击外部共享一致状态", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(core);
  const nav = page.getByRole("navigation", { name: "产品主导航", exact: true });
  await expect(nav.getByRole("button")).toHaveCount(3);
  await expect(page.locator(".v2-sidebar")).toHaveCount(0);
  await expect(page.locator(".v2-topbar-brand")).toHaveCSS("border-right-width", "0px");
  await expect(nav.getByRole("button").first()).toHaveCSS("font-size", "14px");
  const data = nav.getByRole("button", { name: "数据中心", exact: true });
  await data.hover();
  await expect(data).toHaveAttribute("aria-expanded", "true");
  await nav.getByRole("link", { name: /^指标中心/ }).hover();
  await expect(data).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(core);
  await page.screenshot({ path: "/private/tmp/ypbi-top-navigation-1280.png" });
  const analysis = nav.getByRole("button", { name: "分析中心", exact: true });
  await analysis.hover();
  await expect(data).toHaveAttribute("aria-expanded", "false");
  await expect(analysis).toHaveAttribute("aria-expanded", "true");
  await analysis.press("ArrowDown");
  await expect(nav.getByRole("link", { name: /^指标分析/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(nav.getByRole("link", { name: /^已保存的分析/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(data).toBeFocused();
  await expect(analysis).toHaveAttribute("aria-expanded", "false");
  await analysis.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(analysis).toBeFocused();
  await expect(analysis).toHaveAttribute("aria-expanded", "false");
  await analysis.press("Space");
  await expect(analysis).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("tab", { name: "获客转化", exact: true }).click();
  await expect(analysis).toHaveAttribute("aria-expanded", "false");
  await page.setViewportSize({ width: 820, height: 1000 });
  await expect(nav).toHaveCount(0);
  await page.getByRole("button", { name: "打开主导航", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "产品导航", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("链路指标纵向就近排列且全部悬停说明不泄漏代码", async ({ page }) => {
  await page.goto(core);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [label, key] of [["内容消费", "content"], ["获客转化", "acquisition"], ["支付链路", "payment"]]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      const panel = page.locator(`#core-chain-panel-${key}`);
      for (const item of await panel.locator('[data-chain-item="relationship"]').all()) {
        const title = await item.locator(".core-review__metric-help").boundingBox();
        const number = await item.locator(".metric-summary__number").boundingBox();
        expect(number.y).toBeGreaterThanOrEqual(title.y + title.height);
        expect(Math.abs(number.x - title.x)).toBeLessThan(2);
        const sizes = await item.evaluate((element) => ({
          label: parseFloat(getComputedStyle(element.querySelector(".core-review__metric-help button")).fontSize),
          value: parseFloat(getComputedStyle(element.querySelector(".metric-summary__number strong")).fontSize)
        }));
        expect(sizes.value / sizes.label).toBeGreaterThanOrEqual(1.8);
      }
      for (const help of await panel.locator(".core-review__metric-help").all()) {
        await page.keyboard.press("Tab"); await help.getByRole("button").focus();
        const tooltip = page.locator(".ui-hint-panel");
        await expect(tooltip).toBeVisible();
        await expect(tooltip).not.toContainText(/[a-z]+_[a-z]+|COUNT\(|\bM\d{3}\b/);
        const bounds = await tooltip.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.keyboard.press("Tab"); await page.getByRole("tab", { name: label, exact: true }).focus();
      if (width === 1440 && key === "acquisition") await page.locator('section[aria-labelledby="core-key-chains"]').screenshot({ path: "/private/tmp/ypbi-chain-acquisition.png" });
    }
    const quality = page.getByRole("complementary", { name: "关键质量与数据状态", exact: true });
    await page.keyboard.press("Tab"); await quality.getByRole("button", { name: "查看启动成功率说明", exact: true }).focus();
    const tip = page.locator(".ui-hint-panel").filter({ hasText: "启动数" });
    const bounds = await tip.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("经营明细默认扫数，按需单组比较并可完整核对与关闭", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(core);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const table = page.locator(".core-review__comparison-table");
    const selector = page.getByRole("button", { name: /^经营明细变化参考：/ });
    await selector.click();
    await page.getByRole("option", { name: "不显示", exact: true }).click();
    await expect(table.locator("[data-change-direction]")).toHaveCount(0);
    const first = table.locator("tbody tr").first().locator(".core-review__detail-trigger").first();
    await expect(first.locator("b")).toHaveText("90,000");
    const height = (await table.locator("tbody tr").first().boundingBox()).height;
    expect(height).toBeLessThan(72);
    for (const label of ["较昨日", "较上周同日"]) {
      await selector.click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(first.locator("[data-change-direction]")).toHaveCount(1);
      await expect(first).not.toContainText(label);
    }
    await page.keyboard.press("Tab"); await first.focus();
    const tip = page.locator(".core-review__detail-tooltip");
    await expect(tip).toContainText("2026-09-07");
    await expect(tip).toContainText("2026-09-01");
    await expect(tip).toContainText("差值");
    const tipBounds = await tip.boundingBox();
    expect(tipBounds.x).toBeGreaterThanOrEqual(0);
    expect(tipBounds.x + tipBounds.width).toBeLessThanOrEqual(width);
    await first.click();
    const dialog = page.getByRole("dialog", { name: "日活跃用户数", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("88,000");
    await expect(dialog).toContainText("86,000");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(first).toBeFocused();
    await selector.click();
    await page.getByRole("option", { name: "不显示", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator(".core-review__detail").screenshot({ path: `/private/tmp/ypbi-clean-table-${width}.png` });
  }
  expect(errors).toEqual([]);
});

test("详细 KPI 摘要上置、趋势占满下方宽度", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const card = page.locator('[data-chart-kind="kpi-detailed"] .dashboard-metric-card');
  await expect(card).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const summary = await card.locator(".dashboard-metric-card__value").boundingBox();
    const chart = await card.locator(".chart").boundingBox();
    expect(chart.y).toBeGreaterThanOrEqual(summary.y + summary.height);
    expect(Math.abs(chart.width - summary.width)).toBeLessThan(2);
    await card.screenshot({ path: `/private/tmp/ypbi-detailed-kpi-${width}.png` });
  }
});
