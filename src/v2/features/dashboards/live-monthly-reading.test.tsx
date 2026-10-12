import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { DailyDashboardService } from "../../../../server/v2/daily-dashboard.service";
import { liveMonthlySeriesRows } from "./live-monthly-reading";
import { liveMetricModel, liveDailyReferenceRows, type LiveDashboardReading } from "./LiveDashboardContext";
import { LiveSeriesDetails, LiveSeriesExport } from "./ConnectedMetricCard";
import type { DashboardMetricCardModel } from "./dashboard-metric-card-model";
import { operatingLiveRows, operatingLiveColumns, operatingLiveExportRows, operatingLiveCalculationRows } from "../../design/operating-live-model";
import { DETAIL_COLUMNS } from "../../design/operating-detail-columns";
import { operatingValueLabel } from "../../design/operating-detail-snapshot";
import { DetailedMetricTrend } from "./DetailedMetricTrend";

const original: DashboardMetricCardModel = { metric: { id: "M018", name: "月活跃用户数", definitionLabel: "自然月独立去重", aggregationLabel: "" }, result: { status: "no_values", contextLabel: "", retryable: false } };
async function snapshot(range: DailyDashboardQuery["dateRange"], now = "2026-10-12T00:00:00Z", values: Record<string, number | null> = {}) {
  const calls: Record<string, string>[] = [];
  const result = await new DailyDashboardService({ get: async (path, params) => {
    if (path === "/api/admin/bi/v1/metrics" || path === "/api/admin/bi/v1/playback/counts") {
      const monthly = params.metricCodes === "M018";
      if (monthly) calls.push(params);
      const value = Object.hasOwn(values, params.startDate.slice(0, 7)) ? values[params.startDate.slice(0, 7)] : 9;
      return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: now, watermark: null, rows: monthly && value !== null ? [
        { metricCode: "M018", dimensions: { pid: "PH" }, value, numerator: value, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "monthly-fixture" }
      ] : [] } };
    }
    return { code: 200, msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
  } }, () => new Date(now)).execute({ boardId: "5.8", pid: "PH", dateRange: range });
  return { result, calls, series: result.data.series.find(series => series.metric.id === "M018")! };
}
function live(result: DailyDashboardSuccess, previous?: DailyDashboardSuccess): LiveDashboardReading {
  return { query: result.data.query, metricIds: ["M018"], state: { status: "success", data: result, refreshing: false, refreshError: null },
    platformName: "PH", retry() {}, canExport: true,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} },
    ...(previous ? { comparison: { label: "环比上期", query: previous.data.query, state: { status: "success" as const, data: previous, refreshing: false, refreshError: null } } } : {}) };
}
function available(reading: LiveDashboardReading) {
  const model = liveMetricModel(original, reading);
  if (model.result.status !== "available") throw new Error(`expected available: ${model.result.status}`);
  return { model, result: model.result };
}

test("历史月中查询使用整月月活，同月对比不生成日变化或日参考", async () => {
  const current = await snapshot(["2020-01-08", "2020-01-08"]), previous = await snapshot(["2020-01-07", "2020-01-07"]);
  expect(current.calls[0]).toMatchObject({ startDate: "2020-01-01", endDate: "2020-02-01", granularity: "summary" });
  expect(current.calls).toHaveLength(1);
  const reading = live(current.result, previous.result), { model, result } = available(reading);
  expect(model.metric.aggregationLabel).toContain("2020-01-01 至 2020-01-31");
  expect(result.reading?.primaryLabel).toBe("2020-01 自然月 · 2020-01-01 至 2020-01-31");
  expect(result.value).toMatchObject({ raw: 9, display: "9", unit: "人" });
  expect(result.comparison).toMatchObject({ status: "unavailable", label: "较上一自然月" });
  expect(result.trend.current).toHaveLength(1);
  expect(result.trend.current[0]).toMatchObject({ label: "2020-01", counterpart: null, differenceDisplay: null });
  expect(result.trend.comparison).toBeNull();
  expect(result.reading?.statistics).toEqual([]);
  expect(liveDailyReferenceRows(reading, ["M018"])).toEqual([]);
  expect(JSON.stringify(model)).not.toMatch(/较前一天|较上周同日|同口径日值/);
  expect(model.metric.aggregationLabel).not.toContain("业务日");
});

test("当前月截止复用执行快照北京时间而非所选日、浏览器当前日期或水位", async () => {
  const current = await snapshot(["2026-10-03", "2026-10-06"], "2026-10-11T16:01:00Z");
  const previous = await snapshot(["2026-09-03", "2026-09-06"], "2026-10-11T16:01:00Z");
  expect(current.calls[0]).toMatchObject({ startDate: "2026-10-01", endDate: "2026-10-12" });
  const { result } = available(live(current.result, previous.result));
  expect(result.reading?.primaryLabel).toContain("2026-10-01 至 2026-10-11");
  expect(result.comparison).toMatchObject({ status: "unavailable", detail: "当前月查询尚未覆盖整月，未返回上月相同自然日进度的独立结果。" });
  expect(result.completeness).toBe("unknown");
  expect(result.watermarkLabel).toBe("");
  expect(current.result.data.watermark).toBeNull();
  const beforeMidnight = await snapshot(["2026-10-03", "2026-10-06"], "2026-10-11T15:59:00Z");
  expect(liveMonthlySeriesRows(beforeMidnight.series, beforeMidnight.result)[0].scope.queryEnd).toBe("2026-10-10");
});

test("跨年闰月仅一月一点，不将锚点之外日期当缺失日趋势", async () => {
  const fixture = await snapshot(["2019-12-20", "2020-03-04"]);
  const rows = liveMonthlySeriesRows(fixture.series, fixture.result);
  expect(rows.map(row => [row.scope.anchor, row.scope.queryEnd])).toEqual([
    ["2019-12-31", "2019-12-31"], ["2020-01-31", "2020-01-31"], ["2020-02-29", "2020-02-29"], ["2020-03-04", "2020-03-31"]
  ]);
  const { result } = available(live(fixture.result));
  expect(result.trend.current.map(point => point.label)).toEqual(["2019-12", "2020-01", "2020-02", "2020-03"]);
  expect(result.reading?.primaryLabel).toContain("2020-03-01 至 2020-03-31");
  expect(result.comparison).toBeNull();
});

test("已有独立上一完整自然月时按月比较，不额外发请求", async () => {
  const current = await snapshot(["2020-02-08", "2020-02-08"], undefined, { "2020-02": 12 });
  const previous = await snapshot(["2020-01-08", "2020-01-08"], undefined, { "2020-01": 8 });
  const { result } = available(live(current.result, previous.result));
  expect(result.comparison).toMatchObject({ status: "available", display: "+50.00%", label: "较上一自然月" });
  expect(result.comparison?.detail).toContain("2020-02-01 至 2020-02-29");
  expect(result.comparison?.detail).toContain("2020-01-01 至 2020-01-31");
  expect(result.trend.current[0].differenceDisplay).toBe("+4 人");
  expect(current.calls).toHaveLength(1); expect(previous.calls).toHaveLength(1);
});

test("独立历史快照与当前月进度相同时允许合法比较，保留旧结果提示", async () => {
  const current = await snapshot(["2026-10-05", "2026-10-05"], "2026-10-12T00:00:00Z", { "2026-10": 12 });
  const previous = await snapshot(["2026-09-05", "2026-09-05"], "2026-09-12T00:00:00Z", { "2026-09": 8 });
  const reading = live(current.result, previous.result);
  if (reading.comparison?.state.status === "success") reading.comparison.state.refreshError = "刷新失败";
  expect(available(reading).result.comparison).toMatchObject({ status: "available", notice: "对比期刷新失败，使用上次查询基准" });
});

test("月活真实0、基准0、来源空态与未结束业务日各自保留", async () => {
  const zero = await snapshot(["2020-02-08", "2020-02-08"], undefined, { "2020-02": 0 });
  const previous = await snapshot(["2020-01-08", "2020-01-08"], undefined, { "2020-01": 0 });
  const { result } = available(live(zero.result, previous.result));
  expect(result.value.raw).toBe(0);
  expect(result.comparison).toMatchObject({ status: "unavailable", detail: "上一自然月基准为0，无法计算相对变化。" });
  const missing = await snapshot(["2020-01-30", "2020-02-08"], undefined, { "2020-02": null });
  const card = liveMetricModel(original, live(missing.result));
  expect(card.result).toMatchObject({ status: "no_records", label: "本月未返回记录" });
  expect(card.result.status !== "available" && card.result.history?.trend.current.map(point => point.value?.raw ?? null)).toEqual([9, null]);
  const allMissing = await snapshot(["2020-02-08", "2020-02-08"], undefined, { "2020-02": null });
  expect(liveMetricModel(original, live(allMissing.result)).result).toMatchObject({ status: "no_records", label: "本月未返回记录", contextLabel: "2020-02 自然月 · 2020-02-01 至 2020-02-29" });
  const future = await snapshot(["2026-10-12", "2026-10-12"]);
  expect(future.calls).toHaveLength(0);
  expect(liveMonthlySeriesRows(future.series, future.result)[0].scope).toMatchObject({ queryStart: null, queryEnd: null });
  expect(liveMetricModel(original, live(future.result)).result.reading?.primaryLabel).toContain("尚无已结束业务日");
});

test("月活详情和单卡CSV使用相同自然月投影，不导出日比较或伪每日空值", async () => {
  const fixture = await snapshot(["2020-01-12", "2020-01-17"]), previous = await snapshot(["2020-01-06", "2020-01-11"]);
  const html = renderToStaticMarkup(<LiveSeriesDetails series={fixture.series} result={fixture.result}/>);
  expect(html).toContain("自然月与实际查询范围");
  expect(html).toContain("2020-01-01 至 2020-01-31");
  expect(html).toContain("数据水位未返回");
  expect(html).not.toMatch(/每日数据|逐日结果|主值为所选结束日期|2020-01-1[2-7]<\/td>/);
  const table = renderToStaticMarkup(<DetailedMetricTrend model={available(live(fixture.result)).model} view="table" onOpenPoint={() => {}} exportAction={<button>导出</button>}/>);
  expect(table).toContain("月活跃用户数自然月数据");
  expect(table).toContain("2020-01-01 至 2020-01-31");
  expect(table).not.toContain("逐日");
  let blob: Blob | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const url = spyOn(URL, "createObjectURL").mockImplementation(value => { blob = value as Blob; return "blob:test"; });
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(() => 0 as unknown as ReturnType<typeof setTimeout>);
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ click() {}, remove() {} }), querySelector: () => null, body: { appendChild() {} } } });
  try {
    LiveSeriesExport({ series: fixture.series, result: fixture.result, comparison: previous.result }).props.onClick();
    const csv = await blob!.text();
    expect(csv.split("\r\n")).toHaveLength(3);
    expect(csv).toContain("自然月与实际查询范围（非数据水位）");
    expect(csv).toContain("不可比：对比结果不是独立的上一自然月");
    expect(csv).not.toMatch(/较前一天|较上周同日|当日未返回记录/);
  } finally {
    url.mockRestore(); timer.mockRestore();
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("经营93列跨月月活不把上月锚点当昨日，单元格和导出共用自然月证据", async () => {
  const fixture = await snapshot(["2019-12-25", "2020-01-01"], undefined, { "2019-12": 4, "2020-01": 9 });
  const daily = fixture.result.data.series.find(series => series.metric.id === "M016")!;
  daily.points = daily.points.map((point, index) => ({ ...point, state: "available", sourceStatus: "READY", value: index + 1, inputs: point.inputs.map(input => ({ ...input, value: index + 1 })) }));
  const reading = live(fixture.result); reading.metricIds = ["M018", "M016"];
  const columns = operatingLiveColumns(reading), rows = operatingLiveRows(reading, { PH: reading.state });
  const index = DETAIL_COLUMNS.findIndex(column => column.metric.id === "M018"), value = rows[0].values[index];
  expect(columns).toHaveLength(93); expect(rows[0].values).toHaveLength(93);
  expect(value).toMatchObject({ current: 9, previousDay: null, previousWeek: null });
  expect(value.evidence?.current.date).toBe("2020-01 自然月 · 2020-01-01 至 2020-01-31");
  expect(value.evidence?.current.sourceNote).toContain("不是来源数据水位");
  expect(operatingValueLabel(value, columns[index], "previousDay")).toBe("不适用日比较");
  expect(rows[0].values[0]).toMatchObject({ current: 8, previousDay: 7, previousWeek: 1 });
  const exported = operatingLiveExportRows(rows, columns, "2020-01-01"), offset = 3 + index * 9;
  expect(exported[0][offset]).toBe("月活跃用户数｜所属自然月（人）");
  expect(exported[1].slice(offset, offset + 9)).toEqual([9, "待验数 · 已返回", fixture.result.data.fetchedAt, null, "待验数 · 不适用日比较", null, null, "待验数 · 不适用日比较", null]);
  expect(exported[1][exported[0].indexOf("月活跃用户数｜自然月实际查询范围（非数据水位）")]).toBe(value.evidence?.current.date);
  const calculations = operatingLiveCalculationRows(rows, columns).filter(row => row[3] === "M018:overall");
  expect(calculations).toHaveLength(1);
  expect(calculations[0].slice(4, 6)).toEqual(["所属自然月", value.evidence?.current.date]);
});

test("迷你月趋势SSR保留完整年月，普通日轴仍简写月日", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.8") } });
  try {
    const { DashboardMetricCard } = await import("./DashboardMetricCard");
    const fixture = await snapshot(["2020-02-08", "2020-02-08"]);
    const model = available(live(fixture.result)).model;
    const html = (card: DashboardMetricCardModel) => renderToStaticMarkup(<DashboardMetricCard model={card} variant="compact" analysisHref="#" onOpenDefinition={() => {}} onOpenComparison={() => {}} onOpenTrendPoint={() => {}}/>);
    const axis = html(model).match(/class="dashboard-mini-trend__x-axis"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    expect(axis).toContain(">2020-02</span>");
    expect(axis).not.toContain(">20-02</span>");
    if (model.result.status !== "available") throw new Error("expected monthly value");
    const daily: DashboardMetricCardModel = { ...model, metric: { ...model.metric, id: "M016" }, result: { ...model.result, trend: { ...model.result.trend, current: model.result.trend.current.map(point => ({ ...point, actualDate: "2020-02-08", label: "02-08" })) } } };
    expect(html(daily).match(/class="dashboard-mini-trend__x-axis"[^>]*>([\s\S]*?)<\/div>/)?.[1]).toContain(">02-08</span>");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window");
  }
});
