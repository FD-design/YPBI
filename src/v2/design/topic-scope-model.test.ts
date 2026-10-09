import { expect, test } from "bun:test";
import { DEFAULT_TOPIC_READING, DEFAULT_TOPIC_SCOPE, DEFAULT_TOPIC_VIEW, parseTopicView } from "./topic-preview-view";
import { topicCard, topicDailyCard, datesIn } from "./topic-preview-fixtures";
import { topicScopeCells, topicScopeExport, topicScopeModel, topicLiveScopeId } from "./topic-scope-model";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";

test("二维读数、摘要与原总体同源；比率按同范围分子分母计算", () => {
  for (const id of ["M016", "M026", "M101", "M102", "M081", "M036"]) {
    const cells = topicScopeCells(id, DEFAULT_TOPIC_VIEW);
    expect(cells).toHaveLength(12);
    const overall = cells[0].model.result, original = topicCard(id, DEFAULT_TOPIC_VIEW.active, false).result;
    expect(overall.status === "available" && overall.value.raw).toBe(original.status === "available" && original.value.raw);
    for (const {scope, model} of cells) {
      if (model.result.status !== "available") throw Error("missing fixture");
      const summary = model.result.value.raw, points = model.result.trend.current;
      expect(points).toHaveLength(7);
      if (id === "M016") expect(summary).toBe(points.at(-1)!.value!.raw);
      if (id === "M026") expect(summary).toBeCloseTo(points.reduce((n,p)=>n+p.value!.raw,0)/7,8);
      if (["M081","M036"].includes(id)) {
        const basis = model.result.calculation!;
        expect(summary).toBe(basis.numerator.value! / basis.denominator.value!);
        expect(summary).toBeLessThanOrEqual(1);
        expect(basis.scope).toContain(scope.client === "android" ? "Android" : scope.client === "ios" ? "iOS" : scope.client === "web" ? "Web" : "全部客户端");
        for (const p of points) expect(p.value!.raw).toBe(p.calculation!.numerator.value! / p.calculation!.denominator.value!);
      }
    }
  }
});

test("180天全量导出不随点选裁剪，待加工非零；固定留存人群口径不变", () => {
  const view = {...DEFAULT_TOPIC_VIEW,active:{start:"2026-03-13",end:"2026-09-08"},compared:true,mixed:true};
  const cells = topicScopeCells("M101",view), rows = topicScopeExport("M101",view);
  expect(rows).toHaveLength(1+12*(datesIn(view.active).length+1));
  expect(rows.every(row=>row.length===rows[0].length)).toBe(true);
  for (const cell of cells) {
    expect(cell.model.result.status).toBe("available");
    if(cell.model.result.status!=="available")continue;
    expect(cell.model.result.trend.current.find(p=>p.actualDate==="2026-09-04")!.value).toBeNull();
    expect(cell.model.result.comparison?.status).toBe("unavailable");
  }
  for(const id of ["M020","M024"])expect(topicCard(id,DEFAULT_TOPIC_VIEW.active,false).metric.aggregationLabel).not.toContain("Android");
});

test("真实接口只读独立范围；单维存在不代表交叉存在，也不回填演示", () => {
  const live = {metricIds:["M016","M016.android","M016.new"],query:{pid:"test",dateRange:["2026-09-02","2026-09-08"]},state:{status:"failure",message:"来源失败"}} as unknown as LiveDashboardReading;
  expect(topicLiveScopeId("M016",{client:"android",audience:"new"})).toBe("M016.androidNew");
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,DEFAULT_TOPIC_SCOPE,live).result.status).toBe("failed");
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,{client:"android",audience:"new"},live).result.status).toBe("not_ready");
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,{client:"ios",audience:"overall"},live).result.status).toBe("not_ready");
  const rows=topicScopeExport("M016",{...DEFAULT_TOPIC_VIEW,compared:true},live);
  expect(rows.every(row=>row.length===rows[0].length)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("194,319");
});

test("消费结构复用M036三端独立结果，详情导出保留基数且不推新老交叉", () => {
  const query = { boardId: "5.9", pid: "PH", dateRange: ["2020-01-01", "2020-01-01"] as [string, string] };
  const data: DailyDashboardSuccess = { success: true, data: { schemaVersion: "day-dashboard/v1", query, queryId: "watch-platform-fixture", fetchedAt: "2026-10-09T00:00:00Z", timezone: "Asia/Shanghai", validationStatus: "pending_validation", completeness: "unknown", watermark: null, sourceApiIds: ["bi-v1.playback"],
    series: [["M036", 7, 8], ["M036.android", 2, 2], ["M036.ios", 2, 2], ["M036.web", 3, 4]].map(([id, numerator, denominator]) => ({
      metric: { id: String(id), name: "有效观影率", referenceMetricId: "M036", authorityVersion: "fixture", unit: "%", definition: "同平台有效观看次数占起播次数比例", formula: "有效观看次数 ÷ 起播次数 × 100%", sourceNote: "同客户端独立结果", inputs: [{ key: "effective", name: "有效观看次数", unit: "次" }, { key: "started", name: "起播次数", unit: "次" }] },
      points: [{ date: query.dateRange[1], value: Number(numerator) / Number(denominator), state: "available", sourceStatus: "READY", inputs: [{ key: "effective", value: Number(numerator) }, { key: "started", value: Number(denominator) }] }]
    })) } };
  const live = { query, metricIds: data.data.series.map(item => item.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "PH", controls: { dirty: false } } as LiveDashboardReading;
  for (const [client, expected, numerator, denominator] of [["android", 1, 2, 2], ["ios", 1, 2, 2], ["web", .75, 3, 4]] as const) {
    const model = topicScopeModel("M036", DEFAULT_TOPIC_VIEW, { client, audience: "overall" }, live);
    expect(model.result.status).toBe("available");
    if (model.result.status !== "available") throw new Error("missing independent client reading");
    expect(model.result.value.raw).toBe(expected);
    expect(model.result.calculation).toMatchObject({ numerator: { value: numerator }, denominator: { value: denominator } });
    expect(model.result.trend.current[0].value?.raw).toBe(expected);
    expect(topicScopeModel("M036", DEFAULT_TOPIC_VIEW, { client, audience: "new" }, live).result.status).toBe("not_ready");
    expect(topicScopeModel("M036", DEFAULT_TOPIC_VIEW, { client, audience: "existing" }, live).result.status).toBe("not_ready");
  }
  const exported = topicScopeExport("M036", DEFAULT_TOPIC_VIEW, live);
  expect(exported.some(row => row[0] === "Web" && row[1] === "总体" && row[3] === "摘要" && row[5] === 75)).toBe(true);
  data.data.series[3].points[0] = { ...data.data.series[3].points[0], value: null, state: "source_failure", sourceStatus: "FAILED" };
  expect(topicScopeModel("M036", DEFAULT_TOPIC_VIEW, { client: "web", audience: "overall" }, live).result.status).toBe("failed");
  expect(topicScopeModel("M036", DEFAULT_TOPIC_VIEW, { client: "android", audience: "overall" }, live).result.status).toBe("available");
});

test("活跃与消费共用 Android/iOS 新老用户独立交叉结果及来源状态", async () => {
  const date = "2026-09-08";
  const rows = ["M016", "M026", "M081"].flatMap(metricCode => ["android", "ios"].flatMap(clientPlatform => ["new", "old"].map(userCohort => {
    const numerator = userCohort === "new" ? 1 : 2;
    return { metricCode, businessDate: date, dimensions: { pid: "PH", clientPlatform, userCohort },
      value: metricCode === "M081" ? numerator / 3 : numerator, numerator, denominator: metricCode === "M081" ? 3 : 0,
      unit: metricCode === "M081" ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "first-batch-v1" };
  })));
  const service = new DailyDashboardService({ get: async (path, params) => {
    if (path !== "/api/admin/bi/v1/metrics") return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    const filters = JSON.parse(String(params?.dimensionFilters ?? "{}"));
    return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: null,
      rows: rows.filter(row => String(params?.metricCodes).split(",").includes(row.metricCode)
        && filters.clientPlatform === row.dimensions.clientPlatform && filters.userCohort === row.dimensions.userCohort) } };
  } });
  for (const id of ["M016", "M026", "M081"]) {
    const data = await service.execute({ boardId: id === "M016" ? "5.8" : "5.9", pid: "PH", dateRange: [date, date] });
    const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "测试", controls: { dirty: false } } as LiveDashboardReading;
    for (const client of ["android", "ios"] as const) for (const audience of ["new", "existing"] as const) {
      const scope = { client, audience };
      const sourceId = `${id}.${client}${audience === "existing" ? "Old" : "New"}`;
      const numerator = audience === "new" ? 1 : 2;
      const value = id === "M081" ? numerator / 3 : numerator;
      expect(topicLiveScopeId(id, scope)).toBe(sourceId);
      const result = topicScopeModel(id, DEFAULT_TOPIC_VIEW, scope, live).result;
      expect(result.status).toBe("available");
      if (result.status !== "available") throw Error("交叉结果未接入");
      expect(result.value.raw).toBe(value);
      if (id === "M081") expect(result.calculation).toMatchObject({ numerator: { value: numerator }, denominator: { value: 3 } });
      const exported = topicScopeExport(id, DEFAULT_TOPIC_VIEW, live);
      expect(exported.some(row => row[0] === (client === "android" ? "Android" : "iOS") && row[1] === (audience === "new" ? "新用户" : "老用户") && row[3] === "摘要" && row[5] === (id === "M081" ? value * 100 : value))).toBe(true);
      const series = data.data.series.find(item => item.metric.id === sourceId)!;
      for (const [sourceStatus, state, status, label] of [
        ["PROCESSING", "no_value", "no_values", "计算中"],
        ["SOURCE_INCOMPLETE", "no_value", "no_values", "数据接入中"],
        ["NOT_MATURE", "immature", "no_values", "待成熟"],
        ["FAILED", "source_failure", "failed", "数据异常"]
      ] as const) {
        series.points[0] = { ...series.points[0], state, value: null, sourceStatus };
        expect(topicScopeModel(id, DEFAULT_TOPIC_VIEW, scope, live).result).toMatchObject({ status, label });
      }
    }
    expect(topicScopeModel(id, DEFAULT_TOPIC_VIEW, { client: "web", audience: "new" }, live).result.status).toBe("not_ready");
    expect(topicScopeModel(id, DEFAULT_TOPIC_VIEW, { client: "web", audience: "existing" }, live).result.status).toBe("not_ready");
  }
});

test("二维范围深链白名单及旧维度链接保留", () => {
  const input={...DEFAULT_TOPIC_VIEW,reading:{...DEFAULT_TOPIC_READING,dimension:"cross",scope:{client:"ios",audience:"existing"}}};
  expect(parseTopicView(JSON.stringify(input),"5.9")?.reading?.scope).toEqual(input.reading.scope);
  expect(parseTopicView(JSON.stringify({...input,reading:{...input.reading,scope:{client:"android",audience:"vip"}}}),"5.9")).toBeNull();
  for(const dimension of ["platform","users","cross"])expect(parseTopicView(JSON.stringify({...input,reading:{...DEFAULT_TOPIC_READING,structureId:"M016",dimension}}),"5.8")).not.toBeNull();
  const reactivation={...DEFAULT_TOPIC_VIEW,reading:{...DEFAULT_TOPIC_READING,structureId:"M016",reactivationWindow:48 as const}};
  expect(parseTopicView(JSON.stringify(reactivation),"5.8")?.reading?.reactivationWindow).toBe(48);
  expect(parseTopicView(JSON.stringify({...reactivation,reading:{...reactivation.reading,reactivationWindow:24}}),"5.8")).toBeNull();
  expect(parseTopicView(JSON.stringify(reactivation),"5.9")).toBeNull();
  expect(topicDailyCard("M025",DEFAULT_TOPIC_VIEW.failure,false,false,DEFAULT_TOPIC_SCOPE,48).metric.aggregationLabel).toContain("48小时窗口");
});

test("真实缺失日导出保留历史与空摘要，真实零独立保留", async () => {
  for (const value of [0,100]) {
    const data = await new DailyDashboardService({get:async()=>({msg:{pageData:[{pid:"PH",sumDate:"2026-09-07",loginUserCount:value}],totalCount:1}})}).execute({boardId:"5.2",pid:"PH",dateRange:["2026-09-07","2026-09-08"]});
    const live={query:data.data.query,metricIds:["M016"],state:{status:"success",data,refreshing:false,refreshError:null},platformName:"测试",controls:{dirty:false},canExport:true} as LiveDashboardReading;
    const view={...DEFAULT_TOPIC_VIEW,active:{start:"2026-09-07",end:"2026-09-08"}};
    const model=topicScopeModel("M016",view,DEFAULT_TOPIC_SCOPE,live);
    expect(model.result.status).not.toBe("available");
    const rows=topicScopeExport("M016",view,live), scoped=rows.filter(row=>row[0]==="总体"&&row[1]==="总体");
    expect(scoped).toHaveLength(3);
    expect(scoped.find(row=>row[3]==="摘要")![5]).toBeNull();
    expect(scoped.find(row=>row[4]==="2026-09-07")![5]).toBe(value);
    expect(scoped.find(row=>row[4]==="2026-09-08")![5]).toBeNull();
    expect(rows.every(row=>row.length===rows[0].length)).toBe(true);
  }
});
