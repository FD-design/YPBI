import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { DAILY_STATISTICS_VERSION } from "./contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "./contracts/operating-detail-projection";
import { operatingQueryDateRange } from "./contracts/operating-query-jobs";
import { OPERATING_QUERY_VALIDATION_PATH as path } from "./contracts/operating-query-validation";

const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("联调回归仅允许本地隔离地址");
const csrf = "c".repeat(43), subject = "00000000-0000-4000-8000-000000000001", date = "2026-10-21";
const pids = ["PH", ...Array.from({ length: 9 }, (_, i) => `QA${i + 1}`), "FBI", ...Array.from({ length: 9 }, (_, i) => `QB${i + 1}`)];
const groups = [{ site: "primary", pids: pids.slice(0, 10) }, { site: "secondary", pids: pids.slice(10) }];
const handles = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
// Entirely synthetic in-memory projections; no saved credential or live data request is used.
function dashboard(pid: string) {
  const dateRange = operatingQueryDateRange(date);
  return { success: true, data: { schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange, projection: "operating_snapshot" }, queryId: `synthetic-${pid}`,
    fetchedAt: "2026-10-23T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["synthetic"],
    series: OPERATING_METRIC_IDS.map((id, i) => ({ metric: { id, name: id, unit: "人", definition: "合成测试", authorityVersion: "synthetic", formula: null, referenceMetricId: id, sourceNote: null, inputs: [{ key: "n", name: "人数", unit: "人" }] },
      points: operatingSnapshotDates(dateRange).map(date => ({ date, state: i === 1 ? "no_value" : "available", sourceStatus: i === 1 ? "PROCESSING" : "READY", value: i === 1 ? null : 0, inputs: [{ key: "n", value: i === 1 ? 2 : 0 }] })),
      periodStatistics: { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } })) } };
}
async function fixtures(page: Page, options: { pendingCreate?: boolean; expired?: boolean; authenticationExpired?: boolean; testMode?: boolean } = {}) {
  if (options.testMode) await page.addInitScript(({ subject }) => sessionStorage.setItem(`ypbi.data-environment.v1:${subject}`, "test"), { subject });
  const calls: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const completed = new Set<number>();
  let activeSync = 0, maxSync = 0;
  await page.route("**/api/bi/**", async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ path: pathname, method: request.method(), headers: request.headers(), body });
    if (pathname === "/api/bi/v2/auth/session") return route.fulfill({ json: { success: true, data: {
      user: { subjectId: subject, username: "qa.maintainer", displayName: "合成QA维护者", role: "maintainer", permissions: ["bi:read", "bi:data-source-maintenance:enter"], pidScope: "all" }, expiresAt: "2099-09-08T00:00:00.000Z", mustChangePassword: false, csrfToken: csrf
    } } });
    if (pathname === "/api/bi/v2/data-environment") return route.fulfill({ json: { success: true, data: request.headers()["x-ypbi-data-environment"] === "test"
      ? { mode: "test", testAvailable: true, userName: "synthetic-test-user", expiresAt: "2099-09-08T00:00:00.000Z" }
      : { mode: "production", testAvailable: true } } });
    if (pathname === "/api/bi/admin/data-sources/status") return route.fulfill({ json: { success: true, data: ["primary", "secondary"].map(site => ({ site, configured: true, userName: `synthetic-${site}`, tokenHint: "••••0001", updatedAt: null })) } });
    if (pathname === "/api/bi/admin/data-preview/status") return route.fulfill({ json: { success: true, data: { enabled: true, active: true, userName: "synthetic-test-user", expiresAt: "2099-09-08T00:00:00.000Z" } } });
    if (pathname === `${path}/capabilities`) {
      if (options.authenticationExpired) return route.fulfill({ status: 401, json: { success: false, error: { code: "AUTHENTICATION_REQUIRED", requestId: "synthetic-bi-expired", message: "raw-auth-secret-must-not-escape" } } });
      if (options.expired) return route.fulfill({ status: 401, json: { success: false, error: { code: "MAINTENANCE_LOGIN_REQUIRED", requestId: "synthetic-maintenance-expired", message: "raw-secret-must-not-escape" } } });
      return route.fulfill({ json: { success: true, data: { environment: "production", enabled: true, groups } } });
    }
    if (pathname === path && request.method() === "POST") {
      const index = groups.findIndex(group => group.pids[0] === body.pids[0]);
      if (options.pendingCreate) await pending;
      return route.fulfill({ json: { success: true, data: { ...body, handle: handles[index], reused: index === 1 } } }).catch(() => {});
    }
    if (pathname.startsWith(`${path}/`)) {
      const index = pathname.includes(handles[0]) ? 0 : 1;
      const progress = { kind: "operating-snapshot", pids: groups[index].pids, date, handle: handles[index], status: "SUCCEEDED", phase: "query", completedUnits: 14, totalUnits: 14, attempts: 1 };
      if (pathname.endsWith("/result")) { completed.add(index); return route.fulfill({ json: { success: true, data: { ...progress, phase: "complete", dashboards: groups[index].pids.map(dashboard) } } }); }
      return route.fulfill({ json: { success: true, data: progress } });
    }
    if (pathname === "/api/bi/v2/queries/dashboards/daily-reading") {
      expect(completed.size).toBe(2); activeSync++; maxSync = Math.max(maxSync, activeSync);
      expect(body).toEqual({ boardId: "5.2", pid: body.pid, dateRange: operatingQueryDateRange(date), projection: "operating_snapshot" });
      await new Promise(resolve => setTimeout(resolve, 10)); activeSync--;
      return route.fulfill({ json: dashboard(body.pid) });
    }
    return route.fulfill({ status: 404, json: { success: false, error: { code: "SYNTHETIC_UNEXPECTED_ROUTE", message: "隔离测试未登记路径" } } });
  });
  return { calls, release, maxSync: () => maxSync };
}
async function openPane(page: Page) {
  await page.goto(`${base}/admin/data-sources`);
  await expect(page.getByRole("heading", { name: "数据源维护", exact: true })).toBeVisible();
  const pane = page.getByTestId("operating-validation");
  await expect(pane).not.toHaveAttribute("open");
  await pane.locator("summary").click();
  await pane.getByLabel("业务日期").fill(date);
  return pane;
}
test.use({ channel: "chrome", viewport: { width: 1280, height: 950 }, serviceWorkers: "block" });
test.setTimeout(45_000);

for (const width of [1280, 1024, 390]) test(`${width}px完成两组20平台93列三期并下载脱敏证据`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 950 });
  const f = await fixtures(page), pane = await openPane(page);
  expect(f.calls.filter(call => call.path.startsWith(path))).toHaveLength(0);
  await pane.getByRole("button", { name: "开始联调" }).click();
  await expect(page.getByRole("button", { name: "退出维护", exact: true })).toBeDisabled();
  await expect(page.getByLabel("候选 Token", { exact: true }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "进入测试数据", exact: true })).toBeDisabled();
  await expect(pane.getByText("本轮读取与比较结束", { exact: false })).toBeVisible();
  await expect(pane.getByText("适用格 5540 · 字段一致 5540 · 差异 0 · 月活日比较不适用 40")).toBeVisible();
  await expect(pane.getByText("字段一致不等于数值验收通过", { exact: false })).toBeVisible();
  expect(f.calls.filter(call => call.path === path)).toHaveLength(2);
  expect(f.calls.filter(call => call.path.endsWith("/daily-reading"))).toHaveLength(20);
  expect(f.calls.filter(call => call.path.startsWith(path)).every(call => call.headers["x-ypbi-data-environment"] === "production")).toBe(true);
  expect(f.calls.filter(call => call.path === path).every(call => call.headers["x-csrf-token"] === csrf)).toBe(true);
  expect(f.calls.some(call => call.path === "/api/bi/v2/queries/jobs")).toBe(false); expect(f.maxSync()).toBeLessThanOrEqual(6);
  const downloadPromise = page.waitForEvent("download");
  await pane.getByRole("button", { name: "下载联调证据" }).click();
  const download = await downloadPromise, evidence = await readFile((await download.path())!, "utf8"), report = JSON.parse(evidence);
  expect(report.candidate).toHaveLength(20); expect(report.baseline).toHaveLength(20);
  expect(report.groups.map(group => group.reused)).toEqual([false, true]);
  expect(report.comparison).toMatchObject({ totalCells: 5540, matchedCells: 5540, notApplicableCells: 40, scopeErrors: [], differences: [] });
  expect(report.comparison.nonReadyCells).toBeGreaterThan(0);
  expect(evidence).not.toContain(csrf); expect(evidence).not.toContain("synthetic-primary");
  expect(report.candidate[0].data.series[1].points[0]).toMatchObject({ value: null, sourceStatus: "PROCESSING", inputs: [{ key: "n", value: 2 }] });
  await pane.getByLabel("业务日期").fill("2026-10-20");
  await expect(pane.getByText(`本轮业务日 ${date} · 正式数据`)).toBeVisible();
  await expect(page.getByRole("button", { name: "退出维护", exact: true })).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await pane.screenshot({ path: info.outputPath(`operating-validation-${width}.png`) });
});

test("停止取消本地等待，晚创建响应不继续同步", async ({ page }) => {
  const f = await fixtures(page, { pendingCreate: true }), pane = await openPane(page);
  await pane.getByRole("button", { name: "开始联调" }).click();
  await expect.poll(() => f.calls.filter(call => call.path === path).length).toBe(2);
  await pane.getByRole("button", { name: "停止等待" }).click();
  await expect(pane.getByText("已停止本地等待，后台任务状态未被改变", { exact: false })).toBeVisible();
  f.release(); await page.waitForTimeout(100);
  expect(f.calls.filter(call => call.path.endsWith("/daily-reading"))).toHaveLength(0);
  expect(f.calls.filter(call => call.path.startsWith(`${path}/`) && !call.path.endsWith("/capabilities"))).toHaveLength(0);
  await expect(pane.getByRole("button", { name: "开始联调" })).toBeEnabled();
});

test("离开维护页面取消本地等待，晚创建响应不继续同步", async ({ page }) => {
  const f = await fixtures(page, { pendingCreate: true }), pane = await openPane(page);
  await pane.getByRole("button", { name: "开始联调" }).click();
  await expect.poll(() => f.calls.filter(call => call.path === path).length).toBe(2);
  await page.getByRole("link", { name: "查看指标接入状态", exact: true }).click();
  await expect(pane).toHaveCount(0);
  f.release(); await page.waitForTimeout(100);
  expect(f.calls.filter(call => call.path.endsWith("/daily-reading"))).toHaveLength(0);
  expect(f.calls.filter(call => call.path.startsWith(`${path}/`) && !call.path.endsWith("/capabilities"))).toHaveLength(0);
});

test("维护会话过期仅回到维护登录，不退出普通BI且不回显raw错误", async ({ page }) => {
  const f = await fixtures(page, { expired: true }), pane = await openPane(page);
  await pane.getByRole("button", { name: "开始联调" }).click();
  await expect(page.getByLabel("维护密码")).toBeVisible();
  await expect(page.getByRole("heading", { name: "数据源维护", exact: true })).toBeVisible();
  await expect(page.getByText("raw-secret-must-not-escape")).toHaveCount(0);
  expect(f.calls.filter(call => call.path === path)).toHaveLength(0);
  expect(f.calls.filter(call => call.path.endsWith("/daily-reading"))).toHaveLength(0);
});

test("当前测试环境不能发起正式联调，不自动切换环境", async ({ page }) => {
  const f = await fixtures(page, { testMode: true }), pane = await openPane(page);
  await expect(pane.getByRole("button", { name: "开始联调" })).toBeDisabled();
  await expect(pane.getByText("当前不是已确认的正式数据环境", { exact: false })).toBeVisible();
  expect(f.calls.filter(call => call.path.startsWith(path))).toHaveLength(0);
  expect(await page.evaluate(subject => sessionStorage.getItem(`ypbi.data-environment.v1:${subject}`), subject)).toBe("test");
});

test("普通BI认证401仍按既有全局认证处理，不误归维护登录", async ({ page }) => {
  const f = await fixtures(page, { authenticationExpired: true }), pane = await openPane(page);
  await pane.getByRole("button", { name: "开始联调" }).click();
  await expect(page.getByRole("heading", { name: "登录 YPBI", exact: true })).toBeVisible();
  await expect(page.getByLabel("维护密码")).toHaveCount(0);
  await expect(page.getByText("raw-auth-secret-must-not-escape")).toHaveCount(0);
  expect(f.calls.filter(call => call.path === path)).toHaveLength(0);
});
