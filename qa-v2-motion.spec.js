import { expect, test } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
const path = `${base}/dashboards/public?design=dashboard-center&board=5.7`;
test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) await page.screenshot({ path: `/private/tmp/ypbi-motion-failure-${info.line}.png` }); });

test("轻量进入不改变图表几何，嵌套弹层即时关闭与连续重开", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.goto(path);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const card = page.locator(".dashboard-metric-card").first(); await card.scrollIntoViewIfNeeded();
    const measure = () => card.evaluate(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }; });
    const before = await measure();
    const trigger = card.getByRole("button", { name: "查看同口径数据表", exact: true }); await trigger.click();
    const table = page.getByRole("dialog", { name: "落地页访问次数同口径数据表", exact: true });
    await expect(table).toHaveCSS("animation-name", "ui-reveal");
    await expect(table).toHaveCSS("animation-duration", "0.18s");
    expect(await measure()).toEqual(before);
    await table.getByRole("button", { name: /^导出/ }).click();
    const exporter = page.getByRole("dialog", { name: /^导出/ }); await expect(exporter).toHaveCSS("animation-name", "ui-reveal");
    await page.keyboard.press("Escape"); await expect(exporter).toHaveCount(0); await expect(table).toBeVisible();
    await expect(table.getByRole("button", { name: /^导出/ })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(table).toHaveCount(0); await expect(trigger).toBeFocused();
    for (let i = 0; i < 4; i++) {
      await trigger.click(); await page.keyboard.press("Escape"); await expect(table).toHaveCount(0); await expect(trigger).toBeFocused();
    }
    expect(await measure()).toEqual(before);
    await expect(card.locator(".chart")).toHaveCSS("animation-name", "none");
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(a => a.playState === "running").length)).toBe(0);
  }
  expect(errors).toEqual([]);
});

test("菜单日期与移动目录共用短进入，减少动态效果时保持即时可操作", async ({ page }) => {
  await page.goto(path);
  for (const reducedMotion of ["no-preference", "reduce"]) {
    await page.emulateMedia({ reducedMotion }); await page.setViewportSize({ width: 1280, height: 1000 });
    const date = page.getByRole("button", { name: /^日期范围：/ }); await date.click();
    const picker = page.getByRole("dialog", { name: "选择日期范围", exact: true });
    await expect(picker).toHaveCSS("animation-name", reducedMotion === "reduce" ? "none" : "ui-reveal");
    await page.keyboard.press("Escape"); await expect(date).toBeFocused();
    const select = page.getByRole("button", { name: /^业务范围：/ }); await select.click();
    await expect(page.getByRole("listbox", { name: "业务范围", exact: true })).toHaveCSS("animation-name", reducedMotion === "reduce" ? "none" : "ui-reveal");
    await page.keyboard.press("Escape"); await expect(select).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    const directoryTrigger = page.getByRole("button", { name: "选择看板", exact: true }); await directoryTrigger.click();
    const directory = page.getByRole("dialog", { name: "选择看板", exact: true });
    await expect(directory).toHaveCSS("animation-name", reducedMotion === "reduce" ? "none" : "ui-drawer-enter");
    await expect.poll(() => directory.evaluate(el => el.getAnimations().filter(a => a.playState === "running").length)).toBe(0);
    expect((await directory.boundingBox()).width).toBe(390);
    await page.screenshot({ path: `/private/tmp/ypbi-motion-directory-${reducedMotion}.png` });
    await page.keyboard.press("Escape"); await expect(directoryTrigger).toBeFocused();
    const navigation = page.getByRole("button", { name: "打开主导航", exact: true }); await navigation.click();
    const side = page.locator('.v2-sidebar[data-overlay="true"]');
    await expect(side).toHaveCSS("animation-name", reducedMotion === "reduce" ? "none" : "ui-drawer-enter");
    await page.keyboard.press("Escape"); await expect(navigation).toBeFocused();
    await expect(side).toHaveCSS("visibility", "hidden"); await expect(side).toHaveCSS("transition-duration", "0s");
  }
});

test("加载占位不抖动，可见性事件暂停、减少动态效果静止且完成移除", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" }); await page.goto(path);
  // 仅挂载共用状态组件，以可控结束时间验证等待反馈，不伪造业务结果。
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const { StatePanel } = await import("/src/v2/components/StatePanel.tsx");
    const host = document.createElement("div"); host.className = "ypbi-v2"; host.id = "loading-qa";
    Object.assign(host.style, { position: "fixed", inset: "60px 16px auto", zIndex: "9999" }); document.body.append(host);
    window.__loadingRoot = createRoot(host); window.__loadingRoot.render(React.createElement(StatePanel, { kind: "loading", title: "正在加载", description: "正在读取当前查询结果" }));
  });
  const loader = page.locator("#loading-qa .ui-loading-indicator"); await expect(loader).toHaveCSS("animation-name", "ui-loading-turn");
  const status = page.locator("#loading-qa .v2-state"); const box = await status.boundingBox();
  await expect(status).toHaveAttribute("role", "status");
  const state = await loader.evaluate(el => { const animation = el.getAnimations()[0]; return { duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations }; });
  expect(state.duration).toBe(900); expect(state.iterations).toBe(Infinity);
  // Headless Chrome 保持各页面为 visible；通过实际监听入口模拟后台可见性事件。
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.uiMotionPaused)).toBe("true");
  await expect(loader).toHaveCSS("animation-play-state", "paused");
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(loader).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" }); await expect(loader).toHaveCSS("animation-name", "none");
  expect(await status.boundingBox()).toEqual(box); await page.screenshot({ path: "/private/tmp/ypbi-loading-static.png" });
  await page.evaluate(() => { window.__loadingRoot.unmount(); document.getElementById("loading-qa").remove(); });
  await expect(loader).toHaveCount(0);
});
