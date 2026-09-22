import { expect, test } from "@playwright/test";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const directoryUrl = baseUrl + "/dashboards/public?design=dashboard-center";
test.use({ channel: "chrome" });

async function openWorkbench(page, url = directoryUrl) {
  const requests = [], errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(baseUrl + "/api/**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA backend unavailable" }) });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".dashboard-workbench")).toBeVisible();
  return { requests, errors };
}
const boardNavigation = (page) => page.getByRole("navigation", { name: "公共看板列表" });

test("公共概览直接呈现核心结果，左侧一次点击切板，无目录卡片中转", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { requests, errors } = await openWorkbench(page);
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-metric-card:not(.is-value)")).toHaveCount(9);
  const nav = boardNavigation(page);
  await expect(nav.getByRole("link")).toHaveCount(11);
  await expect(nav.getByRole("link", { name: "核心经营总览", exact: true })).toHaveAttribute("aria-current", "page");
  const coreLink = nav.getByRole("link", { name: "核心经营总览", exact: true });
  await coreLink.hover();
  await expect(coreLink.locator(".dashboard-directory__full-name")).toHaveCount(0);
  const longLink = nav.getByRole("link", { name: "产品体验与启动质量", exact: true });
  await longLink.locator(".dashboard-directory__name").evaluate((label) => { label.style.maxWidth = "60px"; });
  await longLink.focus();
  await expect(longLink.locator(".dashboard-directory__full-name")).toBeVisible();
  const tooltip = await longLink.locator(".dashboard-directory__full-name").boundingBox();
  const navBounds = await nav.boundingBox();
  expect(tooltip.y).toBeGreaterThanOrEqual(navBounds.y);
  expect(tooltip.y + tooltip.height).toBeLessThanOrEqual(navBounds.y + navBounds.height);
  await page.keyboard.press("Escape");
  await expect(longLink.locator(".dashboard-directory__full-name")).toHaveCount(0);
  await expect(page.locator(".dashboard-directory__card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看规划", exact: true })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "产品主导航" })).toHaveCount(0);
  await nav.getByRole("link", { name: "支付链路与到账质量", exact: true }).click();
  await expect(page.getByRole("heading", { name: "支付链路与到账质量", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "支付链路与到账质量", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "该专题看板尚未接入" })).toHaveCount(0);
  await expect(page.locator(".dashboard-metric-card:not(.is-value)")).toHaveCount(7);
  await expect(page.getByRole("article", { name: "拉单与充值转化", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^支付方式比较/ })).toBeVisible();
  await page.getByText("提交、下单、回调与到账指标", { exact: true }).click();
  await expect(page.getByRole("article", { name: "支付提交次数", exact: true })).toBeVisible();
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("搜索只筛选目录，自动展开匹配项，清除后恢复分类状态", async ({ page }) => {
  const { requests, errors } = await openWorkbench(page);
  const nav = boardNavigation(page);
  const category = nav.getByRole("button", { name: /^用户生命周期/ });
  await category.click();
  await expect(category).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("searchbox", { name: "搜索看板" }).fill("留存");
  await expect(nav.getByRole("link")).toHaveCount(1);
  await expect(category).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("不存在的看板");
  await expect(nav.getByRole("status")).toContainText("没有匹配的看板");
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(category).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("searchbox")).toBeFocused();
  await page.reload();
  await expect(category).toHaveAttribute("aria-expanded", "false");
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("看板切换与直接链接、刷新、前进后退对应同一对象", async ({ page }) => {
  const { requests, errors } = await openWorkbench(page);
  await page.evaluate(() => { window.__directorySpaMarker = true; });
  const nav = boardNavigation(page);
  await nav.getByRole("link", { name: "获客与新增", exact: true }).click();
  await expect(page).toHaveURL(directoryUrl + "&board=5.7");
  await expect(page.getByRole("heading", { name: "获客与新增", exact: true })).toBeVisible();
  await nav.getByRole("link", { name: "活跃与留存", exact: true }).click();
  await expect(page.getByRole("heading", { name: "活跃与留存", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__directorySpaMarker)).toBe(true);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "获客与新增", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "活跃与留存", exact: true })).toBeVisible();
  await page.reload();
  await expect(nav.getByRole("link", { name: "活跃与留存", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goto(directoryUrl + "&board=5.11");
  await expect(page.getByRole("heading", { name: "支付链路与到账质量", exact: true })).toBeVisible();
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

for (const width of [1280, 1024]) {
  test(width + " 工作台保留单目录，图表可读，独立滚动与目录收起正常", async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { requests, errors } = await openWorkbench(page);
    await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
    const sidebar = page.locator(".dashboard-workbench__directory");
    const content = page.locator(".dashboard-workbench__content");
    const sidebarBounds = await sidebar.boundingBox(), contentBounds = await content.boundingBox();
    expect(sidebarBounds.x).toBe(0);
    expect(contentBounds.width).toBeGreaterThanOrEqual(width - 260);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await content.evaluate((element) => { element.scrollTop = 700; });
    expect((await sidebar.boundingBox()).y).toBe(sidebarBounds.y);
    await boardNavigation(page).getByRole("link", { name: "获客与新增", exact: true }).click();
    expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
    await boardNavigation(page).getByRole("link", { name: "核心经营总览", exact: true }).click();
    await page.screenshot({ path: "qa-dashboard-workbench-" + width + ".png", fullPage: false });
    await page.getByRole("button", { name: "收起目录", exact: true }).click();
    await expect(sidebar.locator('.dashboard-workbench__directory-inner')).toBeHidden();
    expect((await sidebar.boundingBox()).width).toBe(32);
    await expect(page.getByRole("button", { name: "展开目录", exact: true })).toBeFocused();
    expect((await content.boundingBox()).width).toBeGreaterThan(contentBounds.width);
    await page.getByRole("button", { name: "展开目录", exact: true }).click();
    await expect(sidebar.locator('.dashboard-workbench__directory-inner')).toBeVisible();
    expect(requests).toEqual([]); expect(errors).toEqual([]);
  });
}

test("桌面边缘把手收纳为窄轨道，保持目录状态、键盘与正文空间", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  const { errors, requests } = await openWorkbench(page);
  const aside = page.locator('.dashboard-workbench__directory');
  const toggle = page.locator('.dashboard-workbench__edge-toggle');
  const content = page.locator('.dashboard-workbench__content');
  const list = page.locator('.dashboard-directory__list');
  const original = await toggle.boundingBox();
  expect(original.width).toBeGreaterThanOrEqual(32); expect(original.height).toBeGreaterThanOrEqual(44);
  // 收纳入口位于目录内部底部，不悬在正文旁。
  expect(original.y + original.height).toBeGreaterThan(600);
  expect(original.x + original.width).toBeLessThanOrEqual((await aside.boundingBox()).width);
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const scroll = await list.evaluate(el => el.scrollTop); expect(scroll).toBeGreaterThan(0);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('展开目录'); await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await expect(boardNavigation(page)).toBeHidden();
  const collapsed = await toggle.boundingBox(); expect(collapsed.y).toBe(original.y);
  expect(collapsed.x).toBeGreaterThanOrEqual(0);
  expect(collapsed.x + collapsed.width).toBeLessThan((await content.boundingBox()).x + 20);
  await toggle.hover(); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter'); await expect(toggle).toHaveAccessibleName('收起目录');
  expect(await list.evaluate(el => el.scrollTop)).toBe(scroll);
  await page.getByRole('searchbox', { name: '搜索看板' }).fill('支付');
  await toggle.click(); await page.keyboard.press('Space');
  await expect(page.getByRole('searchbox', { name: '搜索看板' })).toHaveValue('支付');
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await expect(page.locator('.dashboard-workbench')).toHaveCSS('transition-duration', '0s');
    for (let i = 0; i < 4; i++) { await toggle.click(); await expect(toggle).toBeFocused(); }
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  }
  for (const width of [2560, 1800, 1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(aside).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect((await aside.boundingBox()).width).toBe(32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await content.boundingBox()).width).toBe(width - 32);
    if ([1800, 1024].includes(width)) await page.screenshot({ path: `/private/tmp/ypbi-directory-rail-collapsed-${width}.png` });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    if (width === 1800) await page.screenshot({ path: '/private/tmp/ypbi-directory-rail-expanded.png' });
  }
  expect(await page.locator('.dashboard-workbench__collapse').count()).toBe(0);
  expect(await content.locator('.dashboard-workbench__reveal').count()).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(toggle).toHaveCount(0); await expect(page.getByRole('button', { name: '选择看板', exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(requests).toEqual([]);
});

test("390 看板目录为模态，选择后回到内容，取消恢复触发点", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { requests, errors } = await openWorkbench(page);
  await expect(page.getByRole("heading", { name: "核心经营总览", exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-workbench__directory")).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "选择看板", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "选择看板", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate(el => el.getAnimations().filter(a => a.playState === 'running').length)).toBe(0);
  expect((await dialog.boundingBox()).width).toBeCloseTo(390, 2);
  await page.screenshot({ path: "qa-dashboard-workbench-directory-390.png" });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("link", { name: "获客与新增", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "获客与新增", exact: true })).toBeVisible();
  await expect(page.locator(".dashboard-workbench__content")).toBeFocused();
  await trigger.click();
  await dialog.getByRole("link", { name: "核心经营总览", exact: true }).click();
  await page.screenshot({ path: "qa-dashboard-workbench-390.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("工作区入口沿用完整产品导航，原核心链接进入同一工作台", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { requests, errors } = await openWorkbench(page, baseUrl + "/dashboards/public?design=core-overview");
  await expect(boardNavigation(page)).toBeVisible();
  const trigger = page.getByRole("button", { name: "数据中心", exact: true });
  await trigger.hover();
  const navigation = page.getByRole("navigation", { name: "产品主导航", exact: true });
  await expect(navigation.getByRole("link", { name: "指标中心", exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "数据源维护" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("精确开发白名单之外的对象与参数恢复真实登录检查", async ({ page }) => {
  const { requests } = await openWorkbench(page);
  for (const path of [
    "/dashboards/public?design=dashboard-center&extra=1",
    "/dashboards/public/?design=dashboard-center",
    "/dashboards/public?design=dashboard-center#unexpected",
    "/dashboards/public?design=dashboard-center&board=5.999",
    "/dashboards/public?design=dashboard-center&board=5.7&extra=1",
    "/dashboards/public"
  ]) {
    const before = requests.length;
    await page.goto(baseUrl + path, { waitUntil: "domcontentloaded" });
    await expect.poll(() => requests.length).toBeGreaterThan(before);
    expect(requests.at(-1)).toContain("/api/bi/v2/auth/session");
    await expect(page.locator(".dashboard-workbench")).toHaveCount(0);
  }
});
