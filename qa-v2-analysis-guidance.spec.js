import { test, expect } from "@playwright/test";
import { selectReviewState } from "./tools/qa-review-tools.mjs";
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
test.use({ channel: "chrome" });
const boardUrl = board => `${base}/dashboards/public?design=dashboard-center&board=${board}`;

for (const board of ["5.2", "5.5", "5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15"]) test(`分析引导 ${board} 实际显示与多端层级`, async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(boardUrl(board));
  const copy = page.locator(".dashboard-guidance:visible");
  await expect(copy.first()).toBeVisible();
  expect(await copy.count()).toBeGreaterThanOrEqual(2);
  const descriptions = (await copy.allTextContents()).map(value => value.trim());
  expect(new Set(descriptions).size).toBe(descriptions.length);
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    const styles = await copy.evaluateAll(nodes => nodes.map(node => {
      const css = getComputedStyle(node);
      return { size: css.fontSize, weight: css.fontWeight, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, wrap: css.whiteSpace };
    }));
    expect(styles.every(style => style.size === "13px" && style.weight === "400" && style.left >= 0 && style.right <= width && style.wrap !== "nowrap")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  expect(errors).toEqual([]);
});

test("观影去向与留存共用基数，切换、详情、导出、深链与原排行保留", async ({ page }) => {
  await page.goto(boardUrl("5.9"));
  const panel = page.getByRole("article", { name: "观影后用户去向", exact: true });
  await expect(panel).toContainText("演示数据");
  await expect(page.locator(".dashboard-metric-card")).toHaveCount(12);
  await panel.getByRole("button", { name: /回访未有效观看/ }).click();
  await expect(panel).toContainText("再检查内容承接、播放和付费门槛");
  await panel.getByRole("radio", { name: "第3日", exact: true }).click();
  await page.reload();
  await expect(panel.getByRole("radio", { name: "第3日", exact: true })).toBeChecked();
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "观影后用户去向同口径数据表", exact: true });
  const rows = await dialog.locator("tbody tr").allTextContents();
  expect(rows).toHaveLength(7);
  expect(rows.filter(row => row.includes("未成熟"))).toHaveLength(3);
  await dialog.getByRole("button", { name: "导出观影后用户去向", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载演示 XLSX", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("演示数据");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await panel.screenshot({ path: `/private/tmp/ypbi-watching-diagnosis-${width}.png` });
  }
  await panel.getByRole("radio", { name: "第7日", exact: true }).click();
  await expect(panel).toContainText("当前范围暂无可汇总的用户批次");
  await panel.getByRole("radio", { name: "次日", exact: true }).click();
  await selectReviewState(page, "组合异常态");
  await expect(panel).toContainText("4/7 批可用");
  await panel.getByRole("button", { name: /未回访/ }).first().click();
  await panel.getByRole("link", { name: "渠道质量", exact: true }).click();
  await expect(page.getByRole("heading", { name: "获客与新增", exact: true })).toBeVisible();
  await page.goBack();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("article", { name: "内容排行", exact: true })).toBeAttached();
});
