import { afterEach, expect, test } from "bun:test";
import { DAILY_STATISTICS_VERSION } from "../../../contracts/daily-dashboard";
import { OPERATING_METRIC_IDS, operatingSnapshotDates, OPERATING_SNAPSHOT_STATISTICS_REASON } from "../../../contracts/operating-detail-projection";
import { operatingQueryDateRange, type OperatingQueryJobRequest } from "../../../contracts/operating-query-jobs";
import { createOperatingQueryJobRunner } from "./operating-query-jobs";
import { setDataEnvironmentPreference, type DataEnvironmentMode } from "./dataEnvironmentPreference";
import { dailyDashboardEnvironment } from "./daily-dashboard-environment";

const handle = "11111111-1111-4111-8111-111111111111";
const input: OperatingQueryJobRequest = { kind: "operating-snapshot", pids: ["PH", "TT"], date: "2026-10-17" };
const progress = (status = "SUCCEEDED", phase = "query") => ({ ...input, handle, status, phase, completedUnits: status === "SUCCEEDED" ? 14 : 2, totalUnits: 14, attempts: 1 });
const created = () => ({ success: true, data: { ...input, handle, reused: false } });
function dashboard(pid: string) {
  const dateRange = operatingQueryDateRange(input.date);
  return { success: true, data: { schemaVersion: "day-dashboard/v2", query: { boardId: "5.2", pid, dateRange, projection: "operating_snapshot" },
    queryId: "fixture-" + pid, fetchedAt: "2026-10-21T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["synthetic"],
    series: OPERATING_METRIC_IDS.map((id, index) => ({ metric: { id, name: id, unit: "人", definition: "test", authorityVersion: "test", formula: null, referenceMetricId: id, sourceNote: null, inputs: [{ key: "n", name: "人数", unit: "人" }] },
      points: operatingSnapshotDates(dateRange).map(date => ({ date, state: index === 1 ? "no_value" : "available", sourceStatus: index === 1 ? "SOURCE_INCOMPLETE" : "READY", value: index === 1 ? null : 0, inputs: [{ key: "n", value: index === 1 ? 2 : 0 }] })),
      periodStatistics: { aggregationVersion: DAILY_STATISTICS_VERSION, dateRange, dayCount: 8, state: "unsupported", values: [], reason: OPERATING_SNAPSHOT_STATISTICS_REASON } })) } };
}
function fixture(responses: unknown[], environment: DataEnvironmentMode = "test") {
  setDataEnvironmentPreference(environment);
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const run = createOperatingQueryJobRunner({ fetch: async (path, init) => {
    calls.push({ path, init }); return Response.json(responses[calls.length - 1]);
  }, now: () => 0, sleep: async () => {} });
  return { run, calls };
}
afterEach(() => setDataEnvironmentPreference("production"));

for (const environment of ["test", "production"] as const) test(`${environment}经营任务复用有界轮询，投影未完不能把后台成功当93列交付`, async () => {
  const f = fixture([created(), { success: true, data: progress() }, { success: true, data: progress("SUCCEEDED", "projection") },
    { success: true, data: progress("SUCCEEDED", "complete") }, { success: true, data: { ...progress("SUCCEEDED", "complete"), dashboards: input.pids.map(dashboard) } }], environment);
  const seen: unknown[] = [];
  const results = await f.run(input, { onProgress: state => { seen.push(state); expect(Object.isFrozen(state)).toBe(true); expect("dashboards" in state).toBe(false); } });
  expect(f.calls).toHaveLength(5);
  expect(results.map(item => item.data.query.pid)).toEqual(input.pids);
  expect(results.every(item => dailyDashboardEnvironment(item) === environment)).toBe(true);
  expect(results).toEqual(input.pids.map(dashboard));
  expect(results[0].data.series).toHaveLength(93);
  expect(results[0].data.series[0].points[0].value).toBe(0);
  expect(results[0].data.series[1].points[0]).toMatchObject({ value: null, sourceStatus: "SOURCE_INCOMPLETE", inputs: [{ key: "n", value: 2 }] });
  expect(seen).toHaveLength(4);
  expect(f.calls.every(call => new Headers(call.init.headers).get("x-ypbi-data-environment") === environment)).toBe(true);
  expect(f.calls.some(call => call.path.includes("daily-reading"))).toBe(false);
});

for (const environment of ["test", "production"] as const) for (const stage of ["create", "poll", "result"] as const)
test(`${environment}经营任务在${stage}后环境变化时停止，不继续旧句柄或交付旧结果`, async () => {
  setDataEnvironmentPreference(environment);
  const calls: string[] = [], seen: unknown[] = [];
  const responses = [created(), { success: true, data: progress() },
    { success: true, data: { ...progress("SUCCEEDED", "complete"), dashboards: input.pids.map(dashboard) } }];
  const changeAt = stage === "create" ? 0 : stage === "poll" ? 1 : 2;
  const run = createOperatingQueryJobRunner({ fetch: async (path, init) => {
    expect(new Headers(init.headers).get("x-ypbi-data-environment")).toBe(environment);
    const index = calls.push(path) - 1;
    if (index === changeAt) setDataEnvironmentPreference(environment === "test" ? "production" : "test");
    return Response.json(responses[index]);
  }, now: () => 0, sleep: async () => {} });
  await expect(run(input, { onProgress: value => seen.push(value) })).rejects.toMatchObject({ code: "INVALID_V2_QUERY_RESPONSE" });
  expect(calls).toHaveLength(changeAt + 1);
  expect(seen).toHaveLength(stage === "result" ? 1 : 0);
  expect(calls.every(path => path.startsWith("/api/bi/v2/queries/jobs"))).toBe(true);
});

test("创建响应必须匹配平台顺序及日期，不接受其他范围句柄", async () => {
  for (const patch of [{ date: "2026-10-18" }, { pids: ["TT", "PH"] }, { pids: ["PH"] }]) {
    const f = fixture([{ ...created(), data: { ...created().data, ...patch } }]);
    await expect(f.run(input)).rejects.toMatchObject({ code: "INVALID_V2_QUERY_RESPONSE" });
    expect(f.calls).toHaveLength(1);
  }
});

test("错误日期、平台或缺列结果拒绝，不复用其他结果或转同步", async () => {
  const invalid = [input.pids.slice(0, 1).map(dashboard), input.pids.toReversed().map(dashboard), input.pids.map(pid => {
    const item = dashboard(pid); item.data.series.pop(); return item;
  })];
  const warn = console.warn; console.warn = () => {};
  try {
    for (const dashboards of invalid) {
      const f = fixture([created(), { success: true, data: progress() }, { success: true, data: { ...progress("SUCCEEDED", "complete"), dashboards } }]);
      await expect(f.run(input)).rejects.toMatchObject({ code: "INVALID_V2_RESPONSE" });
      expect(f.calls).toHaveLength(3);
    }
  } finally { console.warn = warn; }
});

for (const status of ["FAILED", "EXPIRED"] as const) test(`经营任务${status}保留安全错误码，不请求结果或静默重建`, async () => {
  const f = fixture([created(), { success: true, data: { ...progress(status), errorCode: "EXECUTION_FAILED" } }]);
  await expect(f.run(input)).rejects.toMatchObject({ code: status === "FAILED" ? "QUERY_JOB_FAILED" : "QUERY_JOB_EXPIRED", queryJobErrorCode: "EXECUTION_FAILED" });
  expect(f.calls).toHaveLength(2);
});
