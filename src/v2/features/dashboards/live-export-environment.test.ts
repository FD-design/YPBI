import { expect, test } from "bun:test";
import { dailyDashboardSuccessSchema, type DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { dailyDashboardEnvironment, recordDailyDashboardEnvironment } from "../../api/daily-dashboard-environment";
import { currentDataEnvironmentPreference, setDataEnvironmentPreference, type DataEnvironmentMode } from "../../api/dataEnvironmentPreference";
import { connectedDimensionReading, connectedDimensionRows, connectedDimensionSheet } from "../../design/connected-dimension-model";
import { connectedTopicExportSheets } from "../../design/connected-topic-export";
import { buildPreviewWorkbook, prepareWorkbookSheets, type WorkbookSheet } from "../../design/preview-workbook";
import { liveDataEnvironment, liveExportEnvironmentRows, liveExportMetadata, type LiveDashboardReading } from "./LiveDashboardContext";

function result(values: (number | null)[] = [0, null, 7], startDate = "2026-10-10"): DailyDashboardSuccess {
  const dates = values.map((_, index) => new Date(Date.parse(startDate) + index * 86400000).toISOString().slice(0, 10));
  const dateRange = [dates[0], dates.at(-1)!];
  return dailyDashboardSuccessSchema.parse({
    success: true,
    data: {
      schemaVersion: "day-dashboard/v2",
      query: { boardId: "5.2", pid: "PH", dateRange },
      queryId: `in-memory-${startDate}`,
      fetchedAt: "2026-10-12T00:00:00Z",
      timezone: "Asia/Shanghai",
      validationStatus: "pending_validation",
      completeness: "unknown",
      watermark: null,
      sourceApiIds: ["in-memory-source"],
      series: ["M001", "M002"].map((id, metricIndex) => ({
        metric: {
          id, name: `内存计数${metricIndex + 1}`, unit: "次", definition: "仅用于单测的内存结果",
          authorityVersion: "in-memory/v1", formula: null, referenceMetricId: id, sourceNote: null,
          inputs: [{ key: "count", name: "计数", unit: "次" }]
        },
        points: values.map((value, index) => ({
          date: dates[index], state: value === null ? "no_value" : "available",
          value: value === null ? null : value + metricIndex,
          inputs: [{ key: "count", value: value === null ? null : value + metricIndex }]
        })),
        periodStatistics: {
          aggregationVersion: "daily-statistics/v1", dateRange, dayCount: values.length,
          state: "unsupported", values: [], reason: "内存夹具不提供周期统计"
        }
      }))
    }
  });
}

function success(data: DailyDashboardSuccess) {
  return { status: "success" as const, data, refreshing: false, refreshError: null };
}

function reading(data: DailyDashboardSuccess): LiveDashboardReading {
  return {
    query: data.data.query, metricIds: data.data.series.map(series => series.metric.id), state: success(data),
    platformName: "内存平台", retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} }
  };
}

function threePeriods(modes: [DataEnvironmentMode, DataEnvironmentMode, DataEnvironmentMode] = ["test", "production", "test"]) {
  const current = recordDailyDashboardEnvironment(result(), modes[0]);
  const comparison = recordDailyDashboardEnvironment(result([3, null, 5], "2026-10-07"), modes[1]);
  const reference = recordDailyDashboardEnvironment(result([2], "2026-10-03"), modes[2]);
  const live = reading(current);
  live.dataEnvironment = dailyDashboardEnvironment(current);
  live.comparison = { label: "上一周期", query: comparison.data.query, state: success(comparison), dataEnvironment: dailyDashboardEnvironment(comparison) };
  live.dayReference = { query: reference.data.query, state: success(reference), dataEnvironment: dailyDashboardEnvironment(reference) };
  return live;
}

function metadataValue(live: LiveDashboardReading, name: string) {
  return liveExportMetadata(live).find(row => row[0] === name)?.[1];
}

// Read the stored OOXML ZIP entries so assertions target worksheet cells.
function workbookTextFiles(bytes: Uint8Array) {
  const files = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    expect(view.getUint16(cursor + 8, true)).toBe(0);
    const dataSize = view.getUint32(cursor + 18, true);
    const nameSize = view.getUint16(cursor + 26, true);
    const extraSize = view.getUint16(cursor + 28, true);
    const name = decoder.decode(bytes.subarray(cursor + 30, cursor + 30 + nameSize));
    const dataStart = cursor + 30 + nameSize + extraSize;
    files.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + dataSize)));
    cursor = dataStart + dataSize;
  }
  expect(view.getUint32(cursor, true)).toBe(0x02014b50);
  return files;
}

test("未登记环境的真实结果不根据当前正式偏好推断环境", () => {
  const previousPreference = currentDataEnvironmentPreference();
  try {
    setDataEnvironmentPreference("production");
    const live = reading(result());
    expect(liveDataEnvironment(live)).toBeUndefined();
    expect(liveExportEnvironmentRows(live)).toEqual([
      ["数据环境", "环境未确认"], ["对比数据环境", "未启用对比"], ["日值基准数据环境", "未启用日值基准"]
    ]);
    expect(metadataValue(live, "数据环境")).toBe("环境未确认");
    setDataEnvironmentPreference("test");
    expect(metadataValue(live, "数据环境")).toBe("环境未确认");
  } finally {
    setDataEnvironmentPreference(previousPreference);
  }
});

test("请求结果记录优先于私有 fallback，只有未记录的派生结果使用 fallback", () => {
  const data = recordDailyDashboardEnvironment(result(), "test");
  const live = { ...reading(data), dataEnvironment: "production" as const };
  expect(liveDataEnvironment(live)).toBe("test");
  expect(metadataValue(live, "数据环境")).toBe("测试数据");

  const clone = structuredClone(data);
  expect(dailyDashboardEnvironment(clone)).toBeUndefined();
  const projected: LiveDashboardReading = { ...live, state: success(clone), dataEnvironment: "test" };
  expect(liveDataEnvironment(projected)).toBe("test");
  delete projected.dataEnvironment;
  expect(liveDataEnvironment(projected)).toBeUndefined();
  expect(metadataValue(projected, "数据环境")).toBe("环境未确认");
});

test("加载与读取失败不把旧的私有环境字段当作成功结果快照", () => {
  const live = { ...reading(result()), dataEnvironment: "test" as const };
  for (const state of [
    { status: "loading" as const },
    { status: "failure" as const, kind: "error" as const, message: "内存读取失败", code: "NETWORK_ERROR" }
  ]) {
    const unavailable = { ...live, state };
    expect(liveDataEnvironment(unavailable)).toBeUndefined();
    expect(metadataValue(unavailable, "数据环境")).toBe("环境未确认");
  }
  live.comparison = { label: "上一周期", query: live.query, state: { status: "success", data: null, refreshing: false, refreshError: null } };
  live.dayReference = { query: live.query, state: { status: "loading" }, dataEnvironment: "production" };
  expect(liveExportEnvironmentRows(live).slice(1)).toEqual([
    ["对比数据环境", "环境未确认"], ["日值基准数据环境", "环境未确认"]
  ]);
});

test("环境偏好切换及刷新失败保持旧结果的环境，成功的新结果使用新快照", () => {
  const previousPreference = currentDataEnvironmentPreference();
  try {
    const oldResult = recordDailyDashboardEnvironment(result(), "production");
    const live = reading(oldResult);
    setDataEnvironmentPreference("test");
    expect(currentDataEnvironmentPreference()).toBe("test");
    live.state = { ...success(oldResult), refreshing: true };
    expect(metadataValue(live, "数据环境")).toBe("正式数据");
    expect(metadataValue(live, "当前状态")).toBe("刷新中，保留上次查询结果");
    live.state = { ...success(oldResult), refreshError: { code: "UPSTREAM_TIMEOUT", message: "内存刷新超时" } };
    expect(metadataValue(live, "数据环境")).toBe("正式数据");
    expect(metadataValue(live, "当前状态")).toBe("刷新失败，保留上次查询结果");
    expect(live.state.data).toBe(oldResult);

    const newResult = recordDailyDashboardEnvironment(result([0, null, 9]), "test");
    live.state = success(newResult);
    setDataEnvironmentPreference("production");
    expect(metadataValue(live, "数据环境")).toBe("测试数据");
    expect(dailyDashboardEnvironment(oldResult)).toBe("production");
  } finally {
    setDataEnvironmentPreference(previousPreference);
  }
});

test("当前期、对比期及日值基准使用各自的结果快照", () => {
  const live = threePeriods();
  expect(liveExportEnvironmentRows(live)).toEqual([
    ["数据环境", "测试数据"], ["对比数据环境", "正式数据"], ["日值基准数据环境", "测试数据"]
  ]);
  const newReference = recordDailyDashboardEnvironment(result([4], "2026-10-03"), "production");
  live.dayReference = { query: newReference.data.query, state: success(newReference) };
  expect(liveExportEnvironmentRows(live)).toEqual([
    ["数据环境", "测试数据"], ["对比数据环境", "正式数据"], ["日值基准数据环境", "正式数据"]
  ]);
  if (live.comparison?.state.status !== "success" || !live.comparison.state.data) throw new Error("expected comparison result");
  live.comparison = { ...live.comparison, state: success(structuredClone(live.comparison.state.data)), dataEnvironment: undefined };
  expect(liveExportEnvironmentRows(live)).toEqual([
    ["数据环境", "测试数据"], ["对比数据环境", "环境未确认"], ["日值基准数据环境", "正式数据"]
  ]);
});

test("主查询与独立注册留存的对比期分别标注自身环境和日期", () => {
  const live = threePeriods();
  const cohortCurrent = recordDailyDashboardEnvironment(result([4, null, 6], "2026-10-04"), "production");
  const cohortComparison = recordDailyDashboardEnvironment(result([1, null, 2], "2026-10-01"), "test");
  const cohortLive = reading(cohortCurrent);
  cohortLive.dataEnvironment = dailyDashboardEnvironment(cohortCurrent);
  cohortLive.comparison = { label: "独立注册日对比", query: cohortComparison.data.query, state: success(cohortComparison),
    dataEnvironment: dailyDashboardEnvironment(cohortComparison) };
  const original = JSON.stringify([live, cohortLive]);
  const sheets = connectedTopicExportSheets(live, cohortLive, "overall");
  const metadata = sheets.find(sheet => sheet.name === "读取说明")!.rows;
  const value = (key: string) => metadata.find(row => row[0] === key)?.[1];

  expect(value("数据环境")).toBe("测试数据");
  expect(value("对比数据环境")).toBe("正式数据");
  expect(value("注册留存数据环境")).toBe("正式数据");
  expect(value("注册留存对比数据环境")).toBe("测试数据");
  expect(value("平台")).toBe("PH");
  expect(value("范围")).toBe("2026-10-10 至 2026-10-12");
  expect(value("注册日期")).toBe("2026-10-04 至 2026-10-06");
  expect(value("注册留存对比日期")).toBe("2026-10-01 至 2026-10-03");
  expect(sheets.some(sheet => sheet.name === "当前注册留存")).toBe(true);
  expect(sheets.some(sheet => sheet.name === "对比注册留存")).toBe(true);
  expect(JSON.stringify([live, cohortLive])).toBe(original);
});

test("真实维度投影复制响应后通过各期私有 fallback 保留环境和刷新状态", () => {
  const live = threePeriods();
  if (live.state.status !== "success") throw new Error("expected current result");
  live.state = { ...live.state, refreshing: true };
  if (live.comparison?.state.status !== "success") throw new Error("expected comparison result");
  live.comparison.state = { ...live.comparison.state, refreshError: { code: "UPSTREAM_TIMEOUT", message: "内存对比刷新超时" } };
  const sourceSnapshot = JSON.stringify([live.state.data, live.comparison.state.data, live.dayReference]);
  const projected = connectedDimensionReading(live, "M001");
  if (projected.state.status !== "success" || projected.comparison?.state.status !== "success" || projected.dayReference?.state.status !== "success") throw new Error("expected projected results");

  expect(projected.state.data).not.toBe(live.state.data);
  expect(projected.comparison.state.data).not.toBe(live.comparison.state.data);
  expect(projected.dayReference.state.data).not.toBe(live.dayReference!.state.status === "success" && live.dayReference!.state.data);
  expect(projected.metricIds).toEqual(["M001"]);
  expect(projected.state.data.data.series.map(series => series.metric.id)).toEqual(["M001"]);
  expect(projected.comparison.state.data?.data.series.map(series => series.metric.id)).toEqual(["M001"]);
  expect(projected.dayReference.state.data?.data.series.map(series => series.metric.id)).toEqual(["M001"]);
  expect(liveExportEnvironmentRows(projected)).toEqual(liveExportEnvironmentRows(live));
  expect(metadataValue(projected, "当前状态")).toBe("刷新中，保留上次查询结果");
  expect(metadataValue(projected, "对比状态")).toBe("刷新失败，保留上次查询结果");
  expect(JSON.stringify([live.state.data, live.comparison.state.data, live.dayReference])).toBe(sourceSnapshot);

  delete projected.dataEnvironment;
  projected.comparison.dataEnvironment = undefined;
  projected.dayReference.dataEnvironment = undefined;
  expect(liveExportEnvironmentRows(projected)).toEqual([
    ["数据环境", "环境未确认"], ["对比数据环境", "环境未确认"], ["日值基准数据环境", "环境未确认"]
  ]);
});

test("环境记录不改变公共响应，公共契约仍拒绝环境字段", () => {
  const data = result();
  const original = JSON.stringify(data);
  expect(recordDailyDashboardEnvironment(data, "test")).toBe(data);
  expect(JSON.stringify(data)).toBe(original);
  expect(dailyDashboardSuccessSchema.safeParse(data).success).toBe(true);
  expect(dailyDashboardSuccessSchema.safeParse({ ...data, dataEnvironment: "test" }).success).toBe(false);
  expect(dailyDashboardSuccessSchema.safeParse({ ...data, data: { ...data.data, dataEnvironment: "test" } }).success).toBe(false);
  expect(dailyDashboardSuccessSchema.safeParse({ ...data, data: { ...data.data, query: { ...data.data.query, dataEnvironment: "test" } } }).success).toBe(false);
  expect(JSON.stringify(data)).not.toContain("dataEnvironment");
});

test("导出元数据只含查询与结果说明，不序列化认证上下文", () => {
  const live = threePeriods();
  const privateContext = { authorization: "SYNTHETIC_AUTH_SENTINEL", cookie: "SYNTHETIC_COOKIE_SENTINEL", username: "SYNTHETIC_USER_SENTINEL", token: "SYNTHETIC_TOKEN_SENTINEL", baseUrl: "SYNTHETIC_URL_SENTINEL" };
  Object.assign(live, { privateRequest: privateContext });
  const metadata = liveExportMetadata(live);
  expect(metadata.map(row => row[0])).toEqual([
    "数据环境", "对比数据环境", "日值基准数据环境", "平台", "当前日期", "当前状态", "对比日期", "对比状态", "数据性质"
  ]);
  expect(metadataValue(live, "平台")).toBe("PH");
  expect(metadataValue(live, "当前日期")).toBe("2026-10-10 至 2026-10-12");
  for (const sentinel of Object.values(privateContext)) expect(JSON.stringify(metadata)).not.toContain(sentinel);
  expect(JSON.stringify(metadata)).not.toMatch(/authorization|cookie|username|token|baseUrl/i);
});

test("生成真实 XLSX 时保留各期环境、原始 0、空值和数值，不修改源数据", () => {
  const live = threePeriods();
  const original = JSON.stringify(live);
  const rows = connectedDimensionRows(live, [{ key: "overall", name: "总体", seriesId: "M001" }]);
  const detail = connectedDimensionSheet(live, "M001", "平台", "维度/明细", rows, true);
  const source: WorkbookSheet[] = [{ name: "导出说明", rows: liveExportMetadata(live) }, detail];
  const originalSheets = JSON.stringify(source);
  const prepared = prepareWorkbookSheets(source);
  const files = workbookTextFiles(buildPreviewWorkbook(prepared));
  const metadataXml = files.get("xl/worksheets/sheet1.xml")!;
  const detailXml = files.get("xl/worksheets/sheet2.xml")!;
  expect(metadataXml).toContain("数据环境");
  expect(metadataXml).toContain("对比数据环境");
  expect(metadataXml).toContain("日值基准数据环境");
  expect(metadataXml).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">测试数据</t></is></c>');
  expect(metadataXml).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">正式数据</t></is></c>');
  expect(metadataXml).toContain('<c r="B3" t="inlineStr"><is><t xml:space="preserve">测试数据</t></is></c>');

  const currentRows = detail.rows.filter(row => row[0] === "当前期");
  const comparisonRows = detail.rows.filter(row => row[0] === "对比期");
  expect(currentRows.map(row => row[5])).toEqual([0, null, 7]);
  expect(comparisonRows.map(row => row[5])).toEqual([3, null, 5]);
  for (const row of [...currentRows, ...comparisonRows]) {
    const ref = `F${detail.rows.indexOf(row) + 1}`;
    expect(detailXml).toContain(row[5] === null ? `<c r="${ref}"/>` : `<c r="${ref}"><v>${row[5]}</v></c>`);
  }
  expect(files.get("xl/workbook.xml")).toContain('name="维度·明细"');
  expect(files.get("xl/worksheets/sheet3.xml")).toContain("维度/明细");
  expect(JSON.stringify(live)).toBe(original);
  expect(JSON.stringify(source)).toBe(originalSheets);
});
