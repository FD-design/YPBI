import { expect, test } from "bun:test";
import type { DailyDashboardQuery } from "../../contracts/daily-dashboard";
import { currentUpstreamRequestProfile, runWithUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService } from "./daily-dashboard.service";

const date = "2020-01-01";
const now = () => new Date("2026-10-27T00:00:00Z");
const query = (pid = "PH"): DailyDashboardQuery => ({ boardId: "5.10", pid, dateRange: [date, date] });
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function metrics(params: Record<string, string>) {
  return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null,
    rows: !params.dimensionFilters && params.metricCodes.split(",").includes("M059") ? [{
      metricCode: "M059", businessDate: date, dimensions: { pid: params.pid }, value: 7,
      numerator: 7, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "synthetic-v1"
    }] : [] } };
}
const legacy = () => ({ code: 200, msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] });

test("one client serializes data reads across twenty independent PID executions", async () => {
  let active = 0, peak = 0;
  const client = { get: async (path: string, params: Record<string, string>) => {
    active++; peak = Math.max(peak, active);
    try { await wait(2); return path.endsWith("/metrics") ? metrics(params) : legacy(); }
    finally { active--; }
  } };
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query(`P${index}`))));
  expect(peak).toBe(1);
  expect(results).toHaveLength(20);
  expect(results.every(result => result.data.series.find(item => item.metric.id === "M059")!.points[0].value === 7)).toBe(true);
});

test("admission waiting longer than the source window does not consume an unstarted unit budget", async () => {
  const held = deferred<unknown>();
  let starts = 0;
  const client = { get: (path: string, params: Record<string, string>) => {
    starts++;
    return starts === 1 ? held.promise : Promise.resolve(path.endsWith("/metrics") ? metrics(params) : legacy());
  } };
  const first = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query("FIRST"));
  await flush();
  const second = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 20 }).execute(query("SECOND"));
  await wait(35);
  expect(starts).toBe(1);
  held.resolve(metrics({ pid: "FIRST", metricCodes: "M059" }));
  await first;
  const result = await second;
  expect(result.data.series.find(item => item.metric.id === "M059")!.points[0]).toMatchObject({ value: 7, sourceStatus: "READY" });
});

test("queued work restores the request profile rather than borrowing the releasing caller", async () => {
  const held = deferred<unknown>();
  const observed: string[] = [];
  let first = true;
  const client = { get: async (path: string, params: Record<string, string>) => {
    observed.push(`${params.pid}:${currentUpstreamRequestProfile()?.cachePartition ?? "production"}`);
    if (first) { first = false; return held.promise; }
    return path.endsWith("/metrics") ? metrics(params) : legacy();
  } };
  const a = new DailyDashboardService(client, now).execute(query("PRIMARY"));
  await flush();
  const preview = (partition: string) => runWithUpstreamRequestProfile({ environment: "test", baseUrl: "https://preview.invalid",
    token: `fixture-${partition}`, userName: partition, cachePartition: partition }, () => new DailyDashboardService(client, now).execute(query(partition)));
  const b = preview("A"), c = preview("B"), d = new DailyDashboardService(client, now).execute(query("SECONDARY"));
  held.resolve(metrics({ pid: "PRIMARY", metricCodes: "M059" }));
  await Promise.all([a, b, c, d]);
  expect(observed.filter(value => value.startsWith("A:")).every(value => value === "A:A")).toBe(true);
  expect(observed.filter(value => value.startsWith("B:")).every(value => value === "B:B")).toBe(true);
  expect(observed.filter(value => value.startsWith("SECONDARY:")).every(value => value === "SECONDARY:production")).toBe(true);
});

test("an actual unit timeout preserves failure while the next queued query can succeed", async () => {
  let firstOverall = true;
  const client = { get: (path: string, params: Record<string, string>) => {
    if (path.endsWith("/metrics") && !params.dimensionFilters && firstOverall) {
      firstOverall = false;
      return new Promise<unknown>(() => {});
    }
    return Promise.resolve(path.endsWith("/metrics") ? metrics(params) : legacy());
  } };
  const first = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 20 }).execute(query("FIRST"));
  const second = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 20 }).execute(query("SECOND"));
  const results = await Promise.all([first, second]);
  expect(results[0].data.series.find(item => item.metric.id === "M059")!.points[0]).toMatchObject({ value: null, state: "source_failure" });
  expect(results[1].data.series.find(item => item.metric.id === "M059")!.points[0]).toMatchObject({ value: 7, sourceStatus: "READY" });
});

test("cancelling a queued query does not wait for the active PID or start its reads", async () => {
  const held = deferred<unknown>(), controller = new AbortController();
  const observed: string[] = [];
  let firstRead = true;
  const client = { get: (path: string, params: Record<string, string>) => {
    observed.push(params.pid);
    if (firstRead) { firstRead = false; return held.promise; }
    return Promise.resolve(path.endsWith("/metrics") ? metrics(params) : legacy());
  } };
  const first = new DailyDashboardService(client, now, undefined, { sourceReadTimeoutMs: 1000 }).execute(query("FIRST"));
  await flush();
  const cancelled = new DailyDashboardService(client, now).execute(query("CANCELLED"), controller.signal).then(() => null, error => error);
  controller.abort();
  expect((await cancelled)?.code).toBe("UPSTREAM_TIMEOUT");
  expect(observed).toEqual(["FIRST"]);
  held.resolve(metrics({ pid: "FIRST", metricCodes: "M059" }));
  await first;
  expect(observed).not.toContain("CANCELLED");
});

test("modern READY snapshot does not start unnecessary legacy requests and retains all 93 columns", async () => {
  const paths: string[] = [];
  const ratio = new Set(["M005", "M006", "M007", "M020", "M021", "M022", "M023", "M036", "M061", "M064", "M081", "M090", "M099", "M103", "M111", "M114"]);
  const client = { get: async (path: string, params: Record<string, string>) => {
    paths.push(path);
    if (!path.endsWith("/metrics")) return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows: [] } };
    const dimensions = { pid: params.pid, ...JSON.parse(params.dimensionFilters ?? "{}") };
    const rows = params.metricCodes.split(",").flatMap(metricCode => {
      const unit = ratio.has(metricCode) ? "ratio" : metricCode === "M058" ? "currency" : metricCode === "M102" ? "seconds" : metricCode === "M110" ? "count_per_user" : "count";
      const ratioValue = unit === "ratio" || unit === "count_per_user";
      const row = { metricCode, dimensions, value: ratioValue ? 0.5 : 7,
        numerator: ratioValue ? 1 : 7, denominator: ratioValue ? 2 : 0, unit, dataStatus: "READY", metricVersion: "bi-v1",
        ruleVersion: metricCode === "M058" ? "paid-order-value-rmb-v2" : metricCode === "M102" ? "foreground-watch-duration-v1" : "synthetic-v1" };
      return params.granularity === "summary" ? [row] : Array.from({ length: 8 }, (_, index) => ({ ...row, businessDate: `2020-01-${String(index + 1).padStart(2, "0")}` }));
    });
    return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now().toISOString(), watermark: null, rows } };
  } };
  const result = await new DailyDashboardService(client, now).execute({ boardId: "5.2", pid: "PH", dateRange: [date, "2020-01-08"], projection: "operating_snapshot" });
  expect(result.data.series).toHaveLength(93);
  expect(result.data.series.every(series => series.points.map(point => point.date).join() === "2020-01-01,2020-01-07,2020-01-08")).toBe(true);
  expect(paths.filter(path => !path.startsWith("/api/admin/bi/v1/"))).toEqual([]);
  expect(result.data.series.find(item => item.metric.id === "M059")!.points.every(point => point.value === 7 && point.sourceStatus === "READY")).toBe(true);
});
