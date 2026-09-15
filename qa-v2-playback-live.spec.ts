import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test.use({ channel: "chrome", viewport: { width: 1280, height: 1000 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5173";
const metric = { id: "M101", referenceMetricId: "M101", name: "观影次数", unit: "次", authorityVersion: "qa-candidate/v1",
  definition: "所选平台单日后台记录的视频播放发起次数。", formula: "同一业务日完整 288 个五分钟统计点的播放发起次数之和",
  sourceNote: "开始记录去重及测试流量排除规则待验数。", inputs: [{ key: "watchCount", name: "播放发起次数", unit: "次" }] };

async function playbackFixture(page: Page) {
  const control = { fail: false };
  await page.route("**/api/bi/v2/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/session")) return route.fulfill({ json: { success: true, data: { user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.reader", displayName: "验收账号", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" }, expiresAt: "2099-01-01T00:00:00.000Z", csrfToken: "a".repeat(43), mustChangePassword: false } } });
    if (path.endsWith("/catalog/readable-dashboards")) return route.fulfill({ json: { success: true, data: { enabled: true, categories: ["内容消费与互动"], items: [{ id: "5.12", title: "播放与观看质量", category: "内容消费与互动", metricIds: ["M101"], pendingMetricNames: [] }] } } });
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ json: { success: true, data: { items: [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }] } } });
    if (path.endsWith("/queries/dashboards/daily-reading")) {
      if (control.fail) return route.fulfill({ status: 504, json: { success: false, error: { code: "UPSTREAM_TIMEOUT", message: "播放来源超时", requestId: "qa-playback" } } });
      const query = route.request().postDataJSON();
      const count = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
      return route.fulfill({ json: { success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: "qa-playback", fetchedAt: "2026-09-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["realtime.stats"],
        series: [{ metric, points: Array.from({ length: count }, (_, index) => {
          const date = new Date(Date.parse(query.dateRange[0]) + index * 86400000).toISOString().slice(0, 10);
          const value = 100 + Number(date.slice(-2));
          return { date, state: "available", value, inputs: [{ key: "watchCount", value }] };
        }) }]
      } } });
    }
    return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "未配置测试接口", requestId: "qa" } } });
  });
  return control;
}

test("播放阶段只接同范围发起次数，真实说明、原始输入、两期CSV和阶段表一致", async ({ page }) => {
  await playbackFixture(page);
  await page.goto(`${base}/dashboards/public?board=5.12&pid=PH&start=2026-09-02&end=2026-09-08&compare=previous`);
  const panel = page.getByRole("article", { name: "播放阶段关系", exact: true });
  const attempts = panel.getByRole("article", { name: "观影次数轻量诊断", exact: true });
  await expect(attempts.locator(".metric-summary__number strong")).toHaveText("108");
  await expect(attempts.getByText("待验数", { exact: true })).toHaveCount(1);
  await expect(panel.getByRole("article", { name: "起播次数轻量诊断", exact: true }).locator(".data-origin-badge")).toHaveText("演示数据");
  await expect(panel.getByRole("article", { name: "起播率轻量诊断", exact: true }).locator(".data-origin-badge")).toHaveText("演示数据");
  await attempts.getByRole("button", { name: "查看趋势与数据", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "观影次数 · 完整趋势与数据", exact: true });
  await dialog.getByText("来源记录与计算输入", { exact: true }).click();
  await expect(dialog).toContainText("完整 288 个五分钟统计点");
  await expect(dialog.getByRole("table", { name: "观影次数每日数据", exact: true }).locator("tbody tr")).toHaveCount(7);
  await dialog.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const data = page.getByRole("dialog", { name: "观影次数同口径数据表", exact: true });
  const downloaded = page.waitForEvent("download");
  await data.getByRole("button", { name: "导出", exact: true }).click();
  const csv = readFileSync((await (await downloaded).path())!, "utf8");
  expect(csv).toContain('"当前期","PH","2026-09-08","108","108"');
  expect(csv).toContain('"对比期","PH","2026-09-01","101","101"');
  expect(csv).toContain(metric.formula);
  expect(csv).toContain(metric.sourceNote);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "查看同口径数据表", exact: true }).click();
  const stageData = page.getByRole("dialog", { name: "播放阶段同口径数据表", exact: true });
  const attemptSummary = stageData.getByRole("table", { name: "播放阶段结果", exact: true }).locator("tbody tr").filter({ hasText: "观影次数" }).filter({ hasText: "摘要" });
  await expect(attemptSummary).toContainText("108");
  await expect(attemptSummary).toContainText("真实候选 · 待验数");
  await expect(stageData).toContainText("隔离演示");
  await page.keyboard.press("Escape");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await panel.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/private/tmp/ypbi-playback-live-${width}.png` });
  }
});

test("播放来源刷新失败保留原真实读数，恢复不改变相邻演示起播", async ({ page }) => {
  const control = await playbackFixture(page);
  await page.goto(`${base}/dashboards/public?board=5.12&pid=PH&start=2026-09-02&end=2026-09-08`);
  const panel = page.getByRole("article", { name: "播放阶段关系", exact: true });
  const attempts = panel.getByRole("article", { name: "观影次数轻量诊断", exact: true });
  const starts = panel.getByRole("article", { name: "起播次数轻量诊断", exact: true }).locator(".metric-summary__number strong");
  await expect(attempts.locator(".metric-summary__number strong")).toHaveText("108");
  const startValue = await starts.textContent();
  control.fail = true;
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(page.getByText("刷新失败，真实区域保留上次结果。", { exact: true })).toBeVisible();
  await expect(attempts.locator(".metric-summary__number strong")).toHaveText("108");
  await expect(starts).toHaveText(startValue!);
  control.fail = false;
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(page.getByText("刷新失败，真实区域保留上次结果。", { exact: true })).toHaveCount(0);
  await expect(attempts.locator(".metric-summary__number strong")).toHaveText("108");
});
