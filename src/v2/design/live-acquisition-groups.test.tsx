import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DailyAcquisitionGroupResult, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { ACQUISITION_GROUP_IDS, acquisitionGroupModel, acquisitionGroupWorkbook } from "./live-acquisition-groups";
import { acquisitionDownloadModel, acquisitionDownloadPoints, acquisitionDownloadWorkbook } from "./acquisition-download-source";
import { acquisitionDetailSource } from "./acquisition-detail-source";
import { DEFAULT_ACQUISITION_FILTERS, acquisitionMetric } from "./acquisition-preview-model";
import { DEFAULT_ACQUISITION_VIEW } from "./acquisition-view-state";
import { ChannelQuality } from "./ChannelQuality";
import { LiveAcquisitionMetricDetails, LiveAcquisitionMetricHint } from "./LiveAcquisitionDetails";
import { LiveDashboardContext } from "../features/dashboards/LiveDashboardContext";

function reading(dateRange: [string, string] = ["2020-01-01", "2020-01-02"]): LiveDashboardReading {
  const query = { boardId: "5.7", pid: "PH", dateRange };
  const status = () => ({ state: "returned" as const, scopeStatuses: [], generatedAt: "2026-10-09T00:00:00Z", watermark: "2020-01-02" });
  const dimension = (dimension: "channel" | "downloadPlatform"): DailyAcquisitionGroupResult => ({ dimension, completeness: "unknown", day: status(), summary: status(), groups: ["RAW-X", "raw-x", "special/a.b"].map((key, index) => ({ key, label: `不得使用的猜测名称${index}`, series: ACQUISITION_GROUP_IDS[dimension].map(id => {
    const ratio = !["M001", "M003"].includes(id), inputs = ratio ? [{ key: "numerator", name: "同渠道分子", unit: "IP" }, { key: "denominator", name: "同渠道分母", unit: "IP" }] : [{ key: "count", name: "实际次数", unit: "次" }];
    const point = (value: number) => ({ state: "available" as const, sourceStatus: "READY" as const, value, inputs: inputs.map((input, i) => ({ key: input.key, value: i ? 20 : 8 })), ruleVersion: "actual/v3" });
    return { metric: { id, name: acquisitionMetric(id).name, unit: ratio ? "%" : "次", definition: "实际分组定义", authorityVersion: "actual/v3", referenceMetricId: id, formula: ratio ? "同渠道分子 / 同渠道分母" : null, sourceNote: null, inputs },
      points: [...new Set(dateRange)].map((date, i) => ({ date, ...point(ratio ? .2 + i * .1 : i + index) })),
      summary: id === "M099" && dateRange[0] !== dateRange[1] ? { ...point(.6), state: "unsupported" as const, value: null, sourceStatus: undefined, ruleVersion: null, inputs: inputs.map(input => ({ key: input.key, value: null })) } : point(ratio ? .4 : 80 + index) };
  }) })) });
  const channel = dimension("channel"), downloadPlatform = dimension("downloadPlatform");
  const series = structuredClone(downloadPlatform.groups[0].series).map(({ summary: _, ...series }) => ({ ...series, points: series.points.map(({ ruleVersion: _, ...point }) => point), periodStatistics: { aggregationVersion: "daily-statistics/v1" as const, dateRange, dayCount: dateRange[0] === dateRange[1] ? 1 : 2, state: "available" as const, values: [{ kind: "period_sum" as const, value: 80 }], reason: null } }));
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v2", query, queryId: "dynamic-test", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.metrics"], series, acquisitionGroups: { channel, downloadPlatform } } };
  return { query, metricIds: ["M003"], state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", canExport: true, retry() {}, controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}
function payload(live: LiveDashboardReading) { if (live.state.status !== "success" || live.state.data.data.schemaVersion !== "day-dashboard/v2") throw Error("Expected v2 success"); return live.state.data.data; }
function groups(live: LiveDashboardReading, dimension: "channel" | "downloadPlatform" = "channel") { return payload(live).acquisitionGroups![dimension]; }
function model(live: LiveDashboardReading) { return acquisitionGroupModel(live, "channel"); }

test("动态渠道保留原键，不映射名称或合并大小写，区间只用服务端汇总", () => {
  const live = reading(), result = model(live);
  expect(result.rows.map(row => row.name)).toEqual(["RAW-X", "raw-x", "special/a.b"]);
  expect(result.ids).toEqual(["M001", "M003", "M005", "M006", "M007", "M099"]);
  expect(result.rows[0].current.M001.summary.value).toBe(80);
  expect(result.rows[0].current.M005.summary.value).toBe(.4);
  expect(result.rows[0].current.M099.summary).toMatchObject({ value: null, state: "区间汇总待支持" });
  expect(result.rows[0].current.M099.points.map(point => point.value)).toEqual([.2, .2 + .1]);
  expect(result.rows[0].current.M005.summary.inputs.map(input => input.value)).toEqual([8, 20]);
  const rows = acquisitionDetailSource("channel", DEFAULT_ACQUISITION_FILTERS, live).rows;
  expect(rows[0].values).toMatchObject({ M001: 80, M005: .4, M099: null });
  expect(rows[0].values).not.toHaveProperty("M008");
});

test("当前与对比按原始key匹配，缺少分组保持为空，两期独立失败", () => {
  const live = reading(), before = reading(["2019-12-30", "2019-12-31"]);
  groups(before).groups.reverse(); groups(before).groups[2].series[0].summary.value = 901;
  groups(before).groups[1].key = "baseline-only";
  live.comparison = { label: "上一等长周期", query: before.query, state: before.state };
  let result = model(live);
  expect(result.rows.find(row => row.key === "RAW-X")!.previous!.M001.summary.value).toBe(901);
  expect(result.rows.find(row => row.key === "raw-x")!.previous!.M001.summary).toMatchObject({ value: null, state: "本期未返回该分组" });
  expect(result.rows.find(row => row.key === "baseline-only")!.current.M001.summary.value).toBeNull();
  groups(before).summary.state = "source_failure";
  result = model(live);
  expect(result.rows[0].current.M001.summary.value).toBe(80);
  expect(result.rows[0].previous!.M001.summary).toMatchObject({ value: null, state: "读取失败" });
});

test("缺日、重复日期、重复组或指标、非法值不投影随附数值", () => {
  const live = reading(), series = groups(live).groups[0].series[0];
  series.points.reverse(); expect(model(live).rows[0].current.M001.points.map(point => point.value)).toEqual([0, 1]);
  series.points.pop(); expect(model(live).rows[0].current.M001.points[0]).toMatchObject({ value: null, state: "当日未返回" });
  series.points.push(structuredClone(series.points[0])); expect(model(live).rows[0].current.M001.points[1]).toMatchObject({ value: null, state: "数据异常" });
  // Daily availability cannot manufacture or erase the separately returned period summary.
  expect(model(live).rows[0].current.M001.summary.value).toBe(80);
  for (const value of [-1, NaN, Infinity]) { const live = reading(); groups(live).groups[0].series[0].summary.value = value; expect(model(live).rows[0].current.M001.summary).toMatchObject({ value: null, state: "数据异常" }); }
  groups(live).groups[0].series.push(structuredClone(series)); expect(model(live).rows[0].current.M001.summary.value).toBeNull();
  const duplicate = reading(); groups(duplicate).groups.push(structuredClone(groups(duplicate).groups[0])); expect(model(duplicate).rows[0].current.M001.summary).toMatchObject({ value: null, state: "数据异常" });
});

test("请求状态、scope状态及非READY严格隔离，实际输入不泄漏", () => {
  for (const status of ["PROCESSING", "NOT_MATURE", "SOURCE_INCOMPLETE", "FAILED"] as const) {
    const live = reading(), group = groups(live); group.summary.scopeStatuses.push({ metricId: "M001", sourceStatus: status });
    expect(model(live).rows[0].current.M001.summary.value).toBeNull();
    expect(model(live).rows[0].current.M001.summary.inputs.every(input => input.value === null)).toBe(true);
    expect(model(live).rows[0].current.M003.summary.value).toBe(80);
    group.groups[0].series[1].points[0].sourceStatus = status;
    expect(model(live).rows[0].current.M003.points[0].value).toBeNull();
  }
  for (const state of ["source_failure", "invalid_response", "empty"] as const) {
    const live = reading(); groups(live).day.state = state;
    expect(model(live).rows[0].current.M001.points.every(point => point.value === null)).toBe(true);
    expect(model(live).rows[0].current.M001.summary.value).toBe(80);
    groups(live).summary.state = state;
    expect(model(live).rows[0].current.M001.summary.value).toBeNull();
  }
});

test("加载、范围placeholder、PID和board不匹配不会误报真实空组；旧响应无扩展待接入", () => {
  const loading = reading(); loading.state = { status: "loading" };
  expect(model(loading)).toMatchObject({ unavailableReason: "读取中", emptyReason: "读取中", rows: [] });
  for (const query of [{ dateRange: ["2020-01-01", "2020-01-01"] }, { pid: "other" }, { boardId: "5.8" }]) {
    const live = reading(); Object.assign(payload(live).query, query); live.query = { boardId: "5.7", pid: "PH", dateRange: ["2020-01-01", "2020-01-02"] };
    expect(model(live)).toMatchObject({ unavailableReason: "查询范围不匹配", rows: [] });
  }
  const legacy = reading(); delete payload(legacy).acquisitionGroups;
  expect(model(legacy).unavailableReason).toContain("维度待接入");
  const empty = reading(); groups(empty).groups = []; groups(empty).day.state = "empty"; groups(empty).summary.state = "empty";
  expect(model(empty).emptyReason).toContain("本期未返回分组记录");
  const failure = reading(); groups(failure).groups = []; groups(failure).day.state = "source_failure"; groups(failure).summary.state = "source_failure";
  expect(model(failure).emptyReason).toContain("读取失败");
});

test("全范围非READY即使未返回分组也保留来源状态与业务日期，READY零分母保留实际输入", () => {
  const live = reading(), group = groups(live); group.groups = [];
  group.day.scopeStatuses = [{ metricId: "M003", sourceStatus: "PROCESSING", businessDate: "2020-01-01" }];
  group.summary.scopeStatuses = [{ metricId: "M001", sourceStatus: "SOURCE_INCOMPLETE" }, { metricId: "M005", sourceStatus: "NOT_MATURE" }];
  for (const status of ["2020-01-01", "计算中", "数据接入中", "待成熟"]) expect(model(live).emptyReason).toContain(status);
  expect(model(live).emptyReason).not.toContain("未返回分组结果");
  const zero = reading(), series = groups(zero).groups[0].series.find(series => series.metric.id === "M005")!;
  series.summary = { ...series.summary, state: "zero_denominator", value: null, inputs: series.summary.inputs.map(input => ({ ...input, value: 0 })) };
  expect(model(zero).rows[0].current.M005.summary).toMatchObject({ value: null, state: "分母为0", inputs: [{ key: "numerator", value: 0 }, { key: "denominator", value: 0 }] });
  expect(acquisitionGroupWorkbook(zero, "channel")[1].rows.find(row => row[4] === acquisitionMetric("M005").name)?.[7]).toContain("同渠道分母：0 IP");
  series.summary.sourceStatus = "PROCESSING";
  expect(model(zero).rows[0].current.M005.summary.inputs.every(input => input.value === null)).toBe(true);
});

test("下载目标仅M003；图表、明细和导出共用汇总和逐日值，不计算份额或其他", () => {
  const live = reading(), download = acquisitionDownloadModel(live, "count"), detail = acquisitionDetailSource("target", DEFAULT_ACQUISITION_FILTERS, live);
  expect(download.items.map(item => item.value)).toEqual(detail.rows.map(row => row.values.M003));
  expect(download).toMatchObject({ available: false, total: null });
  expect(download.groups.map(group => group.label)).toEqual(["RAW-X", "raw-x", "special/a.b"]);
  expect(download.groups.map(group => download.points[0].values[group.id])).toEqual([0, 1, 2]);
  expect(download.points.every(point => point.shares === undefined)).toBe(true);
  expect(acquisitionDownloadPoints(live, "share").every(point => point.overall === null && Object.values(point.values).every(value => value === null))).toBe(true);
  expect(detail.groups?.ids).toEqual(["M003"]);
  const exportRows = acquisitionDownloadWorkbook(live)[2].rows;
  expect(exportRows.slice(1).map(row => row[5])).toEqual(download.items.map(item => item.value));
  expect(JSON.stringify(exportRows)).not.toContain("M008");
  expect(JSON.stringify(exportRows)).not.toContain("不得使用的猜测名称");
});

test("下载动态图保留原始键对应关系，保留字不冒充总体，比较不依赖分组顺序", () => {
  const live = reading(), before = reading(["2019-12-30", "2019-12-31"]);
  groups(live, "downloadPlatform").groups[0].key = "__overall";
  groups(before, "downloadPlatform").groups[0].key = "__overall";
  groups(before, "downloadPlatform").groups.reverse();
  groups(before, "downloadPlatform").groups[2].series[0].points[0].value = 999;
  live.comparison = { label: "上一等长周期", query: before.query, state: before.state };
  const download = acquisitionDownloadModel(live, "count"), reserved = download.groups.find(group => group.label === "__overall")!;
  expect(reserved.id).not.toBe("__overall");
  expect(download.points[0].overall).toBe(0);
  expect(download.points[0].comparison?.values[reserved.id]).toBe(999);
  expect(download.points[0].comparison?.date).toBe("2019-12-30");
  expect(acquisitionDownloadWorkbook(live)[2].rows.some(row => row[3] === "__overall")).toBe(true);
});

test("单日去重比率可读后端summary；区间不退回逐日值", () => {
  const live = reading(["2020-01-01", "2020-01-01"]);
  expect(model(live).rows[0].current.M099.summary.value).toBe(.4);
  groups(live).summary.state = "source_failure";
  expect(model(live).rows[0].current.M099.summary.value).toBeNull();
  expect(model(live).rows[0].current.M099.points[0].value).toBe(.2);
});

test("动态分组呈现在现有目标表与下载图中，目标不显示注册和IP指标", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: new URL("http://localhost/dashboards/public?board=5.7") } });
  try {
    const { AcquisitionDetailSection } = await import("./AcquisitionPreview"), { AcquisitionVisuals } = await import("./AcquisitionVisuals"), live = reading();
    const target = renderToStaticMarkup(<LiveDashboardContext.Provider value={live}><AcquisitionDetailSection dimension="target" filters={DEFAULT_ACQUISITION_FILTERS} comparisonEnabled={false} mixed={true} open={() => {}} detail={DEFAULT_ACQUISITION_VIEW.detail.sections.target} update={() => {}} onExport={() => {}} pending={false} /></LiveDashboardContext.Provider>);
    for (const text of ["RAW-X", "80", "排序落地页下载点击次数", "导出下载目标"]) expect(target).toContain(text);
    for (const text of ["排序新增用户数", "排序落地页访问次数", "排序落地页访问-下载点击转化率（去重）", "演示数据", "不得使用的猜测名称"]) expect(target).not.toContain(text);
    const html = renderToStaticMarkup(<LiveDashboardContext.Provider value={live}><AcquisitionVisuals filters={DEFAULT_ACQUISITION_FILTERS} mixed={false} pending={false} onOpen={() => {}} onLocate={() => {}} /></LiveDashboardContext.Provider>);
    const download = html.slice(0, html.indexOf('aria-label="落地页转化诊断"'));
    for (const text of ["下载目标构成", "RAW-X", "80 次", "下载趋势数值", "分目标下载展示范围", "总体", "分组对比", "分组全量性待确认"]) expect(download).toContain(text);
    expect(download).not.toContain("100.00%"); expect(download).not.toContain("演示数据");
  } finally { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); }
});

test("渠道控件结构保留，按首个兼容列排序，未支持三组不生成成熟批次", () => {
  const live = reading(), result = model(live);
  const render = (qualityGroup: string) => renderToStaticMarkup(<ChannelQuality filters={DEFAULT_ACQUISITION_FILTERS} mixed detail={{ ...DEFAULT_ACQUISITION_VIEW.detail.sections.channel, qualityGroup }} pending={false} update={() => {}} open={() => {}} liveModel={result} exportControl={<button>导出</button>} />);
  const scale = render("scale");
  for (const text of ["按落地页访问次数降序", "RAW-X", "raw-x", "首次体验", "注册留存", "付费价值", "完整明细"]) expect(scale).toContain(text);
  expect(scale).not.toContain("排序新增用户数"); expect(scale).not.toContain("成熟 0"); expect(scale).not.toContain("演示");
  for (const group of ["experience", "retention", "value"]) { const html = render(group); expect(html).toContain("渠道指标待支持"); expect(html).not.toContain("RAW-X"); expect(html).not.toContain("成熟"); expect(html).not.toContain("USD"); }
});

test("逐日详情和导出保留真实日期、输入、规则版本及刷新失败标记", () => {
  const live = reading(); if (live.state.status === "success") live.state.refreshError = { code: "FAILED", message: "failed" };
  const result = model(live), html = renderToStaticMarkup(<LiveAcquisitionMetricDetails row={result.rows[0]} id="M005" />);
  for (const text of ["2020-01-01", "40.00%", "同渠道分子", "actual/v3", "刷新失败，保留上次查询结果"]) expect(html).toContain(text);
  const summary = acquisitionGroupWorkbook(live, "channel")[1].rows.find(row => row[4] === acquisitionMetric("M005").name)!;
  expect(summary[5]).toBe(.4); expect(summary[9]).toBe("actual/v3"); expect(summary[12]).toContain("刷新失败");
});

test("动态渠道和下载目标悬停仅用紧凑读数，完整表格和导出留在点击详情", () => {
  const live = reading(), before = reading(["2019-12-30", "2019-12-31"]);
  live.comparison = { label: "上一等长周期", query: before.query, state: before.state };
  for (const dimension of ["channel", "downloadPlatform"] as const) {
    const row = acquisitionGroupModel(live, dimension).rows[0];
    const tooltip = renderToStaticMarkup(<LiveAcquisitionMetricHint row={row} id="M003" />);
    for (const text of ["当前期", "对比期", "80 次", "2020-01-01", "2019-12-30", "点击查看汇总和逐日依据"]) expect(tooltip).toContain(text);
    for (const element of ["<table", "<button", "<section", "<div", "导出", "channel-quality__reading"]) expect(tooltip).not.toContain(element);
    const details = renderToStaticMarkup(<LiveAcquisitionMetricDetails row={row} id="M003" exportAction={<button>导出明细</button>} />);
    for (const text of ["<table", "分组指标逐日依据", "导出明细", "actual/v3"]) expect(details).toContain(text);
  }
});
