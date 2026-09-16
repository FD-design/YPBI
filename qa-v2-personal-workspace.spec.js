import { test, expect } from "@playwright/test";
test.use({ channel: "chrome", viewport: { width: 1280, height: 950 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5198";
const href = path => `${base}${path}?design=personal-workspace`;
async function selectDefinition(page, name, kind = "指标", index = 0) {
  const trigger=page.getByRole("button",{name:`选择${kind}：未选择`,exact:true}).nth(index);
  await trigger.click();
  await page.getByRole("searchbox",{name:`搜索选择${kind}`}).fill(name);
  await page.getByRole("option",{name:new RegExp("^"+name)}).first().click();
}
async function nameAndSave(page, name) {
  await page.getByRole("textbox", { name: "方案名称" }).fill(name);
  await page.getByRole("button", { name: "保存本次体验", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-personal-failure-${info.testId.slice(-8)}.png`, fullPage: true }); });

test("指标分析空态、异单位、保存重开与旧结果保护", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(href("/analysis/metrics"));
  await expect(page.getByRole("button", { name: "查询样例", exact: true })).toBeDisabled();
  await selectDefinition(page, "日活跃用户数");
  await page.getByRole("button", { name: "添加分析项" }).click();
  await selectDefinition(page, "总充值金额");
  await page.getByRole("button", { name: "查询样例", exact: true }).click();
  await expect(page.locator(".personal-result__chart")).toHaveCount(2);
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await nameAndSave(page, "日常规模与收入 <复核>");
  await expect(page.getByRole("heading", { name: "日常规模与收入 <复核>", exact: true })).toBeVisible();
  const url = page.url();
  await expect(page.getByRole("button", { name: "加入看板", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: /^对比周期：/ }).click();
  await page.getByRole("option", { name: "上一等长周期", exact: true }).click();
  await expect(page.getByText(/条件已修改，以下仍为上次结果/)).toBeVisible();
  await expect(page.getByRole("button", { name: "加入看板", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "导出样例", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "查询样例", exact: true }).click();
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await page.getByRole("link", { name: "已保存的分析", exact: true }).click();
  await expect(page.getByRole("table", { name: "已保存分析列表" }).getByRole("row")).toHaveCount(2);
  await page.getByRole("link", { name: "日常规模与收入 <复核>", exact: true }).click();
  expect(page.url()).toBe(url);
  await expect(page.locator(".personal-result__chart")).toHaveCount(2);
  await page.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(page.getByRole("table", { name: "完整聚合结果" })).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出样例", exact: true }).click();
  await (await download).saveAs("/private/tmp/ypbi-personal-analysis.xlsx");
  expect(errors).toEqual([]);
});

test("事件三类统计与分组、上限和未覆盖恢复", async ({ page }) => {
  await page.goto(href("/analysis/events"));
  await selectDefinition(page, "应用启动", "事件");
  await page.getByRole("button", { name: "添加分析项" }).click();
  await selectDefinition(page, "应用启动", "事件");
  await page.getByRole("button", { name: /^分析项2统计方式：/ }).click();
  await page.getByRole("option", { name: "触发用户数", exact: true }).click();
  await page.getByRole("button", { name: /^分组维度：/ }).click();
  await page.getByRole("option", { name: "客户端平台", exact: true }).click();
  await page.getByRole("button", { name: /^对比周期：/ }).click();
  await page.getByRole("option", { name: "上一等长周期", exact: true }).click();
  await page.getByRole("button", { name: "查询样例", exact: true }).click();
  await expect(page.locator(".personal-summary .metric-summary")).toHaveCount(2);
  await expect(page.locator(".personal-result__chart")).toHaveCount(1);
  await page.getByRole("tab", { name: "柱状", exact: true }).click();
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "添加分析项" }).click();
  await expect(page.getByRole("button", { name: "添加分析项" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "查询样例", exact: true })).toBeDisabled();
  for (let i = 5; i > 2; i--) await page.getByRole("button", { name: `移除分析项${i}`, exact: true }).click();
  await page.getByRole("button", { name: /^业务平台：/ }).click();
  await expect(page.getByRole("option", { name: /^Pornhub/ })).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("分析加入看板、复制移除、删除不删来源及刷新边界", async ({ page }) => {
  await page.goto(href("/analysis/metrics"));
  await selectDefinition(page, "日活跃用户数");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await nameAndSave(page, "活跃走势");
  await page.getByRole("button", { name: "加入看板", exact: true }).click();
  await page.getByRole("textbox", { name: "新看板名称" }).fill("我的经营看板");
  await page.getByRole("button", { name: "确认加入", exact: true }).click();
  await page.getByRole("button", { name: "看板中心", exact: true }).click();
  await page.getByRole("link", { name: "我的概览", exact: true }).click();
  await page.locator('.personal-board-link').filter({hasText:'我的经营看板'}).click();
  await expect(page.locator(".personal-board-card")).toHaveCount(1);
  const mode=page.getByRole('radiogroup',{name:'指标卡展示',exact:true});
  const summary=await page.locator('.personal-summary').textContent();
  await mode.getByRole('radio',{name:'纯数值',exact:true}).click();
  await expect(page.locator('.personal-result__chart')).toHaveCount(0);
  await expect(page.locator('.personal-summary')).toHaveText(summary);
  await page.getByRole('button',{name:'查看同口径数据表',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('table',{name:'完整聚合结果',exact:true})).toBeVisible();await page.keyboard.press('Escape');
  await mode.getByRole('radio',{name:'数值＋趋势',exact:true}).click();
  await expect(page.locator('.personal-result__chart')).toHaveCount(1);
  await page.getByRole("button", { name: "编辑看板", exact: true }).click();
  await expect(mode).toHaveCount(0);
  await page.getByRole("button", { name: "复制组件", exact: true }).click();
  await expect(page.locator(".personal-board-card")).toHaveCount(2);
  await page.getByRole("button", { name: "移除组件", exact: true }).first().click();
  await page.getByRole("button", { name: "保存布局", exact: true }).click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "确认删除看板", exact: true }).click();
  await page.getByRole("button", { name: "分析中心", exact: true }).click();
  await page.getByRole("link", { name: "已保存的分析", exact: true }).click();
  await expect(page.getByRole("link", { name: "活跃走势", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "活跃走势", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "本次体验对象已失效", exact: true })).toBeVisible();
});

test("指标速览配置、实际日期、详情与宽表只在表内滚动", async ({ page }) => {
  await page.goto(href("/dashboards/metric-overviews"));
  await page.getByRole("button", { name: "新建速览", exact: true }).click();
  await nameAndSave(page, "每日重点");
  await expect(page.getByRole("button", { name: "添加指标", exact: true })).toBeVisible();
  for (const name of ["日活跃用户数", "新增用户数", "注册用户D1留存率"]) {
    await page.getByRole("button", { name: "添加指标", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "选择指标", exact: true });
    await dialog.getByRole("textbox", { name: "搜索定义" }).fill(name);
    await dialog.locator(".personal-picker__items > button").first().click();
  }
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  const table = page.getByRole("table", { name: "指标速览结果" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("cell", { name: /^2026-09-07/ })).toBeVisible();
  await page.getByRole("button", { name: "日活跃用户数", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "日活跃用户数", exact: true })).toBeFocused();
  for (const width of [1280, 1024, 772, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const box = await page.locator(".dashboard-header").boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: `/private/tmp/ypbi-personal-quick-${width}.png` });
  }
});

test("四个入口站内连续切换、响应式、历史", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/dashboards/public?design=dashboard-center`);
  await page.locator(".dashboard-workbench__scope").getByRole("link", { name: "我的概览", exact: true }).click();
  for (const [top, name] of [["看板中心", "指标速览"], ["分析中心", "指标分析"], ["分析中心", "事件分析"]]) {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.getByRole("button", { name: top, exact: true }).click();
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.locator(".personal-workspace-preview")).toBeVisible();
    for (const width of [1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await page.locator(".dashboard-header").boundingBox()).x).toBeGreaterThanOrEqual(16);
      expect(await page.locator(".v2-main").evaluate(el => getComputedStyle(el).overflowY)).not.toBe("hidden");
      await page.screenshot({ path: `/private/tmp/ypbi-personal-${name}-${width}.png` });
    }
  }
  await page.goBack(); await expect(page.getByRole("heading", { name: "新建指标分析" })).toBeVisible();
  await page.goForward(); await expect(page.getByRole("heading", { name: "新建事件分析" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("长范围缩放、单日恢复、填充结果多屏复查和未保存返回确认", async ({ page }) => {
  await page.goto(href("/analysis/saved"));
  await page.getByRole("link", { name: "新建指标分析", exact: true }).click();
  await selectDefinition(page, "日活跃用户数");
  const currentUrl = page.url();
  let asked = false;
  page.once("dialog", async dialog => { asked = true; await dialog.dismiss(); });
  await page.evaluate(() => history.back());
  await page.waitForTimeout(150);
  expect(asked).toBe(true); expect(page.url()).toBe(currentUrl);
  await page.getByRole("button", { name: /^日期范围：/ }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-06-01");
  await page.getByRole("button", { name: "确认日期", exact: true }).click();
  await page.getByRole("button", { name: "查询样例", exact: true }).click();
  await expect(page.getByRole("group", { name: "缩放可见日期范围", exact: true })).toBeVisible();
  const slider = page.locator('.ui-trend-range input[type="range"]').first();
  await slider.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.locator(".ui-trend-range__summary")).toContainText("2026-06-02");
  await expect(slider).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(slider).toHaveCSS("padding", "0px");
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const selector of ['.personal-result', '.personal-result > [role="tabpanel"]', '.personal-result__chart', '.ui-trend-range', '.ui-pagination']) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box.x + box.width, selector).toBeLessThanOrEqual(width - 15);
    }
    await page.screenshot({ path: `/private/tmp/ypbi-personal-filled-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole("button", { name: /^日期范围：/ }).click();
  await page.getByLabel("开始日期", { exact: true }).fill("2026-09-03");
  await page.getByLabel("结束日期", { exact: true }).fill("2026-09-03");
  await page.getByRole("button", { name: "确认日期", exact: true }).click();
  await page.getByRole("button", { name: "查询样例", exact: true }).click();
  await expect(page.getByRole("group", { name: "缩放可见日期范围", exact: true })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "完整聚合结果" }).getByRole("row")).toHaveCount(2);
});
