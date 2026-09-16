import { test, expect } from "@playwright/test";

const baseUrl = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";

test.use({
  viewport: { width: 1600, height: 1000 },
  channel: "chrome"
});

test("v13 工作区稳定切换并保留统一骨架", async ({ page }) => {
  await page.goto(`${baseUrl}/?workspace=templates&ui=v13`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".platform-sidebar")).toBeVisible();
  await expect(page.locator(".dashboard-command-bar")).toBeVisible();
  await expect(page.locator(".ui-menu-select__trigger")).toBeVisible();
  await expect(page.locator(".dashboard-switcher select")).toHaveCount(0);
  await expect(page.locator('.card[data-card-type="kpi"]').first().locator(".data-state, .kpi-grid")).toBeVisible();
  await expect(page.locator(".card .card-data-warning + .data-state.error")).toHaveCount(0);

  await page.locator(".ui-menu-select__trigger").click();
  await expect(page.getByRole("listbox", { name: "当前模板" })).toBeVisible();
  await expect(page.getByRole("option", { name: /多平台经营总览/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "当前模板" })).toBeHidden();
  await expect(page.locator(".ui-menu-select__trigger")).toBeFocused();

  await page.evaluate(() => { window.__ypbiShellMarker = "alive"; });
  const initialSidebar = await page.locator(".platform-sidebar").boundingBox();
  const initialMain = await page.locator("main > .main-panel").boundingBox();
  expect(initialSidebar).not.toBeNull();
  expect(initialMain).not.toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1600);
  const nonPointerButtons = await page.locator("button:not(:disabled):visible").evaluateAll((buttons) => buttons
    .filter((button) => getComputedStyle(button).cursor !== "pointer")
    .map((button) => button.getAttribute("aria-label") || button.textContent?.trim() || "未命名按钮"));
  expect(nonPointerButtons).toEqual([]);
  await page.screenshot({ path: "/private/tmp/ypbi-01-dashboard.png", fullPage: false });

  await page.getByRole("link", { name: "分析中心" }).click();
  await expect(page.getByRole("heading", { name: "分析中心" })).toBeVisible();
  await expect(page.locator(".asset-filter-toolbar select")).toHaveCount(0);
  await expect(page.locator(".asset-filter-toolbar .ui-menu-select")).toHaveCount(1);
  const assetTypeLayout = await page.locator(".asset-type-filters").evaluate((filters) => {
    const frame = filters.getBoundingClientRect();
    const outside = [...filters.querySelectorAll("button")].filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left < frame.left - 1 || rect.right > frame.right + 1 || rect.bottom > frame.bottom + 1;
    });
    return { flexWrap: getComputedStyle(filters).flexWrap, scrollWidth: filters.scrollWidth, clientWidth: filters.clientWidth, outside: outside.length };
  });
  expect(assetTypeLayout.flexWrap).toBe("wrap");
  expect(assetTypeLayout.scrollWidth).toBeLessThanOrEqual(assetTypeLayout.clientWidth);
  expect(assetTypeLayout.outside).toBe(0);
  await page.locator(".asset-filter-toolbar .ui-menu-select__trigger").click();
  const modelMenuBox = await page.locator(".asset-filter-toolbar .ui-menu-select__menu").boundingBox();
  expect((modelMenuBox?.x ?? 0) + (modelMenuBox?.width ?? 0)).toBeLessThanOrEqual(1600);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__ypbiShellMarker)).toBe("alive");
  const librarySidebar = await page.locator(".platform-sidebar").boundingBox();
  const libraryMain = await page.locator("main > .main-panel").boundingBox();
  expect(librarySidebar?.y).toBe(initialSidebar?.y);
  expect(libraryMain?.x).toBe(initialMain?.x);
  await page.screenshot({ path: "/private/tmp/ypbi-02-card-library.png", fullPage: false });

  await page.getByRole("button", { name: "创建分析" }).click();
  await expect(page.getByRole("heading", { name: /生成.*分析卡片/ })).toBeVisible();
  await expect(page.locator(".analysis-summary")).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-03-analysis-editor.png", fullPage: false });

  await page.getByRole("link", { name: "看板中心" }).click();
  const platformFilter = page.locator(".platform-trigger");
  const commandBarBeforeFilter = await page.locator(".dashboard-command-bar").boundingBox();
  await platformFilter.click();
  await expect(page.getByRole("dialog", { name: "选择平台范围" })).toBeVisible();
  const commandBarDuringFilter = await page.locator(".dashboard-command-bar").boundingBox();
  expect(commandBarDuringFilter?.x).toBeCloseTo(commandBarBeforeFilter?.x ?? 0, 3);
  expect(commandBarDuringFilter?.width).toBeCloseTo(commandBarBeforeFilter?.width ?? 0, 3);
  await page.screenshot({ path: "/private/tmp/ypbi-04-filter-dialog.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "选择平台范围" })).toBeHidden();
  await expect(platformFilter).toBeFocused();

  const dateFilter = page.locator(".date-trigger");
  const dateTriggerBox = await dateFilter.boundingBox();
  await dateFilter.click();
  const dateDialog = page.getByRole("dialog", { name: "选择时间范围" });
  await expect(dateDialog).toBeVisible();
  await expect(dateDialog.getByText("选择看板统计时间")).toBeVisible();
  await expect(dateDialog.getByText("选择对比生成方式")).toBeVisible();
  await expect(dateDialog.locator('.date-preset-grid button[aria-pressed="true"]')).toHaveCount(1);
  await expect(dateDialog.locator('.comparison-mode-tabs button[aria-pressed="true"]')).toHaveCount(1);
  const dateDialogBox = await dateDialog.boundingBox();
  expect((dateDialogBox?.x ?? 0) + (dateDialogBox?.width ?? 0)).toBeCloseTo((dateTriggerBox?.x ?? 0) + (dateTriggerBox?.width ?? 0), 3);
  expect(dateDialogBox?.y ?? 0).toBeGreaterThanOrEqual((dateTriggerBox?.y ?? 0) + (dateTriggerBox?.height ?? 0) + 4);
  const dateSections = await dateDialog.locator(".date-filter-section").evaluateAll((sections) => sections.map((section) => {
    const rect = section.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  expect(dateSections).toHaveLength(2);
  expect(dateSections[0].bottom).toBeLessThanOrEqual(dateSections[1].top);
  await page.keyboard.press("Escape");
  await expect(dateDialog).toBeHidden();
  await expect(dateFilter).toBeFocused();

  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await expect(page.locator(".platform-sidebar")).toHaveClass(/is-collapsed/);
  await expect.poll(async () => (await page.locator(".platform-sidebar").boundingBox())?.width ?? 999).toBeLessThan(70);

  await page.getByRole("link", { name: "模板管理" }).click();
  await expect(page.getByRole("heading", { name: "模板管理" })).toBeVisible();
  await expect(page.locator("main select")).toHaveCount(0);
  await expect(page.locator(".template-edit-panel .ui-menu-select")).toHaveCount(2);
  await expect(page.locator(".platform-sidebar")).toHaveClass(/is-collapsed/);
  await expect.poll(() => page.evaluate(() => window.__ypbiShellMarker)).toBe("alive");
  const templatePanelBeforeDrawer = await page.locator(".template-edit-panel").boundingBox();
  await page.getByRole("button", { name: "添加卡片", exact: true }).first().click();
  await expect(page.locator(".asset-drawer")).toBeVisible();
  const templatePanelDuringDrawer = await page.locator(".template-edit-panel").boundingBox();
  expect(templatePanelDuringDrawer?.x).toBeCloseTo(templatePanelBeforeDrawer?.x ?? 0, 3);
  expect(templatePanelDuringDrawer?.width).toBeCloseTo(templatePanelBeforeDrawer?.width ?? 0, 3);
  await page.getByRole("button", { name: "关闭卡片库" }).click();
  await page.locator(".field-help").first().click();
  await expect(page.getByRole("dialog", { name: /字段说明/ })).toBeVisible();
  const overlayLayers = await page.evaluate(() => ({
    portal: Number(getComputedStyle(document.querySelector(".platform-portal-layer")).zIndex),
    sidebar: Number(getComputedStyle(document.querySelector(".platform-sidebar")).zIndex),
    topbar: Number(getComputedStyle(document.querySelector(".platform-topbar")).zIndex),
    modal: (() => {
      const rect = document.querySelector(".field-explanation-modal").getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()
  }));
  expect(overlayLayers.portal).toBeGreaterThan(overlayLayers.sidebar);
  expect(overlayLayers.portal).toBeGreaterThan(overlayLayers.topbar);
  expect(overlayLayers.modal.x).toBe(0);
  expect(overlayLayers.modal.y).toBe(0);
  await page.getByRole("button", { name: "关闭字段说明" }).click();
  await page.screenshot({ path: "/private/tmp/ypbi-05-template-editor.png", fullPage: false });

  await page.goBack();
  await expect(page.getByRole("heading", { name: "多平台经营总览" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__ypbiShellMarker)).toBe("alive");
  await page.getByRole("button", { name: "展开侧边栏" }).click();
  await page.getByRole("link", { name: "数据字典" }).click();
  await expect(page.getByRole("heading", { name: "数据字典" })).toBeVisible();
  await page.screenshot({ path: "/private/tmp/ypbi-06-dictionary.png", fullPage: false });
});

test("v13 平板与移动端导航、筛选不产生横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${baseUrl}/?workspace=templates&ui=v13`, { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await page.locator(".platform-sidebar").boundingBox())?.width ?? 999).toBeLessThan(70);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await page.screenshot({ path: "/private/tmp/ypbi-07-tablet.png", fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => window.scrollTo(0, 220));
  await expect.poll(async () => (await page.locator(".platform-topbar").boundingBox())?.y ?? -1).toBeCloseTo(0, 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByRole("button", { name: "打开主导航" })).toBeVisible();
  await page.getByRole("button", { name: "打开主导航" }).click();
  await expect(page.locator(".platform-sidebar")).toHaveClass(/is-open/);
  await page.getByRole("link", { name: "看板中心" }).click();
  await expect(page.locator(".platform-sidebar")).not.toHaveClass(/is-open/);
  await expect.poll(async () => (await page.locator(".platform-sidebar").boundingBox())?.x ?? 0).toBeLessThan(-200);
  const mobileCommandBarBeforeFilter = await page.locator(".dashboard-command-bar").boundingBox();
  await page.locator(".mobile-filter-trigger").click();
  await expect(page.getByRole("dialog", { name: "查看当前筛选" })).toBeVisible();
  const mobileCommandBarDuringFilter = await page.locator(".dashboard-command-bar").boundingBox();
  const mobileFilterModal = await page.locator(".filter-modal").boundingBox();
  expect(mobileCommandBarDuringFilter?.x).toBeCloseTo(mobileCommandBarBeforeFilter?.x ?? 0, 3);
  expect(mobileCommandBarDuringFilter?.width).toBeCloseTo(mobileCommandBarBeforeFilter?.width ?? 0, 3);
  expect(mobileFilterModal?.width).toBeCloseTo(390, 3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/private/tmp/ypbi-08-mobile-filter.png", fullPage: false });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "查看当前筛选" })).toBeHidden();

  await page.getByRole("button", { name: "打开主导航" }).click();
  await page.getByRole("link", { name: "分析中心" }).click();
  const mobileAssetFilters = await page.locator(".asset-type-filters").evaluate((filters) => ({
    flexWrap: getComputedStyle(filters).flexWrap,
    overflowX: getComputedStyle(filters).overflowX,
    scrollWidth: filters.scrollWidth,
    clientWidth: filters.clientWidth
  }));
  expect(mobileAssetFilters.flexWrap).toBe("nowrap");
  expect(mobileAssetFilters.overflowX).toBe("auto");
  expect(mobileAssetFilters.scrollWidth).toBeGreaterThan(mobileAssetFilters.clientWidth);
  await expect(page.locator("main select")).toHaveCount(0);
});
