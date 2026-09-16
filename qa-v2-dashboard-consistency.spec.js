import { test, expect } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });
const url = board => `${base}/dashboards/public?design=dashboard-center&board=${board}`;
const typography = element => { const s = getComputedStyle(element); return { size: s.fontSize, weight: s.fontWeight, height: s.lineHeight, spacing: s.letterSpacing }; };

test("所有看板说明入口共用无边框样式、提示与轻量弹层", async ({ page }) => {
  test.setTimeout(90_000);
  for (const width of [1280, 390]) for (const board of ["5.2", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15", "5.5"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url(board));
    const trigger = page.getByRole("button", { name: "查看看板说明", exact: true });
    await expect(trigger, `看板 ${board} / ${width}px`).toBeVisible({ timeout: 15000 });
    expect(await trigger.evaluate(el => { const s = getComputedStyle(el); return { border: s.borderWidth, shadow: s.boxShadow, width: s.width, height: s.height, radius: s.borderRadius, icon: getComputedStyle(el.querySelector("svg")).width }; })).toEqual({ border: "0px", shadow: "none", width: "28px", height: "28px", radius: "50%", icon: "15px" });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "看板说明", exact: true });
    await expect(panel).toBeVisible(); await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const box = await panel.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape"); await expect(panel).not.toBeVisible(); await expect(trigger).toBeFocused();
    await trigger.click(); await panel.getByRole("button", { name: "关闭详情", exact: true }).click(); await expect(trigger).toBeFocused();
    if (board === "5.10") await page.screenshot({ path: `/private/tmp/ypbi-unified-description-${width}.png` });
  }
});

test("四张看板复用实际标题层级、页头日期与响应式边界", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  for (const width of [1800, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 960 });
    let baseline;
    for (const board of ["5.7", "5.2", "5.8", "5.9"]) {
      await page.goto(url(board));
      const head = page.locator(".dashboard-header");
      await expect(head.locator("h1")).toBeVisible();
      const styles = { title: await head.locator("h1").evaluate(typography), breadcrumb: await head.locator(".dashboard-header__breadcrumb").evaluate(typography), section: await page.locator(".dashboard-section-title").first().evaluate(typography) };
      baseline ??= styles;
      expect(styles).toEqual(baseline);
      expect(styles.title.weight).toBe("700");
      expect(styles.section.weight).toBe("600");
      await expect(head.locator(".ui-date-range__trigger:visible")).toHaveCount(1);
      await expect(page.locator(".topic-preview > section .ui-date-range__trigger")).toHaveCount(0);
      const date = await head.locator(".ui-date-range__trigger").first().boundingBox();
      const title = await head.locator("h1").boundingBox();
      if (width >= 1024) {
        expect(title.height).toBeLessThan(35);
        if (date.y < title.y + title.height) expect(date.x).toBeGreaterThan(title.x + title.width);
        else expect(date.y).toBeGreaterThanOrEqual(title.y + title.height);
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      const headerBounds = await head.boundingBox();
      expect(headerBounds.x + headerBounds.width).toBeLessThanOrEqual(width);
      await expect(page.locator(".v2-page")).not.toContainText(/\bCohort\b|\bD0\b/);
      if (width === 1800 || width === 390) await page.screenshot({ path: `/private/tmp/ypbi-consistency-${board}-${width}.png` });
    }
  }
  expect(errors).toEqual([]);
});

test("二维结构常驻交叉表、排行保持图形，同口径窗口保留完整阅读和导出", async ({ page }) => {
  for (const [board, name, count] of [["5.8", "活跃结构", 7], ["5.9", "消费结构", 7], ["5.9", "内容排行", 50]]) {
    await page.goto(url(board));
    const panel = page.getByRole("article", { name, exact: true });
    await expect(panel.locator("canvas")).toBeVisible();
    await expect(panel.locator("table")).toHaveCount(name === "内容排行" ? 0 : 1);
    await panel.scrollIntoViewIfNeeded();
    const before = await panel.boundingBox();
    const trigger = panel.getByRole("button", { name: "查看同口径数据表", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: `${name === "活跃结构" ? "日活跃用户数" : name === "消费结构" ? "观影用户数" : name}同口径数据表`, exact: true });
    await expect(dialog.locator("tbody tr")).toHaveCount(count);
    await expect(dialog.getByRole("button", { name: `导出${name}${name === "内容排行" ? "" : "二维分析"}`, exact: true })).toBeVisible();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    if (name === "内容排行") {
      await expect(dialog.getByRole("navigation")).toContainText("共 126 条");
      await dialog.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(dialog.getByRole("navigation")).toContainText("51–100");
    }
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    expect(await panel.boundingBox()).toEqual(before);
  }
});

test("业务交叉表与完整体验共用行列组件，交叉值与零值不自动汇总", async ({ page }) => {
  await page.goto(url("5.8"));
  const panel = page.getByRole("article", { name: "活跃结构", exact: true });
  await expect(panel.locator(".ui-pivot-table thead th")).toHaveText(["客户端", "总体", "新用户", "老用户"]);
  await expect(panel.locator(".ui-pivot-table tbody th")).toHaveText(["总体", "Android", "iOS", "Web"]);
  await expect(panel.locator(".ui-pivot-table tbody tr").first()).toContainText("184,641");
  await expect(panel.locator(".is-total")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "导出活跃结构二维分析", exact: true }).first()).toBeVisible();
  const dataStyle = await panel.locator("td:not(.is-selected)").first().evaluate(typography);
  await panel.screenshot({ path: "/private/tmp/ypbi-consistency-cross.png" });
  await page.goto(`${base}/dashboards/public?design=v1-chart-states`);
  const reference = page.locator('[data-chart-kind="table-crosstab"]');
  await expect(reference.locator(".ui-pivot-table tbody tr")).toHaveCount(4);
  expect(await reference.locator("td").first().evaluate(typography)).toEqual(dataStyle);
  await expect(reference.locator(".is-total")).toContainText("88,250");
});
