import { expect, test } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
async function enableComparison(page) {
  await page.setViewportSize({width:1280,height:1000});
  await page.getByRole("button",{name:/^对比周期：/}).click();
  await page.getByRole("option",{name:"上一等长周期",exact:true}).click();
  await page.getByRole("button",{name:"应用",exact:true}).click();
}
async function open(page) { await page.goto(`${base}/dashboards/public?design=dashboard-center&board=5.7`); await enableComparison(page); }
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-reading-failure-${info.testId}.png`, fullPage: true }); });

test("数据表初始聚焦关闭按钮，不自动弹导出提示；鼠标和键盘仍可查看", async ({ page }) => {
  await open(page);
  const card = page.getByRole("article", { name: "新增用户数", exact: true });
  for (let i = 0; i < 2; i++) {
    await card.getByRole("button", { name: "查看同口径数据表" }).click();
    const dialog = page.getByRole("dialog", { name: "新增用户数同口径数据表", exact: true });
    await expect(dialog.getByRole("button", { name: "关闭数据表" })).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    const exportButton = dialog.getByRole("button", { name: "导出新增用户数同口径数据表", exact: true });
    await exportButton.hover(); await expect(page.getByRole("tooltip")).toContainText("导出新增用户数");
    await page.mouse.move(0, 0); await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Shift+Tab"); await expect(exportButton).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText("导出新增用户数");
    await exportButton.click(); await expect(page.getByRole("dialog", { name: "导出新增用户数同口径数据表", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭数据表" }).click();
    await expect(card.getByRole("button", { name: "查看同口径数据表" })).toBeFocused();
  }
});

test("指标名称和整条比较可悬停；两种阅读视图保持邻卡位置及导出可达", async ({ page }) => {
  await open(page); const errors = []; page.on("pageerror", error => errors.push(error.message));
  for (const width of [1800, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const card = page.getByRole("article", { name: "新增用户数", exact: true });
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("link", { name: "新增用户数", exact: true }).hover();
    await expect(page.getByRole("tooltip")).not.toContainText(/<span|register_success/);
    await expect(page.getByRole("tooltip")).toBeVisible();
    await card.locator(".dashboard-metric-card__comparison button span").first().hover();
    await expect(page.getByRole("tooltip")).toContainText("所选日");
    await page.mouse.move(0, 0);
    const before = await card.evaluate(el => ({ height: el.offsetHeight, nextTop: el.nextElementSibling?.offsetTop }));
    await expect(card.getByRole("tab", { name: "对比", exact: true })).toHaveCount(0);
    for (const name of ["表格", "折线"]) {
      await card.getByRole("tab", { name, exact: true }).click();
      await expect(card.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
      const after = await card.evaluate(el => ({ height: el.offsetHeight, nextTop: el.nextElementSibling?.offsetTop }));
      expect(after).toEqual(before);
      if (name === "表格") { await expect(card.locator("tbody tr")).toHaveCount(7); await expect(card.getByRole("button", { name: "导出新增用户数同口径数据表", exact: true })).toBeVisible(); }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-reading-${width}.png` });
  }
  expect(errors).toEqual([]);
});

test("普通操作提示自动消失，悬停与聚焦暂停，重复操作重新计时", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=core-overview`);
  const action = page.getByRole("button", { name: /^(收藏看板|取消收藏)$/ });
  await action.click();
  const toast = page.locator(".ui-toast"); await expect(toast).toBeVisible(); await expect(action).toBeFocused();
  await expect(toast).toHaveCount(0, { timeout: 4500 });
  await action.click(); await toast.hover();
  await page.waitForTimeout(3200); await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "关闭提示" }).focus(); await page.mouse.move(0, 0);
  await page.waitForTimeout(3200); await expect(toast).toBeVisible();
  await action.click(); await expect(toast).toHaveCount(1);
  await page.screenshot({ path: "/private/tmp/ypbi-toast-feedback.png" });
  await expect(toast).toHaveCount(0, { timeout: 4500 });
  await open(page); await page.getByRole("button", { name: "刷新演示快照", exact: true }).click();
  await expect(toast).toContainText("已重新载入"); await expect(toast).toHaveCount(0, { timeout: 4500 });
});

test("共同数据区间上提表头，逐日和对比日期仍是行数据", async ({ page }) => {
  await open(page);
  const table = page.getByRole("region", { name: "获客明细", exact: true });
  for (const name of ["增长效果", "渠道结算"]) {
    await table.getByRole("tab", { name, exact: true }).click();
    for (const header of await table.locator("header").all()) await expect(header).toContainText("数据区间 2026-09-02 至 2026-09-08");
    await expect(table.getByRole("columnheader", { name: "数据区间", exact: true })).toHaveCount(0);
    for (const body of await table.locator("tbody").all()) await expect(body).not.toContainText("09-02 至 09-08");
  }
  await table.screenshot({ path: "/private/tmp/ypbi-table-common-context.png" });
  const gutter = await table.locator(".ui-pagination").first().evaluate(el => ({ left: el.getBoundingClientRect().left, label: el.firstElementChild.getBoundingClientRect().left, pad: parseFloat(getComputedStyle(el).paddingLeft) }));
  expect(gutter.pad).toBeGreaterThanOrEqual(12); expect(gutter.label - gutter.left).toBeGreaterThanOrEqual(12);
  const card = page.getByRole("article", { name: "新增用户数", exact: true });
  await card.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(card.getByRole("columnheader", { name: "日期", exact: true })).toBeVisible();
  await expect(card.getByRole("columnheader", { name: "对比日期", exact: true })).toBeVisible();
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const gallery = page.locator('[data-chart-kind="kpi-detailed"]');
  await gallery.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(gallery.locator("tbody tr")).toHaveCount(7);
  await expect(gallery.getByRole("tab", { name: "对比", exact: true })).toHaveCount(0);
  await expect(gallery.getByRole("columnheader", { name: "对比值", exact: true })).toBeVisible();
});

test("看板查询与操作顺序一致，收纳和键盘顺序保持任务分组", async ({ page }) => {
  for (const board of ["core-overview", "dashboard-center&board=5.7"]) {
    await page.goto(`${base}/dashboards/public?design=${board}`);
    for (const width of [1800, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const filters = page.locator(".core-review__filter-controls, .acquisition-preview__filters");
      await expect(filters).toBeVisible();
      const controls = filters.locator("button");
      const labels = await controls.evaluateAll(els => els.map(el => el.classList.contains("ui-date-range__trigger") ? "日期" : el.getAttribute("aria-label") || el.textContent.trim()));
      const ranks = labels.map(label => label === "日期" ? 0 : /业务范围/.test(label) ? 1 : /来源渠道|更多筛选/.test(label) ? 2 : /对比/.test(label) ? 3 : label === "应用" ? 4 : -1);
      expect(ranks).not.toContain(-1); expect(ranks[0]).toBe(0); expect(ranks.at(-1)).toBe(4);
      expect(ranks).toEqual([...ranks].sort());
      await controls.first().focus();
      for (let i = 1; i < await controls.count(); i++) { await page.keyboard.press("Tab"); await expect(controls.nth(i)).toBeFocused(); }
      const actions = page.locator(".core-review__toolbar-actions, .acquisition-preview__actions").locator("button:not([role=radio])");
      const names = await actions.evaluateAll(els => els.map(el => el.getAttribute("aria-label")));
      expect(names.map(label => /收藏/.test(label) ? 0 : /复制/.test(label) ? 1 : /刷新/.test(label) ? 2 : /全屏/.test(label) ? 3 : /导出/.test(label) ? 4 : -1)).toEqual(board === "core-overview" ? [0, 1, 2, 4] : [0, 1, 2, 3, 4]);
      const mode=page.getByRole("radiogroup",{name:"指标卡展示",exact:true});
      await page.keyboard.press("Tab");
      await expect(mode.locator('[aria-checked="true"]')).toBeFocused();
      for (let i = 0; i < await actions.count(); i++) { await page.keyboard.press("Tab"); await expect(actions.nth(i)).toBeFocused(); }
      const more = filters.getByRole("button", { name: "更多筛选", exact: true });
      if (await more.count()) {
        await more.click();
        const panel = page.getByRole("region", { name: "更多筛选条件", exact: true });
        const inside = await panel.locator(".ui-menu-select > button").evaluateAll(els => els.map(el => el.getAttribute("aria-label")));
        const order = inside.map(label => /业务范围/.test(label) ? 1 : /来源渠道/.test(label) ? 2 : /对比/.test(label) ? 3 : -1);
        expect(order).not.toContain(-1); expect(order).toEqual([...order].sort());
        await panel.getByRole("button", { name: "完成", exact: true }).click();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.mouse.move(0, 0); await page.screenshot({ path: `/private/tmp/ypbi-toolbar-${board.startsWith("core") ? "core" : "acquisition"}-${width}.png` });
    }
  }
});

test("指标阅读详情持续保留，关闭后恢复入口且不自动弹帮助", async ({ page }) => {
  for (const board of ["core-overview", "dashboard-center&board=5.7"]) {
    await page.goto(`${base}/dashboards/public?design=${board}`);
    await enableComparison(page);
    const trigger = page.getByRole("article", { name: "新增用户数", exact: true }).getByRole("button", { name: /^较前一天/ });
    await trigger.click();
    const hint = page.getByRole("tooltip");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(3200); await expect(hint).toBeVisible();
    await expect(hint).toContainText("所选日");
    await expect(hint).toContainText("2026-09-07");
    await expect(page.locator(".ui-toast")).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  }
});

test("同单位多分类图整幅日期命中，同日各系列分行且图例顺序稳定", async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const series = [
    ["Android DAU", [102220, 104680, 0, 108410, null, 112730, 119880]],
    ["iOS DAU", [42100, 43840, 44720, 45600, 46190, 47200, 48620]],
    ["Web DAU", [24100, 24340, 24760, 25210, 25700, 25990, 25819]]
  ];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const chart = page.locator('[data-chart-kind="line-multi"] .chart'); await chart.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.move(0, 0);
    for (const fraction of [.35, .63, .85]) {
      const box = await chart.boundingBox(); await page.mouse.move(box.x + box.width * fraction, box.y + box.height * .65);
      const tip = page.locator(".ui-chart-tooltip").filter({ visible: true }); await expect(tip).toBeVisible();
      const text = await tip.innerText(); const day = Number(text.match(/2026-09-(\d{2})/)?.[1]) - 2;
      expect(day).toBeGreaterThanOrEqual(0);
      for (const [name, values] of series) { expect(text).toContain(name); expect(text).toContain(values[day] == null ? "缺失" : `${values[day].toLocaleString()} 人`); }
      expect(text.indexOf("Android DAU")).toBeLessThan(text.indexOf("iOS DAU")); expect(text.indexOf("iOS DAU")).toBeLessThan(text.indexOf("Web DAU"));
      await expect(tip.locator("i")).toHaveCount(3); await expect(tip).not.toContainText(/<span|<div|style=/);
    }
    await page.screenshot({ path: `/private/tmp/ypbi-multi-category-${width}.png` });
    await page.mouse.move(0, 0);
  }
});

test("多图例在底部翻页，跨页选择和完整数据保持，搜索及窄屏可用", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const panel = page.locator('[data-chart-kind="line-multi-pid"]');
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const legend = panel.getByRole("group", { name: "当前目录全部业务 PID", exact: true });
    await legend.scrollIntoViewIfNeeded();
    const previous = panel.getByRole("button", { name: "上一页图例", exact: true });
    const next = panel.getByRole("button", { name: "下一页图例", exact: true });
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await page.mouse.move(0, 0);
    const chart = panel.locator(".chart"); const before = await chart.locator("canvas").evaluate(el => el.toDataURL());
    const names = new Set();
    for (let i = 0; i < 20; i++) {
      (await legend.getByRole("button").allTextContents()).forEach(name => names.add(name));
      if (await next.isDisabled()) break;
      await next.click();
    }
    expect(names.size).toBe(20);
    expect(await chart.locator("canvas").evaluate(el => el.toDataURL())).toBe(before);
    if (await legend.getByRole("button").last().getAttribute("aria-pressed") !== "true") await legend.getByRole("button").last().click();
    const selected = await legend.getByRole("button").last().getAttribute("aria-label");
    await previous.focus(); await page.keyboard.press("Enter"); await next.click();
    await expect(legend.getByRole("button", { name: selected, exact: true })).toHaveAttribute("aria-pressed", "true");
    await panel.getByPlaceholder("搜索业务名称或 PID").fill("TikTok");
    await expect(legend.getByRole("button")).toHaveCount(1); await expect(next).toHaveCount(0);
    await panel.getByPlaceholder("搜索业务名称或 PID").fill(""); await expect(previous).toBeDisabled();
    const placement = await panel.evaluate(el => ({ chart: el.querySelector(".chart").getBoundingClientRect().bottom, legend: el.querySelector(".ui-paginated-legend").getBoundingClientRect().top, overflow: el.scrollWidth - el.clientWidth }));
    expect(placement.legend).toBeGreaterThanOrEqual(placement.chart); expect(placement.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `/private/tmp/ypbi-paged-legend-${width}.png` });
  }
  await panel.getByRole("button", { name: "查看全部 PID 同口径数据表", exact: true }).click();
  await expect(page.getByRole("dialog").locator("tbody tr")).toHaveCount(20);
});
