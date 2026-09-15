import { test, expect } from "@playwright/test";
test.use({ channel: "chrome" });
test("从看板站内切换两个目录不继承贴边或固定高度，返回刷新保持边距", async ({ page }) => {
  await page.setViewportSize({width:1280,height:950});
  await page.goto(`${base}/dashboards/public?design=dashboard-center`);
  await page.getByRole('link', {name:'YPBI 指标中心',exact:true}).click();
  for(const kind of ['metrics','events']) {
    if(kind === 'events') {
      await page.setViewportSize({width:1280,height:950});
      await page.getByRole('button', {name:/数据中心/}).click();
      await page.getByRole('link',{name:'事件中心',exact:true}).click();
    }
    for(const width of [1920,1280,1101,1024,772,768,390]) {
      await page.setViewportSize({width,height:950});
      const header=await page.locator('.dashboard-header').boundingBox();
      expect(header.x).toBeGreaterThanOrEqual(16); expect(header.x+header.width).toBeLessThanOrEqual(width-16);
      expect(await page.locator('.v2-main').evaluate(el=>getComputedStyle(el).overflowY)).not.toBe('hidden');
      if(width <= 1100) {
        await expect(page.locator('.v2-category-mobile')).toBeVisible();
        await expect(page.locator('.v2-category-list')).toBeHidden();
        expect((await page.locator('.v2-catalog-results').boundingBox()).y).toBeLessThan(700);
      }
      for(const selector of ['.catalog-page','.v2-catalog-tools','.v2-catalog-results','.ui-pagination']) {
        const box=await page.locator(selector).first().boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(15); expect(box.x+box.width).toBeLessThanOrEqual(width-15);
      }
      await page.screenshot({path:`/private/tmp/ypbi-catalog-route-${kind}-${width}.png`});
    }
  }
  await page.goBack(); await expect(page.getByRole('heading',{name:'指标中心',exact:true})).toBeVisible();
  await page.goForward(); await expect(page.getByRole('heading',{name:'事件中心',exact:true})).toBeVisible();
  await page.reload();
  expect((await page.locator('.dashboard-header').boundingBox()).x).toBeGreaterThanOrEqual(16);
});
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: "/private/tmp/ypbi-catalog-failure.png", fullPage: true }); });
test("两个目录共用标题与分页；移动端完整字段局部滚动", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  for (const width of [1280, 1024, 390]) for (const [kind, title] of [["metrics", "指标中心"], ["events", "事件中心"]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${base}/data/${kind}?design=catalog-center`);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    expect(await page.locator(".dashboard-header h1").evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).fontWeight])).toEqual(["24px", "700"]);
    await expect(page.locator(".ui-result-table tbody tr")).toHaveCount(50);
    await expect(page.locator('.v2-table-surface')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-catalog-${kind}-${width}.png` });
  }
  expect(errors).toEqual([]);
});
test("事件搜索、无查询状态、定义详情、全属性和唯一关闭", async ({ page }) => {
  await page.goto(`${base}/data/events?design=catalog-center`);
  await page.getByRole("button", { name: "第 3 页", exact: true }).click();
  await expect(page.locator(".ui-result-table tbody tr")).toHaveCount(1);
  await page.getByRole("textbox", { name: "搜索事件", exact: true }).fill("page_view");
  const table = page.getByRole("table", { name: "事件目录", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  const eventButton = table.getByRole("button", { name: "页面浏览 page_view", exact: true });
  await eventButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /^关闭/ })).toHaveCount(1);
  await expect(dialog.locator("footer")).toHaveCount(0);
  await expect(dialog).toContainText("尚无采集与完整性状态接口");
  await expect(dialog.getByRole("table", { name: "事件专属与页面属性" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(eventButton).toBeFocused();
  await page.getByRole("button", { name: /^事件状态：/ }).click();
  await page.getByRole("option", { name: "可分析", exact: true }).click();
  await expect(page.getByText("没有匹配的事件", { exact: true })).toBeVisible();
});
