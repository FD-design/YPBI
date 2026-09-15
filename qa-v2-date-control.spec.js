import { expect, test } from "@playwright/test";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
test.use({ channel: "chrome" });

for (const board of ["5.2", "5.7"]) test(`日期完整宽度与点击态 ${board}`, async ({ page }) => {
  await page.goto(`${base}/dashboards/public?design=dashboard-center&board=${board}`);
  const trigger = page.getByRole("button", { name: /^日期范围：/ });
  for (const width of [1800, 1660, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(trigger).toBeVisible();
    const geometry = await trigger.evaluate(el => {
      const text = el.querySelector("span").getBoundingClientRect(), box = el.getBoundingClientRect();
      const icons = [...el.querySelectorAll("svg")].map(icon => icon.getBoundingClientRect());
      return { left: text.left, right: text.right, start: icons[0].right, end: icons[1].left, boxRight: box.right, scroll: el.scrollWidth, width: el.clientWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.start);
    expect(geometry.right).toBeLessThanOrEqual(geometry.end);
    expect(geometry.boxRight).toBeLessThanOrEqual(width);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await trigger.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(237, 243, 255)");
    const dialog = page.getByRole("dialog", { name: "选择日期范围" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "2026.09.03", exact: true }).click();
    const anchor = dialog.locator('[data-calendar-date="2026-09-03"]');
    await expect(anchor).toHaveClass(/is-anchor/);
    await expect(dialog.getByRole("button", { name: "确认日期", exact: true })).toBeDisabled();
    // Move beyond a previously hovered date: the clicked endpoint must remain visibly selected.
    await dialog.getByRole("button", { name: "2026.09.06", exact: true }).hover();
    expect(await anchor.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(40, 95, 232)");
    await dialog.getByRole("button", { name: "2026.09.06", exact: true }).click();
    await expect(dialog.locator(".is-endpoint")).toHaveCount(2);
    await expect(dialog.locator(".is-range")).toHaveCount(4);
    await expect(dialog.getByRole("button", { name: "确认日期", exact: true })).toBeEnabled();
    if (width === 1660) await page.screenshot({ path: `/private/tmp/ypbi-date-selected-${board}.png` });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});
