import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dailyDashboardMatchesQuery, dailyDashboardV2SuccessSchema, type DailyDashboardQuery, type DailyDashboardV2Success } from "./contracts/daily-dashboard";
import { OPERATING_METRIC_IDS } from "./contracts/operating-detail-projection";

test.use({ channel: "chrome", viewport: { width: 1280, height: 950 } });
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5198";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("经营详情生命周期回归只允许本地隔离地址");
const bun = process.env.YPBI_BUN ?? fileURLToPath(new URL("./data/local-runtime/node_modules/.bin/bun", import.meta.url));
const date = "2026-09-08";
const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-09-02", date] };
const generated = JSON.parse(execFileSync(bun, ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  const service = new DailyDashboardService({ get: async () => ({ code: 200, msg: { pageData: [], totalCount: 0, totalData: [] } }) }, () => new Date('2026-10-14T00:00:00Z'));
  const results = {};
  for (const pid of ['PH', 'TT']) for (const end of ['2026-09-08', '2026-09-09']) {
    const snapshotStart = end === '2026-09-08' ? '2026-09-01' : '2026-09-02';
    for (const projection of [undefined, 'operating_snapshot']) {
      const query = { boardId: '5.2', pid, dateRange: [projection ? snapshotStart : '2026-09-02', end], ...(projection ? { projection } : {}) };
      results[JSON.stringify(query)] = await service.execute(query);
    }
  }
  process.stdout.write(JSON.stringify({ catalog: dailyDashboardCatalog(true), results }));
`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { catalog: { success: true; data: { items: { id: string; metricIds: string[] }[] } }; results: Record<string, DailyDashboardV2Success> };
const metricIds = generated.catalog.data.items.find(board => board.id === "5.2")!.metricIds;
const platforms = [{ id: "HX-001", pid: "PH", name: "Pornhub", order: 1 }, { id: "HX-002", pid: "TT", name: "TikTok", order: 2 }];
const url = `${base}/dashboards/public?board=5.2&pid=PH&start=2026-09-02&end=${date}`;
const local = (page: Page) => page.locator(".core-review__detail:visible");
const row = (page: Page, name = "Pornhub") => local(page).locator(".core-review__comparison-table tbody tr").filter({ hasText: name });
const cell = (page: Page, name = "Pornhub") => row(page, name).locator('td[data-column-key="M087:overall"] .core-review__detail-trigger > b');
const dialog = (page: Page) => page.getByRole("dialog", { name: "活跃用户人均充值金额（ARPU）", exact: true });
const rawFailureMessage = "QA_RAW_FAILURE_MESSAGE_MUST_NOT_ENTER_OPERATING_DETAIL";

function resultFor(request: DailyDashboardQuery, readyNumerator?: number) {
  const result = structuredClone(generated.results[JSON.stringify(request)]);
  if (!result) throw new Error(`隔离验收未登记查询：${JSON.stringify(request)}`);
  const series = result.data.series.find(item => item.metric.id === "M087")!;
  const denominator = request.pid === "PH" ? request.dateRange[1] === date ? 6 : 16 : 26;
  series.points.forEach(point => Object.assign(point, readyNumerator === undefined
    ? { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
      inputs: series.metric.inputs.map((input, index) => ({ key: input.key, value: index === 0 ? null : denominator })) }
    : { state: "available", sourceStatus: "READY", value: readyNumerator / denominator,
      inputs: series.metric.inputs.map((input, index) => ({ key: input.key, value: index === 0 ? readyNumerator : denominator })) }));
  if (!request.projection) series.periodStatistics = { ...series.periodStatistics, state: "incomplete", values: [],
    reason: readyNumerator === undefined ? "隔离验收来源不完整" : "隔离样例仅提供逐日结果" };
  dailyDashboardV2SuccessSchema.parse(result);
  expect(dailyDashboardMatchesQuery(result, request, request.projection ? OPERATING_METRIC_IDS : metricIds)).toBe(true);
  return result;
}

async function fixtures(page: Page, readablePlatforms = platforms, readyNumerator?: number, failurePid = "PH", failure = {
  status: 504, code: "V2_UPSTREAM_TIMEOUT", requestId: "qa-operating-lifecycle-failed"
}) {
  let outcome: "hold" | "success" | "failure" = "hold";
  let releaseGate: () => void = () => {};
  let gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const control = {
    calls: [] as DailyDashboardQuery[],
    release(next: "success" | "failure" = "success") { outcome = next; releaseGate(); },
    hold() { outcome = "hold"; gate = new Promise<void>(resolve => { releaseGate = resolve; }); }
  };
  await page.route("**/*", async route => {
    const address = new URL(route.request().url());
    if (address.origin !== new URL(base).origin) return route.abort("blockedbyclient");
    const path = address.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/auth/session")) return route.fulfill({ status: 200, json: { success: true, data: {
      user: { subjectId: "00000000-0000-4000-8000-000000000001", username: "qa.operating.lifecycle", displayName: "经营详情隔离验收", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } } });
    if (path.endsWith("/data-environment")) return route.fulfill({ status: 200, json: { success: true, data: { mode: "production", testAvailable: false, expiresAt: null, userName: null } } });
    if (path.endsWith("/catalog/readable-dashboards")) return route.fulfill({ status: 200, json: generated.catalog });
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ status: 200, json: { success: true, data: { items: readablePlatforms } } });
    if (!path.endsWith("/queries/dashboards/daily-reading")) return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离验收未配置此读取", requestId: "qa-operating-lifecycle" } } });
    const request = route.request().postDataJSON() as DailyDashboardQuery;
    control.calls.push(request);
    if (request.pid === failurePid) {
      if (outcome === "hold") await gate;
      if (outcome === "failure") return route.fulfill({ status: failure.status, json: { success: false, error: { code: failure.code, message: rawFailureMessage, requestId: failure.requestId } } });
    }
    return route.fulfill({ status: 200, json: resultFor(request, readyNumerator) });
  });
  return control;
}

async function openDetail(page: Page) {
  const trigger = row(page).locator('td[data-column-key="M087:overall"] button.core-review__detail-trigger');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).evaluate(element => { element.setAttribute("data-lifecycle-probe", "opened-once"); });
  return trigger;
}

async function expectPartialInput(page: Page, denominator = 6) {
  const current = dialog(page).locator("tbody tr").first();
  await expect(current.locator("td").nth(1)).toContainText(`${denominator} 人`);
  await expect(current.locator("td").nth(1)).toContainText("— 元");
  await expect(current.locator("td").nth(2)).toHaveText("来源不完整");
  await expect(dialog(page).locator(".metric-summary")).toContainText("来源不完整");
  await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
}

for (const width of [1280, 1024, 390]) test(`经营查询进度与指标状态分离并保留93列（${width}）`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 950 });
  const control = await fixtures(page);
  try {
    await page.goto(url);
    const notice = local(page).locator(".core-review__operating-progress");
    await expect(notice).toContainText("平台查询已结束 1/2");
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`operating-query-progress-${width}.png`) });
    const bounds = await notice.boundingBox();
    expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    control.release();
    await expect(cell(page)).toHaveText("来源不完整");
    await expect(notice).toHaveCount(0);
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  } finally { control.release(); }
});

test("刷新失败收起查询计数，但保留上次结果原读取时间", async ({ page }, info) => {
  const control = await fixtures(page, platforms.slice(0, 1), 24);
  control.release();
  try {
    await page.goto(url); await expect(cell(page)).toHaveText("4");
    const notice = local(page).locator(".core-review__operating-progress");
    await expect(notice).toHaveCount(0);
    control.hold();
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(notice).toContainText("平台查询已结束 0/1");
    await expect(notice).toContainText("1 个平台保留上次结果");
    await expect(notice.locator("time")).toHaveAttribute("datetime", "2026-10-14T00:00:00.000Z");
    control.release("failure");
    await expect(notice).not.toContainText("平台查询已结束");
    await expect(notice).toContainText("读取时间");
    await expect(notice.locator("time")).toHaveAttribute("datetime", "2026-10-14T00:00:00.000Z");
    await expect(cell(page)).toHaveText("4");
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath("operating-query-retained-time.png") });
  } finally { control.release(); }
});

for (const width of [1280, 1024, 390]) test(`PH读取中打开M087详情，响应后不关闭即更新来源状态和分母（${width}）`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 950 });
  // One readable PID makes the first real response supply the column metadata too.
  const control = await fixtures(page, platforms.slice(0, 1));
  try {
    await page.goto(url);
    await expect(cell(page)).toHaveText("读取中");
    expect(control.calls.some(request => request.pid === "PH" && !request.projection)).toBe(true);
    expect(control.calls.some(request => request.pid === "PH" && request.projection === "operating_snapshot")).toBe(true);
    const trigger = await openDetail(page);
    await expect(dialog(page).locator("tbody tr").first()).toContainText("读取中");
    control.release();
    await expect(cell(page)).toHaveText("来源不完整");
    await page.screenshot({ path: info.outputPath(`operating-detail-open-update-${width}.png`) });
    await expectPartialInput(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(dialog(page).getByRole("button", { name: /关闭/ })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally { control.release(); }
});

for (const numerator of [24, 0]) test(`读取中打开M087后READY${numerator === 0 ? "真实0" : "正值"}到达，同一详情更新正式值、输入和元数据`, async ({ page }, info) => {
  const control = await fixtures(page, platforms.slice(0, 1), numerator);
  const metric = resultFor(query, numerator).data.series.find(series => series.metric.id === "M087")!.metric;
  try {
    await page.goto(url); await expect(cell(page)).toHaveText("读取中");
    const trigger = await openDetail(page);
    await expect(dialog(page).locator("tbody tr").first()).toContainText("读取中");
    control.release();
    await expect(cell(page)).toHaveText(String(numerator / 6));
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
    await expect(dialog(page).locator(".metric-summary__number strong")).toHaveText(String(numerator / 6));
    const current = dialog(page).locator("tbody tr").first();
    await expect(current.locator("td").nth(1)).toContainText(`${numerator} 元`);
    await expect(current.locator("td").nth(1)).toContainText("6 人");
    await expect(current.locator("td").nth(1)).not.toContainText("—");
    await expect(current.locator("td").nth(2)).toHaveText("已返回");
    await expect(dialog(page)).toContainText(`单位：${metric.unit}`);
    await expect(dialog(page)).toContainText(metric.formula);
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
    await expect(local(page).locator('th[data-column-key="M087:overall"]')).toContainText(metric.unit);
    await page.screenshot({ path: info.outputPath(`operating-detail-ready-${numerator}.png`) });
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  } finally { control.release(); }
});

test("已开详情随读取失败、同范围真实刷新和重试成功更新，不恢复假金额", async ({ page }, info) => {
  const control = await fixtures(page);
  try {
    await page.goto(url); await expect(cell(page)).toHaveText("读取中"); await openDetail(page);
    control.release("failure");
    await expect(cell(page)).toHaveText("读取失败");
    await expect(dialog(page).locator("tbody tr").first().locator("td").nth(2)).toContainText("读取失败");
    await expect(dialog(page)).toContainText("错误代码：V2_UPSTREAM_TIMEOUT");
    await expect(dialog(page)).toContainText("请求编号：qa-operating-lifecycle-failed");
    await expect(dialog(page).locator(".metric-summary")).toContainText("读取失败");
    const before = control.calls.filter(request => request.pid === "PH" && request.projection === "operating_snapshot").length;
    control.hold();
    // Native modal blocks background pointer input. Invoke the existing handler only to test
    // a same-scope refresh lifecycle; this does not assert a new in-dialog product action.
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(() => control.calls.filter(request => request.pid === "PH" && request.projection === "operating_snapshot").length).toBe(before + 1);
    await expect(dialog(page).locator("tbody tr").first().locator("td").nth(2)).toHaveText("读取中");
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
    control.release(); await expect(cell(page)).toHaveText("来源不完整"); await expectPartialInput(page);
    await page.screenshot({ path: info.outputPath("operating-detail-failure-retry.png") });
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
  } finally { control.release(); }
});

for (const width of [1280, 1024, 390]) test(`非主平台93列失败详情保留真实身份错误编号，恢复后清除（${width}）`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 950 });
  const control = await fixtures(page, platforms, 24, "TT", { status: 503, code: "IDENTITY_PROVIDER_UNAVAILABLE", requestId: "qa-tt-identity-503" });
  control.release("failure");
  try {
    await page.goto(url);
    await expect(cell(page)).toHaveText("4");
    await expect(cell(page, "TikTok")).toHaveText("读取失败");
    await expect(row(page, "TikTok").locator('td[data-column-key] .core-review__detail-trigger > b')).toHaveCount(93);
    const trigger = row(page, "TikTok").locator('td[data-column-key="M087:overall"] button.core-review__detail-trigger');
    await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).evaluate(element => element.setAttribute("data-lifecycle-probe", "opened-once"));
    for (const status of await dialog(page).locator("tbody tr td:nth-child(3)").all()) {
      await expect(status).toContainText("读取失败");
      await expect(status).toContainText("错误代码：IDENTITY_PROVIDER_UNAVAILABLE");
      await expect(status).toContainText("请求编号：qa-tt-identity-503");
    }
    await expect(dialog(page).locator("tbody tr")).toHaveCount(3);
    await expect(dialog(page)).not.toContainText(rawFailureMessage);
    const evidenceTable = dialog(page).locator(".core-review__snapshot-evidence");
    await expect(evidenceTable).toBeVisible();
    expect(await evidenceTable.evaluate(element => element.scrollWidth)).toBeGreaterThan(await evidenceTable.evaluate(element => element.clientWidth));
    await expect(dialog(page).locator("thead th").nth(2)).toHaveText("状态");
    await page.screenshot({ path: info.outputPath(`operating-nonprimary-error-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    control.hold();
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(cell(page, "TikTok")).toHaveText("读取中");
    await expect(dialog(page)).not.toContainText("qa-tt-identity-503");
    control.release();
    await expect(cell(page, "TikTok")).toHaveText("0.92");
    await expect(dialog(page).locator("tbody tr td:nth-child(3)")).toHaveText(["已返回", "已返回", "已返回"]);
    for (const inputs of await dialog(page).locator("tbody tr td:nth-child(2)").all()) {
      await expect(inputs).toContainText("24 元");
      await expect(inputs).toContainText("26 人");
    }
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
    await expect(dialog(page)).not.toContainText("错误代码：");
    await expect(dialog(page)).not.toContainText("请求编号：");
    await expect(dialog(page).locator(".core-review__snapshot-evidence")).toHaveCount(0);
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  } finally { control.release(); }
});

test("详情刷新失败保留原值、真实状态和请求编号，成功后清除错误诊断", async ({ page }, info) => {
  const control = await fixtures(page, platforms.slice(0, 1), 24);
  control.release();
  try {
    await page.goto(url); await expect(cell(page)).toHaveText("4"); await openDetail(page);
    const status = dialog(page).locator("tbody tr").first().locator("td").nth(2);
    await expect(status).toHaveText("已返回");
    control.release("failure");
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(status).toContainText("请求编号：qa-operating-lifecycle-failed");
    await expect(status).toContainText("错误代码：V2_UPSTREAM_TIMEOUT");
    await expect(status).toContainText("已返回 · 上次查询结果");
    await expect(dialog(page)).not.toContainText(rawFailureMessage);
    await expect(cell(page)).toHaveText("4");
    await expect(dialog(page).locator(".metric-summary__number strong")).toHaveText("4");
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
    await page.screenshot({ path: info.outputPath("operating-refresh-error-diagnostics.png") });
    control.release();
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(status).toHaveText("已返回");
    await expect(dialog(page)).not.toContainText("请求编号：");
    await expect(cell(page)).toHaveText("4");
  } finally { control.release(); }
});

test("刷新期间保留READY值，已开详情标记上次查询结果，完成后恢复本次标记", async ({ page }, info) => {
  const control = await fixtures(page, platforms.slice(0, 1), 24);
  control.release();
  try {
    await page.goto(url);
    await expect(cell(page)).toHaveText("4");
    await openDetail(page);
    const status = dialog(page).locator("tbody tr").first().locator("td").nth(2);
    await expect(status).toHaveText("已返回");
    const before = control.calls.filter(request => request.projection === "operating_snapshot").length;
    control.hold();
    await page.getByRole("button", { name: "刷新看板", exact: true, includeHidden: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(() => control.calls.filter(request => request.projection === "operating_snapshot").length).toBe(before + 1);
    await expect(cell(page)).toHaveText("4");
    await expect(status).toHaveText("已返回 · 上次查询结果");
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
    await page.screenshot({ path: info.outputPath("operating-refresh-retained-result.png") });
    control.release();
    await expect(status).toHaveText("已返回");
    await expect(cell(page)).toHaveText("4");
    await expect(dialog(page)).toHaveAttribute("data-lifecycle-probe", "opened-once");
  } finally { control.release(); }
});

for (const change of ["date", "pid"] as const) test(`历史${change === "date" ? "日期" : "PID"}范围变化与返回关闭旧详情，不混用旧输入`, async ({ page }) => {
  const control = await fixtures(page); control.release();
  await page.goto(url); await expect(cell(page)).toHaveText("来源不完整"); await openDetail(page); await expectPartialInput(page);
  await page.evaluate(change => {
    const next = new URL(window.location.href);
    next.searchParams.set(change === "date" ? "end" : "pid", change === "date" ? "2026-09-09" : "TT");
    window.history.pushState(window.history.state, "", next);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, change);
  await expect(dialog(page)).toHaveCount(0);
  await expect(cell(page)).toHaveText("来源不完整");
  const name = change === "date" ? "Pornhub" : "TikTok";
  const trigger = row(page, name).locator('td[data-column-key="M087:overall"] button.core-review__detail-trigger');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await dialog(page).evaluate(element => element.setAttribute("data-lifecycle-probe", "opened-once"));
  await expectPartialInput(page, change === "date" ? 16 : 26);
  await expect(dialog(page)).toContainText(change === "date" ? "2026-09-09" : "TikTok");
  await page.goBack(); await expect(dialog(page)).toHaveCount(0);
  await expect(cell(page)).toHaveText("来源不完整"); await openDetail(page); await expectPartialInput(page);
});

type HarnessChange = "date" | "pid" | "platforms" | "metricIds";

async function mountScopeHarness(page: Page) {
  const payload = { query, result: resultFor(query), metricIds, platforms };
  await page.evaluate(async payload => {
    // Existing browser-only Provider harness pattern; no new production entry or API.
    const reactPath = "/node_modules/.vite/deps/react.js", domPath = "/node_modules/.vite/deps/react-dom_client.js";
    const corePath = "/src/v2/design/CoreOverviewDesignFixture.tsx", contextPath = "/src/v2/features/dashboards/LiveDashboardContext.tsx";
    const { default: React } = await import(reactPath);
    const { default: { createRoot } } = await import(domPath);
    const { default: Core } = await import(corePath);
    const { LiveDashboardContext } = await import(contextPath);
    document.querySelector<HTMLElement>("#root")!.style.display = "none";
    const host = document.createElement("div"); host.id = "operating-detail-lifecycle-qa"; host.className = "ypbi-v2"; document.body.append(host);
    const root = createRoot(host);
    const initial = { query: payload.query, metricIds: payload.metricIds, platforms: payload.platforms, platformName: "Pornhub",
      state: { status: "success", data: payload.result, refreshing: false, refreshError: null },
      controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply: () => {}, export: () => {} },
      retry: () => {}, canExport: false };
    let update: (change: HarnessChange) => void;
    function Harness() {
      const [reading, setReading] = React.useState(initial);
      update = (change: HarnessChange) => setReading((current: typeof initial) => change === "date"
        ? { ...current, query: { ...current.query, dateRange: ["2026-09-02", "2026-09-09"] } }
        : change === "pid" ? { ...current, query: { ...current.query, pid: "TT" }, platformName: "TikTok" }
          : change === "platforms" ? { ...current, platforms: current.platforms.filter(item => item.pid !== "PH") }
            : { ...current, metricIds: current.metricIds.filter(id => id !== "M087") });
      return React.createElement(LiveDashboardContext.Provider, { value: reading }, React.createElement(Core));
    }
    (window as unknown as { __changeOperatingDetailScope: (change: HarnessChange) => void }).__changeOperatingDetailScope = change => update(change);
    root.render(React.createElement(Harness));
  }, payload);
  await expect(page.locator("#operating-detail-lifecycle-qa .core-review__detail")).toBeVisible();
}

for (const change of ["date", "pid", "platforms", "metricIds"] as const) test(`同一Core实例${{ date: "日期", pid: "PID", platforms: "可读平台", metricIds: "可读指标" }[change]}范围变化立即关闭旧详情，93列保留`, async ({ page }) => {
  const control = await fixtures(page); control.release();
  await page.goto(url); await expect(cell(page)).toHaveText("来源不完整"); await mountScopeHarness(page);
  await expect(cell(page)).toHaveText("来源不完整"); await openDetail(page); await expectPartialInput(page);
  await page.evaluate(change => (window as unknown as { __changeOperatingDetailScope: (change: HarnessChange) => void }).__changeOperatingDetailScope(change), change);
  await expect(dialog(page)).toHaveCount(0);
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  if (change === "platforms") await expect(row(page)).toHaveCount(0);
  else if (change === "metricIds") await expect(cell(page)).toHaveText("待接口支持");
  else {
    await expect(cell(page)).toHaveText("来源不完整"); await openDetail(page);
    await expectPartialInput(page, change === "date" ? 16 : 6);
    await expect(dialog(page)).toContainText(change === "date" ? "2026-09-09" : "Pornhub");
  }
});
