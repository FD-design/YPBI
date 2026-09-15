import { expect, test } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: "/private/tmp/ypbi-period-failure.png", fullPage: true }); });

test("日期单天与跨月长周期：草稿、应用、结果日期和导出同源", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  for (const width of [1440, 390]) for (const start of ["2026-09-08", "2026-08-10", "2026-06-11"]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole("button", { name: /^日期范围：/ }).click();
    const picker = page.getByRole("dialog", { name: "选择日期范围" });
    await picker.getByLabel("开始日期", { exact: true }).fill(start);
    await picker.getByLabel("结束日期", { exact: true }).fill("2026-09-08");
    await picker.getByRole("button", { name: "确认日期", exact: true }).click();
    await expect(page.getByText("条件尚未应用", { exact: true })).toBeVisible();
    await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
    const card = page.locator(".dashboard-metric-card").first();
    await expect(card).toContainText(start);
    await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
    const table = page.getByRole("dialog", { name: "落地页访问次数同口径数据表" });
    await expect(table.locator("tbody tr").first()).toContainText(start);
    await expect(table.locator("footer")).toHaveCount(0);
    await expect(table.getByRole("button", { name: /^关闭/ })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "导出获客与新增", exact: true }).click();
    await expect(page.getByRole("button", { name: "下载演示 XLSX", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.goto(base + "/dashboards/public?design=dashboard-center&board=5.7");
    await expect(page.locator(".dashboard-metric-card")).toHaveCount(9);
  }
});

// 仅浏览器测试挂载：使用真实共享组件与明确标注的合成布局数据，不扩展产品查询能力。
async function mountPeriods(page, count) {
  await page.evaluate(async count => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { DashboardMetricCard } = await import("/src/v2/features/dashboards/DashboardMetricCard.tsx");
    const { acquisitionCards } = await import("/src/v2/design/acquisition-preview-model.ts");
    document.querySelector("#root").style.display = "none";
    window.__periodRoot?.unmount(); document.querySelector("#period-qa")?.remove();
    const host = document.createElement("div"); host.id = "period-qa"; host.className = "ypbi-v2"; document.body.append(host);
    const date = i => new Date(Date.UTC(2026, 8, 8) - (count - 1 - i) * 86400000).toISOString().slice(0, 10);
    const modelFor = kind => {
      const model = structuredClone(acquisitionCards(true)[kind === "bar" ? 2 : 5].model);
      model.metric.name = `布局测试 · ${kind === "bar" ? "新增用户数" : "访问-注册转化率"}`;
      const result = model.result; result.trendKind = kind;
      const value = (raw, actualDate) => ({ raw, actualDate, unit: result.value.unit, display: kind === "bar" ? `${raw.toLocaleString()} 人` : `${(raw * 100).toFixed(2)} %` });
      result.trend.current = Array.from({ length: count }, (_, i) => {
        const raw = kind === "bar" ? 2000 + (i % 9) * 83 : .15 + (i % 9) * .001;
        const counterpart = value(raw * .98, date(i - count));
        return { ...result.trend.current[0], key: `day-${i}`, actualDate: date(i), label: date(i), value: value(raw, date(i)), counterpart, differenceDisplay: kind === "bar" ? `${(raw * .02).toFixed(2)} 人` : `${(raw * 2).toFixed(2)} 个百分点` };
      });
      result.trend.comparison = result.trend.current.map((point, i) => ({ ...point, key: `previous-${i}`, actualDate: point.counterpart.actualDate, value: point.counterpart, counterpart: { ...point.value, actualDate: point.actualDate } }));
      model.metric.aggregationLabel = `${date(0)} 至 ${date(count - 1)} · ${count} 天布局样本`;
      const total = result.trend.current.reduce((sum, point) => sum + point.value.raw, 0);
      result.value.raw = kind === "bar" ? total : total / count;
      result.value.display = kind === "bar" ? total.toLocaleString() : (total / count * 100).toFixed(2);
      result.comparison = { ...result.comparison, display: kind === "bar" ? "2.04%" : `${(total / count * 2).toFixed(2)} 个百分点`, direction: "up", rows: [], difference: undefined };
      return model;
    };
    const nodes = ["compact", "detailed"].flatMap(variant => ["bar", "line"].map(kind => React.createElement(DashboardMetricCard, { key: variant + kind, model: modelFor(kind), variant, ...(variant === "detailed" ? { tableExport: React.createElement("button", { disabled: true }, "导出（布局测试）") } : {}), analysisHref: "#", onOpenAnalysis: () => {}, onOpenDefinition: () => {}, onOpenComparison: () => {}, onOpenTrendPoint: () => {} })));
    window.__periodRoot = createRoot(host);
    window.__periodRoot.render(React.createElement("main", { style: { padding: 16 } }, React.createElement("h1", { style: { fontSize: 18 } }, `${count} 天 · 合成布局测试（非业务数据）`), React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 16, alignItems: "start" } }, ...nodes)));
  }, count);
  await expect(page.locator("#period-qa .dashboard-metric-card")).toHaveCount(4);
}

test("鼠标真实拖动缩放和平移同步改变折线与柱状图的数据窗口", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await mountPeriods(page, 366);
  for (const index of [2, 3]) {
    const card = page.locator("#period-qa .dashboard-metric-card").nth(index);
    await card.scrollIntoViewIfNeeded();
    const range = card.locator(".ui-trend-range__track"), rect = await range.boundingBox();
    const y = rect.y + rect.height / 2;
    const snapshot = () => card.evaluate(async el => {
      const { getInstanceByDom } = await import("/node_modules/.vite/deps/echarts_core.js");
      const chart = el.querySelector("[_echarts_instance_]");
      const option = getInstanceByDom(chart).getOption();
      return { dates: option.xAxis[0].data, values: option.series[0].data };
    });
    const original = await snapshot(), total = await card.locator(".dashboard-metric-card__value").textContent();
    await page.mouse.move(rect.x + 5, y); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .25, y, { steps: 12 }); await page.mouse.up();
    await page.mouse.move(rect.x + rect.width - 5, y); await page.mouse.down(); await page.mouse.move(rect.x + rect.width * .65, y, { steps: 12 }); await page.mouse.up();
    const start = Number(await card.getByRole("slider", { name: "图表起始日期", exact: true }).inputValue()), end = Number(await card.getByRole("slider", { name: "图表截止日期", exact: true }).inputValue());
    expect(start).toBeGreaterThan(50); expect(end).toBeLessThan(300);
    await expect.poll(async () => (await snapshot()).dates.length).toBe(end - start + 1);
    expect((await snapshot()).values).toEqual(original.values.slice(start, end + 1));
    const window = await card.getByRole("button", { name: "平移可见日期范围" }).boundingBox();
    await page.mouse.move(window.x + window.width / 2, y); await page.mouse.down(); await page.mouse.move(window.x + window.width / 2 + rect.width * .12, y, { steps: 12 }); await page.mouse.up();
    const moved = Number(await card.getByRole("slider", { name: "图表起始日期", exact: true }).inputValue());
    expect(moved).toBeGreaterThan(start + 20);
    await expect.poll(async () => (await snapshot()).values).toEqual(original.values.slice(moved, moved + end - start + 1));
    await expect(card.locator(".dashboard-metric-card__value")).toHaveText(total);
    await card.screenshot({ path: `/private/tmp/ypbi-drag-${index === 2 ? "bar" : "line"}.png` });
    await card.getByRole("button", { name: "全部", exact: true }).click();
    await expect.poll(snapshot).toEqual(original);
  }
});

test("长区间只缩放绘图窗口，完整表内部滚动、页码、条数和跳页保留全集", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await mountPeriods(page, 366);
  const cards = page.locator("#period-qa .dashboard-metric-card");
  for (const index of [0, 2]) {
    const card = cards.nth(index); await card.scrollIntoViewIfNeeded();
    const value = await card.locator(".dashboard-metric-card__value").textContent();
    const start = card.getByRole("slider", { name: "图表起始日期", exact: true });
    await page.keyboard.press("Tab"); await start.focus(); await page.keyboard.press("End"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
    await expect(start).toHaveValue("363");
    await expect(card.locator(".dashboard-metric-card__value")).toHaveText(value);
    if (index === 0) await expect(card.locator(".dashboard-mini-trend__point.is-current")).toHaveCount(3);
    await card.getByRole("button", { name: "全部", exact: true }).click();
    await expect(start).toHaveValue("0");
  }
  const card = cards.nth(2);
  await card.getByRole("tab", { name: "表格", exact: true }).click();
  const viewport = card.locator(".ui-result-table__viewport"), footer = card.getByRole("navigation");
  const before = await footer.boundingBox();
  await viewport.evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await footer.boundingBox()).toEqual(before);
  await expect(card.locator("thead")).toBeVisible();
  await card.getByRole("button", { name: "第 8 页", exact: true }).click();
  await expect(footer).toContainText("351–366 / 共 366 条");
  await expect(card.locator("tbody tr")).toHaveCount(16);
  await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /布局测试/ });
  await dialog.getByLabel("跳转页码").fill("7"); await dialog.getByRole("button", { name: "跳转", exact: true }).click();
  await expect(dialog.getByRole("navigation")).toContainText("301–350 / 共 366 条");
  await dialog.getByLabel("每页条数").selectOption("20");
  await expect(dialog.getByRole("navigation")).toContainText("1–20 / 共 366 条");
  await expect(dialog.locator("tbody tr")).toHaveCount(20);
  await page.screenshot({ path: "/private/tmp/ypbi-reading-paged-table.png" });
  await dialog.getByRole("button", { name: "关闭数据表", exact: true }).click();
  await mountPeriods(page, 1);
  await expect(page.locator("#period-qa").getByRole("slider")).toHaveCount(0);
});

test("共享紧凑与详细图：1/7/30/90/366天真实渲染、悬停与完整表格", async ({ page }) => {
  test.setTimeout(120000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  for (const count of [1, 7, 30, 90, 366]) {
    await mountPeriods(page, count);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      const cards = page.locator("#period-qa .dashboard-metric-card");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const bar = cards.first(); await bar.scrollIntoViewIfNeeded();
      expect(await bar.locator(".dashboard-mini-trend__point").first().evaluate(element => getComputedStyle(element, "::before").opacity)).toBe("0");
      await page.screenshot({ path: `/private/tmp/ypbi-period-${count}-${width}.png`, fullPage: true });
      const rects = await bar.locator(".dashboard-mini-trend svg rect").evaluateAll(elements => elements.map(el => ({ x: +el.getAttribute("x"), width: +el.getAttribute("width") })).sort((a, b) => a.x - b.x));
      for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].x + rects[i - 1].width);
      const labels = await bar.locator(".dashboard-mini-trend__x-axis span").evaluateAll(els => els.filter(el => el.textContent).map(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }));
      for (let i = 1; i < labels.length; i++) expect(labels[i].left).toBeGreaterThanOrEqual(labels[i - 1].right - 1);
      for (const card of [cards.first(), cards.nth(1)]) {
        await card.scrollIntoViewIfNeeded();
        const last = card.locator(".dashboard-mini-trend__point.is-current").last(); await page.keyboard.press("Tab"); await last.focus();
        await expect(page.locator(".ui-hint-panel:visible")).toContainText("2026-09-08"); await page.keyboard.press("Escape");
      }
      for (const card of [cards.nth(2), cards.nth(3)]) {
        await card.scrollIntoViewIfNeeded(); await expect(card.locator("canvas")).toBeVisible();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const box = await card.locator(".chart").boundingBox();
        await page.mouse.move(0, 0); await page.mouse.move(box.x + box.width * .7, box.y + 60, { steps: 3 });
        await expect(page.locator(".ui-chart-tooltip:visible")).toContainText("当前期");
        await card.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: /布局测试/ }); await expect(dialog.locator("tbody tr")).toHaveCount(Math.min(count, 50));
        if (count > 50) await dialog.getByRole("button", { name: "第 " + Math.ceil(count / 50) + " 页", exact: true }).click();
        await dialog.locator("tbody tr").last().scrollIntoViewIfNeeded(); await expect(dialog.locator("tbody tr").last()).toContainText("2026-09-08");
        const bounds = await dialog.boundingBox(); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width); expect(bounds.y + bounds.height).toBeLessThanOrEqual(1100);
        await page.keyboard.press("Escape");
      }
    }
  }
  expect(errors).toEqual([]);
});

test("同一组件切换条件再返回，分页与日期窗口从起点展示", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`);
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { PaginatedTable } = await import("/src/components/ui/PaginatedTable.tsx");
    const { TrendRange, useTrendRange } = await import("/src/components/ui/TrendRange.tsx");
    document.querySelector("#root").style.display = "none";
    const host = document.createElement("main"); host.id = "reset-qa"; host.className = "ypbi-v2"; document.body.append(host);
    function ResetHarness() {
      const [condition, setCondition] = React.useState("A");
      const count = condition === "A" ? 90 : 7;
      const dates = Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10));
      const range = useTrendRange(dates);
      return React.createElement("section", { style: { padding: 16 } },
        React.createElement("h1", null, "条件切换合成布局测试（非业务数据）"),
        ...["A", "B"].map(value => React.createElement("button", { key: value, onClick: () => setCondition(value) }, `条件 ${value}`)),
        React.createElement(TrendRange, { dates, ...range, onChange: range.setRange }),
        React.createElement(PaginatedTable, { resetKey: condition, label: "条件测试数据", head: React.createElement("tr", null, React.createElement("th", null, "日期")), rows: dates.map(date => React.createElement("tr", { key: date }, React.createElement("td", null, date))) }));
    }
    createRoot(host).render(React.createElement(ResetHarness));
  });
  const start = page.getByRole("slider", { name: "图表起始日期", exact: true });
  await start.focus(); await page.keyboard.press("End");
  await expect(start).toHaveValue("89");
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "条件测试数据分页" })).toContainText("51–90 / 共 90 条");
  await page.getByRole("button", { name: "条件 B", exact: true }).click();
  await expect(start).toHaveCount(0);
  await expect(page.locator("#reset-qa tbody tr")).toHaveCount(7);
  await page.getByRole("button", { name: "条件 A", exact: true }).click();
  await expect(start).toHaveValue("0");
  await expect(page.getByRole("slider", { name: "图表截止日期", exact: true })).toHaveValue("89");
  await expect(page.getByRole("navigation", { name: "条件测试数据分页" })).toContainText("1–50 / 共 90 条");
  await expect(page.locator("#reset-qa tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  await expect(page.locator("#reset-qa tbody tr")).toHaveCount(40);
});
