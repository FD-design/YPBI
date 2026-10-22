import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dailyDashboardMatchesQuery, dailyDashboardV2SuccessSchema, type DailyDashboardQuery, type DailyDashboardV2Success } from "./contracts/daily-dashboard";
import { OPERATING_LIVE_IDS, OPERATING_METRIC_IDS, OPERATING_SNAPSHOT_STATISTICS_REASON, operatingSnapshotDates } from "./contracts/operating-detail-projection";
import { formatDetailValue, type DetailValueKind } from "./src/v2/design/operating-detail-presentation";

test.use({ channel: "chrome", viewport: { width: 1440, height: 1000 } });
test.setTimeout(180_000);
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("经营快照回归只允许本地隔离地址");
const bun = process.env.YPBI_BUN ?? fileURLToPath(new URL("./data/local-runtime/node_modules/.bin/bun", import.meta.url));
const date = "2026-09-08", snapshotRange: [string, string] = ["2026-09-01", date];
const generated = JSON.parse(execFileSync(bun, ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  import { DETAIL_COLUMNS, detailColumnKey } from './src/v2/design/operating-detail-snapshot';
  const service = new DailyDashboardService({get:async()=>({code:200,msg:{pageData:[],totalData:[],totalCount:0},data:[]})},()=>new Date('2026-10-14T00:00:00Z'));
  const results = {};
  for (const dateRange of [['2026-09-01','2026-09-08'],['2026-09-02','2026-09-08'],['2026-08-26','2026-09-01'],['2026-08-24','2026-08-31']]) results[JSON.stringify(dateRange)] = await service.execute({boardId:'5.2',pid:'PH',dateRange});
  process.stdout.write(JSON.stringify({catalog:dailyDashboardCatalog(true),results,columns:DETAIL_COLUMNS.map(column=>({key:detailColumnKey(column),name:column.metric.name,kind:column.kind}))}));
`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })) as {
  catalog: { success: true; data: { items: { id: string; metricIds: string[] }[] } };
  results: Record<string, DailyDashboardV2Success>;
  columns: { key: string; name: string; kind: DetailValueKind }[];
};
const boardIds = generated.catalog.data.items.find(board => board.id === "5.2")!.metricIds;
const platforms = Array.from({ length: 20 }, (_, index) => ({
  id: `qa-operating-${index + 1}`, pid: index === 0 ? "PH" : index === 1 ? "TT" : `QA${String(index + 1).padStart(2, "0")}`,
  name: index === 0 ? "Pornhub" : index === 1 ? "TikTok" : `隔离平台${String(index + 1).padStart(2, "0")}`, order: index + 1
}));

// All fixtures are derived from the real service's metadata in memory. Routes
// reject external origins and never contact a business source or saved session.
function response(query: DailyDashboardQuery): DailyDashboardV2Success {
  const result = structuredClone(generated.results[JSON.stringify(query.dateRange)]);
  expect(result, "隔离验收未登记此日期范围").toBeDefined();
  const pidIndex = platforms.findIndex(platform => platform.pid === query.pid);
  expect(pidIndex).toBeGreaterThanOrEqual(0);
  result.data.query = query;
  result.data.queryId = `qa-operating-${query.pid}-${query.projection ?? "full"}`;
  result.data.series.forEach((series, index) => series.points.forEach(point => {
    const position = (Date.parse(point.date) - Date.parse(snapshotRange[0])) / 86_400_000;
    const value = series.metric.unit === "%" ? (20 + index % 10 + position) / 100 : (pidIndex + 1) * 1000 + index * 10 + position;
    Object.assign(point, { state: "available", sourceStatus: "READY", value,
      inputs: series.metric.inputs.map((input, inputIndex) => ({ key: input.key, value: inputIndex === 0 ? value : 1 })) });
  }));
  if (query.projection === "operating_snapshot") {
    const dates = operatingSnapshotDates(query.dateRange);
    result.data.series = OPERATING_METRIC_IDS.map(id => {
      const series = result.data.series.find(series => series.metric.id === id)!;
      return { ...series, points: series.points.filter(point => dates.includes(point.date)),
        periodStatistics: { aggregationVersion: "daily-statistics/v1", dateRange: query.dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } };
    });
  }
  dailyDashboardV2SuccessSchema.parse(result);
  expect(dailyDashboardMatchesQuery(result, query, query.projection ? OPERATING_METRIC_IDS : boardIds)).toBe(true);
  return result;
}

async function fixtures(page: Page, invalidPrimary = false) {
  const calls: DailyDashboardQuery[] = [];
  let corrupt = invalidPrimary;
  let subjectId = "00000000-0000-4000-8000-000000000001";
  let gate: Promise<void> | null = null, releaseGate = () => {};
  await page.route("**/*", async route => {
    const address = new URL(route.request().url()), path = address.pathname;
    if (address.origin !== new URL(base).origin) return route.abort("blockedbyclient");
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/auth/session")) return route.fulfill({ json: { success: true, data: {
      user: { subjectId, username: "qa.operating.snapshot", displayName: "经营快照隔离验收", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } } });
    if (path.endsWith("/data-environment")) return route.fulfill({ json: { success: true, data: route.request().headers()["x-ypbi-data-environment"] === "test"
      ? { mode: "test", testAvailable: true, expiresAt: "2099-01-01T00:00:00Z", userName: "qa.snapshot" }
      : { mode: "production", testAvailable: false, expiresAt: null, userName: null } } });
    if (path.endsWith("/catalog/readable-dashboards")) return route.fulfill({ json: generated.catalog });
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ json: { success: true, data: { items: platforms } } });
    if (!path.endsWith("/queries/dashboards/daily-reading")) return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离验收未配置此读取", requestId: "qa-operating-snapshot" } } });
    const query = route.request().postDataJSON() as DailyDashboardQuery;
    calls.push(query);
    if (gate) await gate;
    expect(query.boardId).toBe("5.2");
    const result = response(query);
    if (corrupt && query.pid === "PH" && query.projection === "operating_snapshot") result.data.series[0].points[0].date = "2026-09-02";
    return route.fulfill({ json: result });
  });
  return { calls, restore() { corrupt = false; },
    hold() { gate = new Promise<void>(resolve => { releaseGate = resolve; }); },
    release() { releaseGate(); gate = null; },
    switchAccount() { subjectId = "00000000-0000-4000-8000-000000000002"; }
  };
}

type Cell = string | number | null;
function readSheet(buffer: Buffer, name: string): Cell[][] {
  const entries = new Map<string, string>();
  for (let offset = 0; offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const length = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), buffer.subarray(start, start + length).toString("utf8"));
    offset = start + length;
  }
  const id = [...entries.get("xl/workbook.xml")!.matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].find(match => match[1] === name)?.[2];
  expect(id, `缺少工作表 ${name}`).toBeTruthy();
  return [...entries.get(`xl/worksheets/sheet${id}.xml`)!.matchAll(/<row r="\d+">(.*?)<\/row>/gs)].map(match => [...match[1].matchAll(/<c r="[A-Z]+\d+"(?: t="[^"]+")?(?:\/>|>(.*?)<\/c>)/gs)].map(cell => {
    const numeric = cell[1]?.match(/<v>(.*?)<\/v>/s);
    if (numeric) return Number(numeric[1]);
    const text = cell[1]?.match(/<t(?: [^>]*)?>(.*?)<\/t>/s)?.[1];
    return text === undefined ? null : text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }));
}
const local = (page: Page) => page.locator(".core-review__detail");
const rows = (page: Page) => local(page).locator(".core-review__comparison-table tbody tr");
const platformRow = (page: Page, pid: string) => rows(page).filter({ has: page.locator("td > small", { hasText: new RegExp(`^PID ${pid}$`) }) });
const url = `${base}/dashboards/public?board=5.2&pid=PH&start=2026-09-02&end=${date}`;

test("经营20平台93列及三个基准详情与真实XLSX同源，整板维持121指标完整查询", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const { calls } = await fixtures(page);
  await page.goto(url);
  await expect(rows(page)).toHaveCount(20);
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  await expect.poll(() => calls.filter(query => query.projection).length).toBe(20);
  await expect(rows(page).last().locator('td[data-column-key="M016:overall"] b')).not.toHaveText("读取中");
  expect(boardIds).toHaveLength(121);
  expect(calls.filter(query => !query.projection)).toEqual([{ boardId: "5.2", pid: "PH", dateRange: ["2026-09-02", date] }]);
  expect(calls.filter(query => query.projection).map(query => query.pid).sort()).toEqual(platforms.map(platform => platform.pid).sort());
  expect(calls.filter(query => query.projection).every(query => query.projection === "operating_snapshot" && query.dateRange.join() === snapshotRange.join())).toBe(true);
  const sources = platforms.map(platform => response({ boardId: "5.2", pid: platform.pid, dateRange: snapshotRange, projection: "operating_snapshot" }));
  const actual = new Map(await rows(page).evaluateAll(items => items.map(row => [row.querySelector("td:nth-child(2) > small")!.textContent!.replace(/^PID /, ""), Array.from(row.querySelectorAll<HTMLButtonElement>("td[data-column-key] button.core-review__detail-trigger"), button => ({ key: button.closest("td")!.getAttribute("data-column-key"), value: button.querySelector("b")!.textContent, label: button.getAttribute("aria-label") }))] as const)));
  for (let p = 0; p < platforms.length; p++) for (const [index, column] of generated.columns.entries()) {
    const series = sources[p].data.series.find(series => series.metric.id === OPERATING_LIVE_IDS[column.key])!;
    const current = series.points.find(point => point.date === date)!;
    const cell = actual.get(platforms[p].pid)![index];
    expect(cell.key).toBe(column.key);
    expect(cell.value, `${platforms[p].pid} ${column.key}`).toBe(formatDetailValue(current.value, column.kind, false, series.metric.unit));
    if (series.metric.id !== "M018") for (const day of operatingSnapshotDates(snapshotRange)) expect(cell.label).toContain(day === date ? "当前" : day.replaceAll("-", "."));
  }
  await local(page).getByRole("button", { name: "导出经营明细", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "导出经营明细", exact: true });
  const completed = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载 XLSX", exact: true }).click();
  const file = await completed;
  expect(file.suggestedFilename()).toBe("经营明细-待验数.xlsx");
  const sheet = readSheet(readFileSync((await file.path())!), "01_经营明细");
  expect(sheet).toHaveLength(21);
  for (let p = 0; p < platforms.length; p++) for (const [index, column] of generated.columns.entries()) {
    const series = sources[p].data.series.find(series => series.metric.id === OPERATING_LIVE_IDS[column.key])!;
    const exported = sheet.find(row => row[2] === platforms[p].pid)!;
    expect(exported).toBeDefined();
    for (const [period, day] of [date, "2026-09-07", "2026-09-01"].entries()) {
      const cell = 3 + index * 9 + period * 3;
      if (series.metric.id === "M018" && period > 0) {
        expect(exported[cell]).toBeNull(); expect(exported[cell + 1]).toContain("不适用日比较");
      } else {
        expect(exported[cell]).toBe(series.points.find(point => point.date === day)!.value! * (column.kind === "ratio" ? 100 : 1));
        expect(exported[cell + 1]).toContain("待验数"); expect(exported[cell + 2]).toBe(sources[p].data.fetchedAt);
      }
    }
  }
  // Each visible column opens the same current / yesterday / prior-week evidence.
  for (const column of generated.columns) {
    const trigger = platformRow(page, "PH").locator(`td[data-column-key="${column.key}"] button.core-review__detail-trigger`);
    await trigger.scrollIntoViewIfNeeded(); await trigger.click();
    const detail = page.getByRole("dialog", { name: column.name, exact: true });
    const source = sources[0].data.series.find(series => series.metric.id === OPERATING_LIVE_IDS[column.key])!;
    await expect(detail.locator("tbody tr")).toHaveCount(source.metric.id === "M018" ? 1 : 3);
    if (source.metric.id === "M018") await expect(detail).toContainText("不适用日比较");
    else {
      const evidenceRows = await detail.locator("tbody tr").evaluateAll(items => items.map(row => Array.from(row.querySelectorAll("td"), cell => cell.textContent)));
      for (const day of operatingSnapshotDates(snapshotRange)) {
        const evidence = evidenceRows.find(row => row[0] === day)!;
        expect(evidence).toBeDefined();
        expect(evidence[1]).toContain(String(source.points.find(point => point.date === day)!.inputs[0].value));
        expect(evidence[3]).toBe(sources[0].data.fetchedAt);
      }
    }
    await page.keyboard.press("Escape"); await expect(detail).toHaveCount(0);
  }
  await local(page).locator(".core-review__comparison-scroll").evaluate(element => element.scrollLeft = 0);
  await page.screenshot({ path: info.outputPath("operating-20-by-93-snapshot.png") });
  expect(errors).toEqual([]);
});

test("单PID快照日期不匹配被拒绝，其他平台保持；整页刷新按原路径恢复", async ({ page }) => {
  const fixture = await fixtures(page, true);
  await page.goto(url);
  const current = (index: number) => platformRow(page, platforms[index].pid).locator('td[data-column-key="M016:overall"] b');
  await expect(current(0)).toHaveText("读取失败");
  await expect(current(1)).not.toHaveText("读取中");
  await expect(current(1)).not.toHaveText("读取失败");
  await expect(rows(page)).toHaveCount(20);
  await expect.poll(() => fixture.calls.filter(query => query.projection).length).toBe(20);
  fixture.restore();
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect(current(0)).toHaveText(formatDetailValue(response({ boardId: "5.2", pid: "PH", dateRange: snapshotRange, projection: "operating_snapshot" }).data.series.find(series => series.metric.id === "M016")!.points[2].value, "count", false));
  await expect.poll(() => fixture.calls.filter(query => query.projection).length).toBe(40);
});

test("同末日调整主平台/开始日/对比及展示重置复用20份93列快照，显式刷新完整重读", async ({ page }, info) => {
  const fixture = await fixtures(page), header = page.locator(".dashboard-header");
  const snapshots = () => fixture.calls.filter(query => query.projection).length;
  const primary = () => fixture.calls.filter(query => !query.projection);
  const comparison = async (from: string, to: string) => {
    await header.getByRole("button", { name: `对比周期：${from}`, exact: true }).click();
    await page.getByRole("option", { name: to, exact: true }).click();
    await header.getByRole("button", { name: "应用", exact: true }).click();
  };
  await page.goto(url);
  await expect.poll(snapshots, { timeout: 20_000 }).toBe(20);
  await expect(rows(page).last().locator('td[data-column-key="M016:overall"] b')).not.toHaveText("读取中");
  const initial = await rows(page).evaluateAll(items => items.map(row => row.textContent));
  await comparison("不对比", "上一等长周期");
  await expect.poll(() => primary().length).toBe(2);
  await comparison("上一等长周期", "不对比");
  await expect(header.getByRole("button", { name: "对比周期：不对比", exact: true })).toBeVisible();
  expect(primary()).toHaveLength(2); expect(snapshots()).toBe(20);
  await header.getByRole("button", { name: "选择平台：Pornhub", exact: true }).click();
  await page.getByRole("option", { name: "TikTok", exact: true }).click();
  await header.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => primary().length).toBe(3);
  expect(primary().at(-1)).toEqual({ boardId: "5.2", pid: "TT", dateRange: ["2026-09-02", date] });
  await header.getByRole("button", { name: /^日期范围：/ }).click();
  const picker = page.getByRole("dialog", { name: "选择日期范围" });
  await picker.getByLabel("开始日期", { exact: true }).fill("2026-09-01");
  await picker.getByRole("button", { name: "确认日期", exact: true }).click();
  await header.getByRole("button", { name: "应用", exact: true }).click();
  await expect.poll(() => primary().length).toBe(4);
  expect(primary().at(-1)).toEqual({ boardId: "5.2", pid: "TT", dateRange: snapshotRange });
  expect(snapshots()).toBe(20);
  expect(await rows(page).evaluateAll(items => items.map(row => row.textContent))).toEqual(initial);
  await local(page).getByRole("button", { name: "经营明细平台：全部平台", exact: true }).click();
  await page.getByRole("option", { name: /TikTok/ }).click();
  await expect(rows(page)).toHaveCount(1);
  const trigger = platformRow(page, "TT").locator('td[data-column-key="M016:overall"] button.core-review__detail-trigger');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(page.getByRole("dialog", { name: "日活跃用户数", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const next = new URL(window.location.href); next.searchParams.set("compare", "previous");
    window.history.pushState(window.history.state, "", next); window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("dialog", { name: "日活跃用户数", exact: true })).toHaveCount(0);
  await expect(local(page).getByRole("button", { name: "经营明细平台：全部平台", exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(20);
  await expect.poll(() => primary().length).toBe(5);
  expect(snapshots()).toBe(20);
  await page.getByRole("button", { name: "刷新看板", exact: true }).click();
  await expect.poll(snapshots, { timeout: 20_000 }).toBe(40);
  await expect.poll(() => primary().length).toBe(7);
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  await expect(rows(page).last().locator('td[data-column-key="M016:overall"] b')).not.toHaveText("读取中");
  await page.screenshot({ path: info.outputPath("stable-operating-query-scope.png") });
});

for (const scope of ["account", "environment"] as const) test(`${scope}切换卸载稳定数据容器，旧93列结果和详情立即隐藏`, async ({ page }) => {
  const fixture = await fixtures(page);
  await page.goto(url);
  await expect.poll(() => fixture.calls.filter(query => query.projection).length, { timeout: 20_000 }).toBe(20);
  const current = () => platformRow(page, "PH").locator('td[data-column-key="M016:overall"] b');
  await expect(current()).not.toHaveText("读取中");
  const trigger = platformRow(page, "PH").locator('td[data-column-key="M016:overall"] button.core-review__detail-trigger');
  await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  await expect(page.getByRole("dialog", { name: "日活跃用户数", exact: true })).toBeVisible();
  fixture.hold();
  try {
    if (scope === "account") {
      fixture.switchAccount();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    } else {
      await page.evaluate(async () => {
        const modulePath = "/src/v2/api/dataEnvironmentPreference.ts";
        const preference = await import(modulePath);
        preference.setDataEnvironmentPreference("test");
        window.dispatchEvent(new Event("focus"));
      });
    }
    await expect.poll(() => fixture.calls.filter(query => query.projection).length, { timeout: 20_000 }).toBeGreaterThan(20);
    await expect(page.getByRole("dialog", { name: "日活跃用户数", exact: true })).toHaveCount(0);
    await expect(current()).toHaveText("读取中");
    await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
    fixture.release();
    await expect.poll(() => fixture.calls.filter(query => query.projection).length, { timeout: 20_000 }).toBe(40);
    await expect(current()).not.toHaveText("读取中");
    await expect(rows(page)).toHaveCount(20);
  } finally { fixture.release(); }
});
