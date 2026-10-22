import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dailyDashboardMatchesQuery, dailyDashboardV2SuccessSchema, type DailyDashboardQuery, type DailyDashboardV2Success } from "./contracts/daily-dashboard";
import { OPERATING_LIVE_IDS, OPERATING_METRIC_IDS, operatingSnapshotDates } from "./contracts/operating-detail-projection";
import { operatingQueryJobCreatedSchema, operatingQueryJobRequestSchema, operatingQueryJobResultSchema, operatingQueryJobStatusSchema, type OperatingQueryJobProgress, type OperatingQueryJobRequest } from "./contracts/operating-query-jobs";
import { formatDetailValue, type DetailValueKind } from "./src/v2/design/operating-detail-presentation";

test.use({ channel: "chrome", viewport: { width: 1280, height: 950 }, serviceWorkers: "block" });
test.setTimeout(120_000);
const base = process.env.YPBI_BASE_URL ?? "http://127.0.0.1:5197";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("经营异步回归只允许本地隔离地址");
const bun = process.env.YPBI_BUN ?? fileURLToPath(new URL("./data/local-runtime/node_modules/.bin/bun", import.meta.url));
const subjectId = "00000000-0000-4000-8000-000000000001";
const date = "2026-09-08", fetchedAt = "2026-10-21T02:00:00.000Z";
const snapshotRange: [string, string] = ["2026-09-01", date];
const platforms = [{ id: "qa-async-ph", pid: "PH", name: "Pornhub", order: 1 }, { id: "qa-async-tt", pid: "TT", name: "TikTok", order: 2 }];
const groups = [["PH"], ["TT"]];
const handles = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

// The real service supplies metadata and query shapes. All values below are
// isolated in-memory test inputs; no business source or saved credentials run.
const generated = JSON.parse(execFileSync(bun, ["--no-env-file", "-e", `
  import { DailyDashboardService, dailyDashboardCatalog } from './server/v2/daily-dashboard.service';
  import { DETAIL_COLUMNS, detailColumnKey } from './src/v2/design/operating-detail-snapshot';
  const service = new DailyDashboardService({get:async()=>({code:200,msg:{pageData:[],totalData:[],totalCount:0},data:[]})},()=>new Date('2026-10-21T02:00:00Z'));
  const results = {};
  for (const pid of ['PH','TT']) for (const projection of [undefined,'operating_snapshot']) {
    const query = {boardId:'5.2',pid,dateRange:[projection?'2026-09-01':'2026-09-02','2026-09-08'],...(projection?{projection}:{})};
    results[JSON.stringify(query)] = await service.execute(query);
  }
  process.stdout.write(JSON.stringify({catalog:dailyDashboardCatalog(true),results,columns:DETAIL_COLUMNS.map(column=>({key:detailColumnKey(column),name:column.metric.name,kind:column.kind}))}));
`], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15_000 })) as {
  catalog: { success: true; data: { items: { id: string; metricIds: string[] }[]; operatingAsyncEnabled?: boolean; operatingAsyncPidGroups?: string[][] } };
  results: Record<string, DailyDashboardV2Success>;
  columns: { key: string; name: string; kind: DetailValueKind }[];
};
const boardIds = generated.catalog.data.items.find(board => board.id === "5.2")!.metricIds;
const snapshotQuery = (pid: string): DailyDashboardQuery => ({ boardId: "5.2", pid, dateRange: snapshotRange, projection: "operating_snapshot" });

function response(query: DailyDashboardQuery): DailyDashboardV2Success {
  const result = structuredClone(generated.results[JSON.stringify(query)]);
  if (!result) throw new Error(`隔离验收未登记查询：${JSON.stringify(query)}`);
  const platformIndex = platforms.findIndex(platform => platform.pid === query.pid);
  expect(platformIndex).toBeGreaterThanOrEqual(0);
  result.data.queryId = `qa-operating-async-${query.pid}-${query.projection ?? "full"}`;
  result.data.fetchedAt = fetchedAt;
  result.data.series.forEach((series, index) => series.points.forEach(point => {
    const offset = (Date.parse(point.date) - Date.parse(snapshotRange[0])) / 86_400_000;
    const value = series.metric.unit === "%" ? (20 + index % 10 + offset) / 100 : (platformIndex + 1) * 1000 + index * 10 + offset;
    Object.assign(point, { state: "available", sourceStatus: "READY", value,
      inputs: series.metric.inputs.map((input, inputIndex) => ({ key: input.key, value: inputIndex === 0 ? value : 1 })) });
    if (point.date !== date) return;
    if (series.metric.id === "M016") Object.assign(point, { value: 0, inputs: series.metric.inputs.map(input => ({ key: input.key, value: 0 })) });
    if (series.metric.id === "M087") Object.assign(point, { state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
      inputs: series.metric.inputs.map((input, inputIndex) => ({ key: input.key, value: inputIndex === 0 ? null : 6 + platformIndex })) });
    if (series.metric.id === "M002") Object.assign(point, { state: "no_value", sourceStatus: "PROCESSING", value: null,
      inputs: series.metric.inputs.map(input => ({ key: input.key, value: null })) });
    if (series.metric.id === "M058") Object.assign(point, { state: "source_failure", sourceStatus: "FAILED", value: null,
      inputs: series.metric.inputs.map(input => ({ key: input.key, value: null })) });
    if (series.metric.id === "M026") {
      Object.assign(point, { state: "no_record", value: null, inputs: series.metric.inputs.map(input => ({ key: input.key, value: null })) });
      delete point.sourceStatus;
    }
  }));
  dailyDashboardV2SuccessSchema.parse(result);
  expect(dailyDashboardMatchesQuery(result, query, query.projection ? OPERATING_METRIC_IDS : boardIds)).toBe(true);
  return result;
}

type Stage = "queued" | "running" | "projection" | "complete" | "failed";
async function fixtures(page: Page, mode: "test" | "production" = "test", asyncEnabled = true) {
  let stage: Stage = "queued";
  const dailyCalls: DailyDashboardQuery[] = [], creates: OperatingQueryJobRequest[] = [];
  const reads: { pid: string; result: boolean; stage: Stage }[] = [], external: string[] = [], unexpected: string[] = [];
  await page.addInitScript(({ subjectId, mode }) => {
    const key = `ypbi.data-environment.v1:${subjectId}`;
    if (mode === "test") sessionStorage.setItem(key, "test");
    else sessionStorage.removeItem(key);
  }, { subjectId, mode });
  await page.route("**/*", async route => {
    const request = route.request(), address = new URL(request.url()), path = address.pathname;
    if (address.origin !== new URL(base).origin) { external.push(address.origin); return route.abort("blockedbyclient"); }
    if (!path.startsWith("/api/")) return route.continue();
    if (path.endsWith("/auth/session")) return route.fulfill({ json: { success: true, data: {
      user: { subjectId, username: "qa.operating.async", displayName: "经营异步隔离验收", role: "reader", permissions: ["bi:read", "bi:export"], pidScope: "all" },
      expiresAt: "2099-01-01T00:00:00Z", csrfToken: "a".repeat(43), mustChangePassword: false
    } } });
    expect(request.headers()["x-ypbi-data-environment"]).toBe(mode);
    if (path.endsWith("/data-environment")) return route.fulfill({ json: { success: true, data: mode === "test"
      ? { mode, testAvailable: true, expiresAt: "2099-01-01T00:00:00Z", userName: "qa-local-only" }
      : { mode, testAvailable: false, expiresAt: null, userName: null } } });
    if (path.endsWith("/catalog/readable-dashboards")) {
      const catalog = structuredClone(generated.catalog);
      delete catalog.data.operatingAsyncEnabled;
      delete catalog.data.operatingAsyncPidGroups;
      if (asyncEnabled) Object.assign(catalog.data, { operatingAsyncEnabled: true, operatingAsyncPidGroups: groups });
      return route.fulfill({ json: catalog });
    }
    if (path.endsWith("/catalog/platforms")) return route.fulfill({ json: { success: true, data: { items: platforms } } });
    if (path.endsWith("/queries/dashboards/daily-reading")) {
      const query = request.postDataJSON() as DailyDashboardQuery;
      dailyCalls.push(query);
      // The original whole-board read stays synchronous in both environments.
      if (asyncEnabled) expect(query.projection).toBeUndefined();
      return route.fulfill({ json: response(query) });
    }
    if (path === "/api/bi/v2/queries/jobs" && request.method() === "POST") {
      expect(asyncEnabled).toBe(true);
      const body = operatingQueryJobRequestSchema.parse(request.postDataJSON());
      expect(body.date).toBe(date);
      expect(groups).toContainEqual(body.pids);
      creates.push(body);
      const index = groups.findIndex(group => group[0] === body.pids[0]);
      return route.fulfill({ json: operatingQueryJobCreatedSchema.parse({ success: true, data: { ...body, handle: handles[index], reused: false } }) });
    }
    const match = path.match(/^\/api\/bi\/v2\/queries\/jobs\/([^/]+)(\/result)?$/);
    if (match && request.method() === "GET") {
      expect(asyncEnabled).toBe(true);
      const index = handles.indexOf(match[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      const current = stage, pid = groups[index][0];
      const failure = current === "failed" && index === 1;
      const succeeded = ["projection", "complete", "failed"].includes(current) && !failure;
      const progress: OperatingQueryJobProgress = { kind: "operating-snapshot", handle: handles[index], pids: groups[index], date,
        status: failure ? "FAILED" : succeeded ? "SUCCEEDED" : current === "running" ? "RUNNING" : "QUEUED",
        phase: succeeded ? current === "projection" ? "projection" : "complete" : "query",
        completedUnits: failure ? 4 : succeeded ? 14 : current === "running" ? 4 : 0, totalUnits: 14, attempts: 1,
        ...(failure ? { errorCode: "EXECUTION_FAILED" } : {}) };
      reads.push({ pid, result: Boolean(match[2]), stage: current });
      return route.fulfill({ json: match[2]
        ? operatingQueryJobResultSchema.parse({ success: true, data: { ...progress, ...(progress.phase === "complete" ? { dashboards: [response(snapshotQuery(pid))] } : {}) } })
        : operatingQueryJobStatusSchema.parse({ success: true, data: progress }) });
    }
    unexpected.push(path);
    return route.fulfill({ status: 404, json: { success: false, error: { code: "NOT_FOUND", message: "隔离验收未配置此请求", requestId: "qa-operating-async" } } });
  });
  return { dailyCalls, creates, reads, external, unexpected, advance(value: Stage) { stage = value; } };
}

type Cell = string | number | null;
function readWorkbook(buffer: Buffer): Map<string, Cell[][]> {
  const entries = new Map<string, string>();
  for (let offset = 0; offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50;) {
    expect(buffer.readUInt16LE(offset + 8)).toBe(0);
    const length = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    entries.set(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"), buffer.subarray(start, start + length).toString("utf8"));
    offset = start + length;
  }
  const workbook = entries.get("xl/workbook.xml");
  expect(workbook).toBeDefined();
  return new Map([...workbook!.matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].map(sheet => [sheet[1],
    [...entries.get(`xl/worksheets/sheet${sheet[2]}.xml`)!.matchAll(/<row r="\d+">(.*?)<\/row>/gs)].map(row =>
      [...row[1].matchAll(/<c r="[A-Z]+\d+"(?: t="[^"]+")?(?:\/>|>(.*?)<\/c>)/gs)].map(cell => {
        const numeric = cell[1]?.match(/<v>(.*?)<\/v>/s);
        if (numeric) return Number(numeric[1]);
        const value = cell[1]?.match(/<t(?: [^>]*)?>(.*?)<\/t>/s)?.[1];
        return value === undefined ? null : value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      }))]));
}
const local = (page: Page) => page.locator(".core-review__detail:visible");
const rows = (page: Page) => local(page).locator(".core-review__comparison-table tbody tr");
const row = (page: Page, pid = "PH") => rows(page).filter({ has: page.locator("td > small", { hasText: new RegExp(`^PID ${pid}$`) }) });
const trigger = (page: Page, key: string, pid = "PH") => row(page, pid).locator(`td[data-column-key="${key}"] button.core-review__detail-trigger`);
const cell = (page: Page, key: string, pid = "PH") => trigger(page, key, pid).locator("b");
const notice = (page: Page) => local(page).locator(".core-review__operating-progress");
const detail = (page: Page) => page.getByRole("dialog", { name: "活跃用户人均充值金额（ARPU）", exact: true });
const url = `${base}/dashboards/public?board=5.2&pid=PH&start=2026-09-02&end=${date}`;
const labels: Record<string, string> = { READY: "已返回", SOURCE_INCOMPLETE: "来源不完整", PROCESSING: "计算中", FAILED: "加工失败", no_record: "当日未返回记录" };

for (const mode of ["test", "production"] as const) {
const environmentLabel = mode === "test" ? "测试" : "正式";
test(`${environmentLabel}两站异步进度、投影等待、93列真实状态、已开三期详情与完整XLSX同源`, async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const control = await fixtures(page, mode);
  await page.goto(url);
  await expect(rows(page)).toHaveCount(2);
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  await expect.poll(() => control.creates.length).toBe(2);
  expect(control.creates.map(value => value.pids).sort()).toEqual(groups);
  await expect(notice(page)).toContainText("后台查询排队中", { timeout: 15_000 });
  await expect(notice(page)).toContainText("查询单元已完成 0/28");
  await expect(cell(page, "M016:overall")).toHaveText("读取中");
  const opened = trigger(page, "M087:overall");
  await opened.scrollIntoViewIfNeeded(); await opened.click();
  await expect(detail(page).locator("tbody tr")).toHaveCount(3);
  await expect(detail(page).locator("tbody tr").first()).toContainText("读取中");
  await detail(page).evaluate(element => element.setAttribute("data-async-probe", "opened-while-queued"));

  control.advance("running");
  await expect(notice(page)).toContainText("后台查询中", { timeout: 15_000 });
  await expect(notice(page)).toContainText("查询单元已完成 8/28");
  control.advance("projection");
  await expect(notice(page)).toContainText("正在整理查询结果", { timeout: 15_000 });
  await expect(notice(page)).toContainText("查询单元已完成 28/28");
  await expect.poll(() => control.reads.filter(read => read.result && read.stage === "projection").length).toBeGreaterThanOrEqual(2);
  await expect(cell(page, "M016:overall")).toHaveText("读取中");
  await expect(detail(page).locator("tbody tr").first()).toContainText("读取中");

  control.advance("complete");
  await expect(cell(page, "M087:overall")).toHaveText("来源不完整", { timeout: 15_000 });
  await expect(notice(page)).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute("data-async-probe", "opened-while-queued");
  const detailRows = detail(page).locator("tbody tr");
  await expect(detailRows).toHaveCount(3);
  await expect(detailRows.first().locator("td").nth(1)).toContainText("— 元");
  await expect(detailRows.first().locator("td").nth(1)).toContainText("6 人");
  await expect(detailRows.first().locator("td").nth(2)).toHaveText("来源不完整");
  for (const day of operatingSnapshotDates(snapshotRange)) await expect(detailRows.filter({ has: page.locator("td", { hasText: new RegExp(`^${day}$`) }) })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("operating-async-open-detail-updated.png") });
  await page.keyboard.press("Escape"); await expect(detail(page)).toHaveCount(0); await expect(opened).toBeFocused();

  const sources = platforms.map(platform => response(snapshotQuery(platform.pid)));
  const visible = new Map(await rows(page).evaluateAll(items => items.map(item => [item.querySelector("td:nth-child(2) > small")!.textContent!.replace(/^PID /, ""),
    Array.from(item.querySelectorAll<HTMLButtonElement>("td[data-column-key] button.core-review__detail-trigger"), button => ({ key: button.closest("td")!.getAttribute("data-column-key"), value: button.querySelector("b")!.textContent }))] as const)));
  for (const [platformIndex, platform] of platforms.entries()) for (const [index, column] of generated.columns.entries()) {
    const series = sources[platformIndex].data.series.find(series => series.metric.id === OPERATING_LIVE_IDS[column.key])!;
    const point = series.points.find(point => point.date === date)!;
    const displayed = visible.get(platform.pid)![index];
    expect(displayed.key).toBe(column.key);
    expect(displayed.value, `${platform.pid} ${column.key}`).toBe(point.value === null ? labels[point.sourceStatus ?? point.state] : formatDetailValue(point.value, column.kind, false, series.metric.unit));
  }
  for (const platform of platforms) {
    await expect(cell(page, "M016:overall", platform.pid)).toHaveText("0");
    await expect(cell(page, "M002:overall", platform.pid)).toHaveText("计算中");
    await expect(cell(page, "M058:overall", platform.pid)).toHaveText("加工失败");
    await expect(cell(page, "M026:overall", platform.pid)).toHaveText("当日未返回记录");
  }

  await local(page).getByRole("button", { name: "导出经营明细", exact: true }).click();
  const exportDialog = page.getByRole("dialog", { name: "导出经营明细", exact: true });
  await expect(exportDialog).toContainText(environmentLabel);
  const downloading = page.waitForEvent("download");
  await exportDialog.getByRole("button", { name: "下载 XLSX", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^经营明细.*\.xlsx$/);
  const workbook = readWorkbook(readFileSync((await download.path())!));
  expect([...workbook.keys()]).toEqual(["00_导出说明", "01_经营明细", "02_数值摘要", "03_字段说明", "04_计算输入"]);
  expect(workbook.get("00_导出说明")!.flat().join(" ")).toContain(environmentLabel);
  expect(workbook.get("03_字段说明")).toHaveLength(94);
  const sheet = workbook.get("01_经营明细")!;
  expect(sheet).toHaveLength(3);
  expect(sheet[0].length).toBeGreaterThanOrEqual(3 + 93 * 9);
  for (const [platformIndex, platform] of platforms.entries()) for (const [index, column] of generated.columns.entries()) {
    const series = sources[platformIndex].data.series.find(series => series.metric.id === OPERATING_LIVE_IDS[column.key])!;
    const exported = sheet.find(values => values[2] === platform.pid)!;
    expect(exported).toBeDefined();
    for (const [period, day] of [date, "2026-09-07", "2026-09-01"].entries()) {
      const offset = 3 + index * 9 + period * 3;
      if (series.metric.id === "M018" && period > 0) {
        expect(exported[offset]).toBeNull(); expect(exported[offset + 1]).toContain("不适用日比较"); expect(exported[offset + 2]).toBeNull();
      } else {
        const point = series.points.find(point => point.date === day)!;
        expect(exported[offset], `${platform.pid} ${column.key} ${day}`).toBe(point.value === null ? null : point.value * (column.kind === "ratio" ? 100 : 1));
        expect(exported[offset + 1]).toBe(`待验数 · ${labels[point.sourceStatus ?? point.state]}`);
        expect(exported[offset + 2]).toBe(fetchedAt);
      }
    }
  }
  const calculation = workbook.get("04_计算输入")!;
  for (const [platformIndex, platform] of platforms.entries()) {
    const inputs = calculation.filter(values => values[0] === platform.pid && values[3] === "M087:overall" && values[4] === "当日");
    expect(inputs).toHaveLength(2);
    expect(inputs.map(values => values[8])).toEqual([null, 6 + platformIndex]);
    expect(inputs.every(values => values[10] === "待验数 · 来源不完整" && values[11] === fetchedAt)).toBe(true);
  }
  expect(control.dailyCalls).toEqual([{ boardId: "5.2", pid: "PH", dateRange: ["2026-09-02", date] }]);
  expect(control.creates).toHaveLength(2);
  expect(control.external).toEqual([]); expect(control.unexpected).toEqual([]); expect(errors).toEqual([]);
});

test(`${environmentLabel}任务FAILED只影响所属站点，保留错误码且不回退同步或静默重建`, async ({ page }, info) => {
  const control = await fixtures(page, mode);
  await page.goto(url);
  await expect.poll(() => control.creates.length).toBe(2);
  control.advance("failed");
  await expect(cell(page, "M016:overall", "PH")).toHaveText("0", { timeout: 15_000 });
  await expect(cell(page, "M016:overall", "TT")).toHaveText("读取失败");
  await expect(notice(page)).toHaveCount(0);
  await expect(row(page, "TT").locator("td[data-column-key] .core-review__detail-trigger > b")).toHaveCount(93);
  const failed = trigger(page, "M087:overall", "TT");
  await failed.scrollIntoViewIfNeeded(); await failed.click();
  await expect(detail(page)).toContainText("错误代码：QUERY_JOB_FAILED");
  await expect(detail(page)).toContainText("任务错误码：EXECUTION_FAILED");
  await expect(detail(page).locator("tbody tr").first().locator("td").nth(2)).toContainText("读取失败");
  await page.screenshot({ path: info.outputPath("operating-async-task-failed.png") });
  expect(control.reads.some(read => read.pid === "TT" && read.result)).toBe(false);
  expect(control.creates).toHaveLength(2);
  expect(control.dailyCalls.some(query => query.projection)).toBe(false);
  expect(control.external).toEqual([]); expect(control.unexpected).toEqual([]);
});
}

test("正式目录不提供异步能力时保留原同步93列与真实状态，不创建任务", async ({ page }) => {
  const control = await fixtures(page, "production", false);
  await page.goto(url);
  await expect(rows(page)).toHaveCount(2);
  await expect(local(page).locator("thead th[data-column-key]")).toHaveCount(93);
  await expect.poll(() => control.dailyCalls.filter(query => query.projection === "operating_snapshot").length).toBe(2);
  for (const platform of platforms) {
    await expect(cell(page, "M016:overall", platform.pid)).toHaveText("0");
    await expect(cell(page, "M087:overall", platform.pid)).toHaveText("来源不完整");
    await expect(cell(page, "M002:overall", platform.pid)).toHaveText("计算中");
    await expect(cell(page, "M058:overall", platform.pid)).toHaveText("加工失败");
    await expect(cell(page, "M026:overall", platform.pid)).toHaveText("当日未返回记录");
  }
  await expect(notice(page)).toHaveCount(0);
  expect(control.dailyCalls.filter(query => query.projection).map(query => query.pid).sort()).toEqual(["PH", "TT"]);
  expect(control.dailyCalls.filter(query => query.projection).every(query => query.dateRange.join() === snapshotRange.join())).toBe(true);
  expect(control.creates).toEqual([]); expect(control.reads).toEqual([]);
  expect(control.external).toEqual([]); expect(control.unexpected).toEqual([]);
});
