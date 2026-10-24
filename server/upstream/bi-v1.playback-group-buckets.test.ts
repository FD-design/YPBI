import { expect, test } from "bun:test";
import {
  DAILY_PLAYBACK_MAX_GROUPS, DAILY_PLAYBACK_MAX_POINTS, DAILY_PLAYBACK_METRIC_IDS,
  dailyPlaybackGroupsSchema, type DailyReadingMetric
} from "../../contracts/daily-dashboard";
import {
  BI_V1_EFFECTIVE_PLAY_RULE_VERSION, projectBiV1PlaybackGroups,
  type BiV1MetricRow, type BiV1PlaybackMetricCode
} from "./bi-v1.adapter";

const date = "2026-09-21";
const scope = { pid: "PH", startDate: date, endDate: date };
const today = "2026-12-01";
const metricFor = (id: BiV1PlaybackMetricCode): DailyReadingMetric => ({
  id, name: id, unit: id === "M036" ? "ratio" : "count", definition: "playback bucket fixture",
  authorityVersion: "fixture-v1", formula: null, referenceMetricId: id, sourceNote: null,
  inputs: id === "M036" ? [
    { key: "effectivePlayCount", name: "有效观看次数", unit: "count" },
    { key: "successfulStartCount", name: "成功起播次数", unit: "count" }
  ] : [{ key: id === "M034" ? "effectivePlayCount" : "successfulStartCount", name: id, unit: "count" }]
});
const group = (key: string, effective = 7, starts = 8, businessDate = date): BiV1MetricRow[] => DAILY_PLAYBACK_METRIC_IDS.map(metricCode => ({
  metricCode, businessDate, dimensions: { pid: "PH", videoType: key },
  value: metricCode === "M036" ? starts === 0 ? null : effective / starts : metricCode === "M034" ? effective : starts,
  numerator: metricCode === "M097" ? starts : effective, denominator: metricCode === "M036" ? starts : 0,
  unit: metricCode === "M036" ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1",
  ruleVersion: metricCode === "M097" ? "successful-start-v1" : BI_V1_EFFECTIVE_PLAY_RULE_VERSION
}));
const scopeRow = (metricCode: BiV1PlaybackMetricCode, businessDate?: string): BiV1MetricRow => ({
  metricCode, ...(businessDate ? { businessDate } : {}), dimensions: { pid: "PH" }, value: null,
  numerator: 0, denominator: 0, unit: metricCode === "M036" ? "ratio" : "count", dataStatus: "PROCESSING",
  metricVersion: "bi-v1", ruleVersion: BI_V1_EFFECTIVE_PLAY_RULE_VERSION
});
const message = (rows: BiV1MetricRow[]) => ({
  metricVersion: "bi-v1" as const, generatedAt: "2026-10-03T00:00:00Z", watermark: "fixture-watermark", rows
});
const project = (rows: BiV1MetricRow[], query = scope) => projectBiV1PlaybackGroups(message(rows), query, today, metricFor).videoType;

/** Observe only original source references during the synchronous projection. */
function observeBuckets(inputRows: BiV1MetricRow[]) {
  const originals = new Set(inputRows);
  const originalIterator = Array.prototype[Symbol.iterator];
  const originalSet = Map.prototype.set;
  const writes: Array<{ owner: Map<unknown, unknown>; key: unknown; bucket: BiV1MetricRow[] }> = [];
  let copiedReferences = 0;
  let result!: ReturnType<typeof project>;
  try {
    Array.prototype[Symbol.iterator] = function (this: unknown[]) {
      const iterator = originalIterator.call(this);
      const source = this;
      return {
        next() {
          const next = iterator.next();
          if (!next.done && source !== inputRows && originals.has(next.value as BiV1MetricRow)) copiedReferences++;
          return next;
        },
        [Symbol.iterator]() { return this; }
      } as ReturnType<typeof originalIterator>;
    };
    Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (Array.isArray(value) && value.length && originals.has(value[0])) writes.push({ owner: this, key, bucket: value });
      return originalSet.call(this, key, value);
    };
    result = project(inputRows);
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator;
    Map.prototype.set = originalSet;
  }
  const histories = new Map<Map<unknown, unknown>, Map<unknown, BiV1MetricRow[][]>>();
  for (const { owner, key, bucket } of writes) {
    const entries = histories.get(owner) ?? new Map<unknown, BiV1MetricRow[][]>();
    const arrays = entries.get(key) ?? [];
    arrays.push(bucket);
    entries.set(key, arrays);
    histories.set(owner, entries);
  }
  const bucketHistories = [...histories.values()].flatMap(entries => [...entries.values()]);
  return { result, copiedReferences, bucketHistories, buckets: bucketHistories.map(arrays => arrays.at(-1)!) };
}

function expectStableCompleteBuckets(observed: ReturnType<typeof observeBuckets>, inputRows: BiV1MetricRow[]) {
  const storedRows = observed.buckets.flat();
  expect(storedRows).toHaveLength(inputRows.length);
  expect(new Set(storedRows).size).toBe(inputRows.length);
  for (const bucket of observed.buckets) {
    const first = bucket[0];
    const expected = inputRows.filter(row => row.metricCode === first.metricCode && row.businessDate === first.businessDate
      && row.dimensions.videoType === first.dimensions.videoType);
    expect(bucket).toHaveLength(expected.length);
    expect(bucket.every((row, index) => row === expected[index])).toBe(true);
  }
  expect(observed.copiedReferences).toBe(0);
  for (const arrays of observed.bucketHistories) expect(new Set(arrays).size).toBe(1);
}

test("golden：交错输入保留首见类型顺序、固定指标与日期顺序及原分子分母", () => {
  const rows = [scopeRow("M097"), ...group("type-z", 1, 10, "2026-09-22"), scopeRow("M034"),
    ...group("type-a", 2, 4), scopeRow("M036"), ...group("type-z", 3, 4), ...group("type-a", 0, 0, "2026-09-22")];
  const before = JSON.stringify(rows);
  const result = project(rows, { ...scope, endDate: "2026-09-22" });
  expect(result.day).toEqual({ state: "returned", generatedAt: message(rows).generatedAt, watermark: "fixture-watermark",
    scopeStatuses: ["M097", "M034", "M036"].map(metricId => ({ metricId, sourceStatus: "PROCESSING" })) });
  expect(result.groups.map(group => [group.key, group.label])).toEqual([["type-z", "type-z"], ["type-a", "type-a"]]);
  for (const group of result.groups) {
    expect(group.series.map(series => series.metric.id)).toEqual([...DAILY_PLAYBACK_METRIC_IDS]);
    for (const series of group.series) expect(series.points.map(point => point.date)).toEqual([date, "2026-09-22"]);
  }
  const ratio = result.groups[0].series.find(series => series.metric.id === "M036")!;
  expect(ratio.points[0]).toEqual({ date, state: "available", value: 3 / 4, ruleVersion: BI_V1_EFFECTIVE_PLAY_RULE_VERSION,
    sourceStatus: "READY", inputs: [{ key: "effectivePlayCount", value: 3 }, { key: "successfulStartCount", value: 4 }] });
  expect(ratio.summary).toEqual({ state: "available", value: 4 / 14, ruleVersion: BI_V1_EFFECTIVE_PLAY_RULE_VERSION,
    sourceStatus: "READY", inputs: [{ key: "effectivePlayCount", value: 4 }, { key: "successfulStartCount", value: 14 }] });
  expect(result.groups[1].series.find(series => series.metric.id === "M036")!.points[1]).toMatchObject({
    state: "zero_denominator", value: null, inputs: [{ value: 0 }, { value: 0 }]
  });
  expect(dailyPlaybackGroupsSchema.safeParse({ videoType: result }).success).toBe(true);
  expect(JSON.stringify(rows)).toBe(before);
});

test("重复scope仍关闭整份分组响应，所有原行按顺序进入同一线性bucket", () => {
  const rows = [...Array.from({ length: 128 }, () => scopeRow("M034")), ...group("healthy")];
  const observed = observeBuckets(rows);
  expect(observed.result.day.state).toBe("invalid_response");
  expect(observed.result.groups).toEqual([]);
  expectStableCompleteBuckets(observed, rows);
});

test("重复group metric仍为invalid_value且健康组保留，重复原行不复制或丢失", () => {
  const duplicate = group("duplicate")[0];
  const rows = [...Array.from({ length: 128 }, () => ({ ...duplicate })), ...group("duplicate").slice(1), ...group("healthy", 1, 2)];
  const observed = observeBuckets(rows);
  expect(observed.result.day.state).toBe("returned");
  expect(observed.result.groups.map(group => group.key)).toEqual(["duplicate", "healthy"]);
  for (const series of observed.result.groups[0].series) expect(series.points[0]).toMatchObject({ state: "invalid_value", value: null });
  expect(observed.result.groups[1].series.find(series => series.metric.id === "M036")!.points[0]).toMatchObject({
    state: "available", value: 0.5, sourceStatus: "READY"
  });
  expectStableCompleteBuckets(observed, rows);
});

test("外部PID、越界日期、未请求维度、非法类型及冲突scope均保持invalid_response", () => {
  const valid = group("type-a");
  const cases: BiV1MetricRow[][] = [
    [{ ...valid[0], dimensions: { ...valid[0].dimensions, pid: "OTHER" } }],
    [{ ...valid[0], businessDate: "2026-09-20" }],
    [{ ...valid[0], businessDate: "2026-09-22" }],
    [{ ...valid[0], dimensions: { ...valid[0].dimensions, clientPlatform: "android" } }],
    [{ ...valid[0], dimensions: { pid: "PH", videoType: "   " } }],
    [{ ...valid[0], businessDate: undefined }],
    [scopeRow("M034"), { ...scopeRow("M034", date), dataStatus: "FAILED" }]
  ];
  for (const invalid of cases) {
    const result = project([...valid, ...invalid]);
    expect(result.day.state).toBe("invalid_response");
    expect(result.groups).toEqual([]);
  }
});

test("类型数量在既有上限内可投影，超过上限保持软失败", () => {
  const rows = Array.from({ length: DAILY_PLAYBACK_MAX_GROUPS + 1 }, (_, index) => group(`type-${index}`)[0]);
  const allowed = project(rows.slice(0, DAILY_PLAYBACK_MAX_GROUPS));
  expect(allowed.day.state).toBe("returned");
  expect(allowed.groups).toHaveLength(DAILY_PLAYBACK_MAX_GROUPS);
  const rejected = project(rows);
  expect(rejected.day.state).toBe("invalid_response");
  expect(rejected.groups).toEqual([]);
});

test("展开点位按组数×指标数×日期加汇总计数，越界前保持原上限", () => {
  const rows = Array.from({ length: DAILY_PLAYBACK_MAX_GROUPS }, (_, index) => group(`type-${index}`)[0]);
  const allowedScope = { ...scope, startDate: "2026-09-01", endDate: "2026-10-02" };
  const expectedPoints = DAILY_PLAYBACK_MAX_GROUPS * DAILY_PLAYBACK_METRIC_IDS.length * (32 + 1);
  expect(expectedPoints).toBeLessThanOrEqual(DAILY_PLAYBACK_MAX_POINTS);
  const allowed = project(rows, allowedScope);
  expect(allowed.day.state).toBe("returned");
  expect(allowed.groups.reduce((sum, group) => sum + group.series.reduce((count, series) => count + series.points.length + 1, 0), 0)).toBe(expectedPoints);
  expect(DAILY_PLAYBACK_MAX_GROUPS * DAILY_PLAYBACK_METRIC_IDS.length * (33 + 1)).toBeGreaterThan(DAILY_PLAYBACK_MAX_POINTS);
  const rejected = project(rows, { ...allowedScope, endDate: "2026-10-03" });
  expect(rejected.day.state).toBe("invalid_response");
  expect(rejected.groups).toEqual([]);
});
