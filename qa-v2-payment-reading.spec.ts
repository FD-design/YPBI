import { expect, test } from "@playwright/test";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const url = (compared = true) => `${base}/dashboards/public?design=dashboard-center&board=5.11&view=${encodeURIComponent(JSON.stringify({ range: { start: "2026-09-02", end: "2026-09-08" }, compared, mixed: false }))}`;
test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });

test("支付九项摘要保持同支付方式日值、双日比较及就地详情", async ({ page }) => {
  await page.goto(url());
  const panel = page.getByRole("article", { name: "拉单与充值转化", exact: true });
  const cards = panel.locator(".compact-metric-reading");
  await expect(cards).toHaveCount(9);
  await expect(panel.locator(".payment-business__summary")).not.toContainText("计算基数待接入");
  await expect(cards.getByRole("button", { name: "计算依据", exact: true })).toHaveCount(4);
  await expect(cards.locator(".compact-metric-reading__trend")).toHaveCount(0);
  for (const card of await cards.all()) {
    await expect(card.locator(".metric-summary__context")).toHaveText("9-8（二）");
    await expect(card.locator(".metric-summary__comparison")).toHaveCount(2);
    await expect(card.getByRole("button", { name: "查看趋势与数据", exact: true })).toBeVisible();
  }
  const amount = panel.getByRole("article", { name: "充值金额轻量诊断", exact: true });
  const original = await amount.locator(".metric-summary__number strong").innerText();
  await panel.getByRole("radio", { name: "微信", exact: true }).click();
  await expect(amount.locator(".metric-summary__number strong")).not.toHaveText(original);
  await amount.getByRole("button", { name: /较前一天/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("2026-09-07");
  await page.keyboard.press("Escape");
  await amount.getByRole("button", { name: /较上周同日/ }).click();
  await expect(page.getByRole("tooltip")).toContainText("2026-09-01");
  await page.keyboard.press("Escape");
  await amount.getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "充值金额 · 完整趋势与数据", exact: true });
  await expect(dialog.getByRole("region", { name: "充值金额折线视图", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "表格", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "充值金额逐日数据", exact: true }).locator("tbody tr")).toHaveCount(7);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("table", { name: "支付方式成功率核对", exact: true }).locator("tbody tr")).toHaveCount(2);
});

test("支付摘要三档可读且关闭比较后无残留，完整周期核对仍可访问", async ({ page }) => {
  await page.goto(url());
  const panel = page.getByRole("article", { name: "拉单与充值转化", exact: true });
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await panel.screenshot({ path: `/private/tmp/ypbi-230-payment-${width}.png` });
  }
  await page.goto(url(false));
  await expect(panel.locator(".compact-metric-reading .metric-summary__comparison")).toHaveCount(0);
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const table = page.getByRole("dialog").getByRole("table", { name: "拉单与充值完整明细", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table).toContainText("支付宝");
  await expect(table).toContainText("微信");
});
