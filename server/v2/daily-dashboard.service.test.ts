import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { dailyDashboardMatchesQuery, dailyDashboardQuerySchema, dailyDashboardSuccessSchema } from "../../contracts/daily-dashboard";
import { loadEnv } from "../config/env";
import type { IdentityResolution } from "../identity/identity-provider";
import { UpstreamError } from "../upstream/client";
import { currentUpstreamRequestProfile } from "../upstream/request-profile";
import { DailyDashboardService, dailyDashboardCatalog, dailyDashboardMatchesMapping, dailyDashboardProjectionDocumentation, type DailyDashboardExecutor } from "./daily-dashboard.service";
import { getV2MetricDefinition } from "./metric-definitions";
import { v2BiPlugin } from "./plugin";

const query = { boardId: "5.2", pid: "PH", dateRange: ["2026-09-05", "2026-09-06"] as [string, string] };
const row = (fields: Record<string, unknown> = {}) => ({ pid: "PH", sumDate: "2026-09-04T16:00:00.000Z", loginUserCount: 100, registerUserCount: 30,
  watchUserCount: 80, totalChargeUserCount: 4, newUserChargeUserCount: 2, diamondChargeAmt: "40.50", adsCount: 20, navCount: 5,
  totalClickedCount: 26, adsClickedPerson: 10, navClickedPerson: 3, totalClickedPerson: 11, secret: "must-never-project", ...fields });
const emptyMetrics = { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-09T00:00:00Z", watermark: null, rows: [] } };
const service = (rows: Record<string, unknown>[] = [row()], envelope = {}) => new DailyDashboardService({ get: async (path) => path === "/api/admin/bi/v1/metrics" ? emptyMetrics : path.endsWith("pDaySum") ? ({ code: 200, msg: { pageData: rows, totalCount: rows.length, ...envelope } }) : path.includes("reletionsStatPlus") ? {data:[]} : {msg:{pageData:[],totalData:[],totalCount:0}} });
const getSeries = async (id: string, fields: Record<string, unknown> = {}) => (await service([row(fields)]).execute(query)).data.series.find(series => series.metric.id === id)!;

describe("M006/M007复用已有READY基础指标", () => {
  const date = "2020-01-01";
  const codes = ["M006", "M007"] as const;
  const keys = ["totalDownCountByIp", "ipStatTotalCount"] as const;
  const metricRow = (metricCode: string, value: number, extra: Record<string, unknown> = {}) => ({
    metricCode, businessDate: date, dimensions: { pid: "PH" }, value, numerator: value, denominator: 0,
    unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "ready-facts-v1", ...extra
  });
  const facts = () => [metricRow("M008", 3), metricRow("M095", 3), metricRow("M002", 4), metricRow("M001", 800), metricRow("M003", 900)];
  const direct = (status = "SOURCE_INCOMPLETE") => codes.map(code => metricRow(code, 999, { unit: "ratio", denominator: 1, dataStatus: status }));
  const execute = async (rows: Array<Record<string, unknown> & { metricCode: string }>, boardId = "5.2", dateRange: [string, string] = [date, date], legacy?: Record<string, unknown>) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        return { code: 200, msg: { ...emptyMetrics.msg, rows: params.dimensionFilters || params.dimensions ? []
          : rows.filter(row => params.metricCodes.split(",").includes(row.metricCode)) } };
      }
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, registerUserCount: 99 })], totalCount: 1 } };
      if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [{ pid: "PH", sumDate: date,
        totalDownCountNoDedup: 1000, visiCountNoDedup: 2000, ...legacy }] } };
      if (path.includes("/bi/v1/playback")) return emptyMetrics;
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId, pid: "PH", dateRange });
    const series = (id: string) => result.data.series.find(series => series.metric.id === id)!;
    return { result, requests, series, points: () => codes.map(id => series(id).points[0]) };
  };

  for (const boardId of ["5.2", "5.7"]) {
    test(`${boardId} 请求基础依赖，3/3和3/4直接可读且优于旧渠道值`, async () => {
      const { result, requests, series, points } = await execute([...facts(), ...direct()], boardId, [date, date], { registerUserCount: 9, totalDownCountByIp: 1, ipStatTotalCount: 1 });
      const overall = requests.find(request => !request.dimensions && !request.dimensionFilters)!;
      for (const code of ["M008", "M095", "M002", ...codes]) expect(overall.metricCodes.split(",")).toContain(code);
      expect(overall).toMatchObject({ pid: "PH", startDate: date, endDate: "2020-01-02" });
      points().forEach((point, index) => expect(point).toEqual({ date, state: "available", sourceStatus: "READY", value: [1, .75][index],
        inputs: [{ key: "registerUserCount", value: 3 }, { key: keys[index], value: [3, 4][index] }] }));
      expect(series("M006").metric.formula).toBe("单日注册用户数（去重） ÷ 单日下载 IP·天 × 100%");
      expect(series("M007").metric.inputs.map(input => input.unit)).toEqual(["人", "IP·天"]);
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
      const stale = structuredClone(result);
      stale.data.series.find(series => series.metric.id === "M006")!.metric.sourceNote = "旧渠道字段回退";
      expect(dailyDashboardMatchesMapping(stale)).toBe(false);
    });
  }

  for (const status of ["SOURCE_INCOMPLETE", "PROCESSING", "NOT_MATURE", "FAILED", "no_record"]) {
    test(`独立比率${status}时只用已就绪基础事实，不消费比率脏值`, async () => {
      const { points } = await execute([...facts(), ...(status === "no_record" ? [] : direct(status))]);
      expect(points().map(point => point.value)).toEqual([1, .75]);
      expect(points().every(point => point.sourceStatus === "READY")).toBe(true);
    });
  }

  test("合法直返正值、真零、零分母和超过100%优先于基础计算", async () => {
    for (const [numerator, denominator] of [[1, 2], [0, 2], [0, 0], [4, 1]]) {
      const rows = codes.map(code => metricRow(code, numerator / (denominator || 1), {
        unit: "ratio", numerator, denominator, value: denominator ? numerator / denominator : null
      }));
      const { points } = await execute([...facts(), ...rows]);
      points().forEach(point => expect(point).toMatchObject({ sourceStatus: "READY", state: denominator ? "available" : "zero_denominator",
        value: denominator ? numerator / denominator : null, inputs: [{ value: numerator }, { value: denominator }] }));
    }
  });

  test("直接比率值或单位无效时仍可复用合法基础事实", async () => {
    for (const override of [{ value: .9 }, { unit: "count" }]) {
      const { points } = await execute([...facts(), ...codes.map(code => metricRow(code, .5, { unit: "ratio", numerator: 1, denominator: 2, ...override }))]);
      expect(points().map(point => point.value)).toEqual([1, .75]);
    }
  });

  test("基础数真零、零分母与合法超过100%分别保留", async () => {
    for (const [registered, download, visit] of [[0, 3, 4], [0, 0, 0], [3, 0, 0], [9, 3, 4]]) {
      const { points } = await execute([metricRow("M008", registered), metricRow("M095", download), metricRow("M002", visit), ...direct()]);
      points().forEach((point, index) => expect(point).toMatchObject({ sourceStatus: "READY",
        state: [download, visit][index] ? "available" : "zero_denominator", value: [download, visit][index] ? registered / [download, visit][index] : null }));
    }
  });

  for (const code of ["M008", "M095", "M002"]) {
    for (const status of ["PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED", "missing"]) {
      test(`${code} ${status}不能用其携带数值、旧注册人数或普通访问/下载次数补齐`, async () => {
        const rows = facts().flatMap(row => row.metricCode !== code ? [row] : status === "missing" ? [] : [{ ...row, dataStatus: status }]);
        const { points } = await execute([...rows, ...direct()]);
        points().forEach((point, index) => {
          const affected = code === "M008" || code === (index ? "M002" : "M095");
          expect(point.value).toBe(affected ? null : [1, .75][index]);
          if (affected) expect(point.state).not.toBe("available");
        });
      });
    }
  }

  test("基础字段错误、错误PID或越界日期不生成派生比率", async () => {
    for (const override of [{ numerator: null }, { dimensions: { pid: "OTHER" } }, { businessDate: "2019-12-31" }, { businessDate: "2020-01-02" }]) {
      const { points } = await execute([...facts().map(row => row.metricCode === "M008" ? { ...row, ...override } : row), ...direct()]);
      expect(points().every(point => point.value === null && point.state !== "available")).toBe(true);
    }
  });

  test("额外交叉维度不能作为总体输入，合法相邻比率继续返回", async () => {
    const { points } = await execute([...facts().map(row => row.metricCode === "M095" ? { ...row, dimensions: { pid: "PH", userCohort: "new" } } : row), ...direct()]);
    expect(points()[0].value).toBeNull();
    expect(points()[1]).toMatchObject({ state: "available", value: .75 });
  });

  test("多日逐日计算，缺日不补0，不累加注册UV生成周期比率", async () => {
    const rows = [metricRow("M008", 3), metricRow("M095", 3), metricRow("M002", 4),
      ...[metricRow("M008", 9), metricRow("M095", 3), metricRow("M002", 6)].map(row => ({ ...row, businessDate: "2020-01-02" }))];
    const { series } = await execute(rows, "5.7", [date, "2020-01-03"]);
    expect(series("M006").points.map(point => point.value)).toEqual([1, 3, null]);
    expect(series("M007").points.map(point => point.value)).toEqual([.75, 1.5, null]);
    for (const code of codes) expect(series(code).periodStatistics).toMatchObject({ state: "unsupported", values: [] });
  });

  test("共享指标详情优先正式建议定义，保留明确覆盖与引用现有定义的哨兵", async () => {
    const definitions = dailyDashboardProjectionDocumentation();
    const explicit = new Set(["M101", "M102", "M098"]);
    for (const item of definitions) {
      if (explicit.has(item.id)) continue;
      const authority = getV2MetricDefinition(item.referenceMetricId)!.authority;
      const expected = authority.recommendedDefinition && !/^与现有定义一致[。.]?$/.test(authority.recommendedDefinition)
        ? authority.recommendedDefinition : authority.definition;
      expect(item.definition).toBe(expected);
    }
    for (const code of ["M067", "M087", "M088", "M064"]) expect(definitions.find(item => item.id === code)!.definition).not.toMatch(/未登记|两套/);
    expect(definitions.find(item => item.id === "M102")!.definition).toBe("所选平台单日播放成功后的前台观看时长总和，由秒换算为小时。");
    expect(definitions.find(item => item.id === "M006")!.definition).toBe("下载访问后形成注册的转化趋势");
    const { result } = await execute(facts(), "5.10");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    const stale = structuredClone(result);
    stale.data.series.find(series => series.metric.id === "M067")!.metric.definition = getV2MetricDefinition("M067")!.authority.definition;
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
  });
});

describe("专题看板复用已接通的结构切片", () => {
  const date = "2020-01-01";
  const execute = async (boardId: "5.9" | "5.10", incomplete?: string) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        expect(params).toMatchObject({ pid: "PH", startDate: date, endDate: "2020-01-02", granularity: "day", includeIncomplete: "true" });
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const scoped = (metricCode: string, numerator: number, denominator: number, unit: string) => ({
          metricCode, businessDate: date, dimensions: { pid: "PH", ...filters },
          numerator, denominator, value: denominator ? numerator / denominator : numerator, unit,
          dataStatus: filters.clientPlatform === incomplete ? "SOURCE_INCOMPLETE" : "READY",
          metricVersion: "bi-v1", ruleVersion: "effective_play_v3"
        });
        const platform = filters.clientPlatform;
        const rows = platform && Object.keys(filters).length === 1 && params.metricCodes.split(",").includes("M036")
          ? [scoped("M036", platform === "web" ? 3 : 2, platform === "web" ? 4 : 2, "ratio")]
          : [];
        return { code: 200, msg: { ...emptyMetrics.msg, rows } };
      }
      if (path.includes("/bi/v1/playback")) return emptyMetrics;
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });
    return { result, requests };
  };

  test("消费5.9读取Android2/2、iOS2/2、Web3/4有效观影率，保留独立维度输入", async () => {
    const { result, requests } = await execute("5.9");
    for (const [platform, numerator, denominator] of [["android", 2, 2], ["ios", 2, 2], ["web", 3, 4]] as const) {
      const scoped = requests.filter(request => request.dimensionFilters === JSON.stringify({ clientPlatform: platform }));
      expect(scoped).toHaveLength(1);
      expect(scoped[0].dimensions).toBe("clientPlatform");
      expect(scoped[0].metricCodes.split(",")).toContain("M036");
      const series = result.data.series.find(series => series.metric.id === `M036.${platform}`)!;
      expect(series.metric.referenceMetricId).toBe("M036");
      expect(series.points[0]).toMatchObject({ state: "available", sourceStatus: "READY", value: numerator / denominator, inputs: [{ value: numerator }, { value: denominator }] });
      expect(series.periodStatistics).toMatchObject({ state: "unsupported", values: [] });
    }
    expect(result.data.series.some(series => /^M0(?:34|97)\./.test(series.metric.id))).toBe(false);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    const stale = structuredClone(result);
    stale.data.series = stale.data.series.filter(series => !series.metric.id.startsWith("M036."));
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
  });

  test("付费5.10不增加没有对应视图的获客来源切片，经营5.2保留既有投影", async () => {
    const { result, requests } = await execute("5.10");
    expect(requests.some(request => JSON.parse(request.dimensionFilters ?? "{}").sourceType)).toBe(false);
    expect(result.data.series.some(series => ["M058.nature", "M058.internal"].includes(series.metric.id))).toBe(false);
    expect(dailyDashboardCatalog(true).data.items.find(item => item.id === "5.2")!.metricIds).toEqual(expect.arrayContaining(["M058.nature", "M058.internal"]));
    expect(result.data.series.some(series => series.metric.id.startsWith("M058.android"))).toBe(false);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("新增切片未就绪时保留状态，相邻真实切片可用且不影响总体", async () => {
    const watch = await execute("5.9", "web");
    expect(watch.result.data.series.find(series => series.metric.id === "M036.web")!.points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
    expect(watch.result.data.series.find(series => series.metric.id === "M036.android")!.points[0]).toMatchObject({ state: "available", value: 1 });
    expect(watch.result.data.series.find(series => series.metric.id === "M036")!.points[0].value).toBeNull();
  });
});

describe("播放5.12直接复用M103同日起播用户数分子", () => {
  const date = "2020-01-01";
  const metricRow = (extra: Record<string, unknown> = {}) => ({ metricCode: "M103", businessDate: date,
    dimensions: { pid: "PH" }, numerator: 5, denominator: 6, value: 5 / 6, unit: "ratio", dataStatus: "READY",
    metricVersion: "bi-v1", ruleVersion: "active-user-start-v1", ...extra });
  const execute = async (rows: Record<string, unknown>[], dateRange: [string, string] = [date, date]) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        return { code: 200, msg: { ...emptyMetrics.msg, rows: params.dimensions || params.dimensionFilters ? [] : rows } };
      }
      if (path.includes("/bi/v1/playback")) return emptyMetrics;
      return { msg: { pageData: [row({ sumDate: date, startUserCount: 99, watchUserCount: 999 })], totalData: [], totalCount: 1 }, data: [] };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId: "5.12", pid: "PH", dateRange });
    return { result, requests, series: result.data.series.find(series => series.metric.id === "M030")! };
  };

  test("整体READY 5/6投影5人，请求仅复用M103且保留待验数", async () => {
    const { result, requests, series } = await execute([metricRow()]);
    const overall = requests.filter(request => !request.dimensions && !request.dimensionFilters);
    expect(overall).toHaveLength(1);
    expect(overall[0]).toMatchObject({ pid: "PH", startDate: date, endDate: "2020-01-02", granularity: "day", includeIncomplete: "true" });
    expect(overall[0].metricCodes.split(",")).toContain("M103");
    expect(overall[0].metricCodes.split(",")).not.toContain("M030");
    expect(overall[0].metricCodes.split(",")).not.toContain("M026");
    expect(series.metric).toMatchObject({ referenceMetricId: "M030", unit: "人", inputs: [{ key: "startUserCount", unit: "人" }] });
    expect(series.metric.sourceNote).toContain("M103 同日、同 PID、全用户范围");
    expect(series.points[0]).toEqual({ date, state: "available", sourceStatus: "READY", value: 5, inputs: [{ key: "startUserCount", value: 5 }] });
    expect(result.data.validationStatus).toBe("pending_validation");
    expect(series.periodStatistics).toMatchObject({ state: "unsupported", values: [] });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    const stale = structuredClone(result);
    stale.data.series = stale.data.series.filter(item => item.metric.id !== "M030");
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
    const catalog = dailyDashboardCatalog(true).data.items;
    expect(catalog.find(item => item.id === "5.12")!.pendingMetricNames).not.toContain("起播用户数");
    expect(catalog.find(item => item.id === "5.2")!.metricIds).not.toContain("M030");
  });

  for (const status of ["PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED", "missing"] as const) {
    test(`${status}不能消费携带分子或从旧起播/观影人数补齐`, async () => {
      const { series } = await execute(status === "missing" ? [] : [metricRow({ dataStatus: status })]);
      expect(series.points[0].value).toBeNull();
      expect(series.points[0].state).not.toBe("available");
      expect(series.points[0].inputs).toEqual([{ key: "startUserCount", value: null }]);
      if (status !== "missing") expect(series.points[0].sourceStatus).toBe(status);
    });
  }

  test("READY零分母保留真实零起播人数，不把比率无值当人数缺失", async () => {
    const { series } = await execute([metricRow({ numerator: 0, denominator: 0, value: null })]);
    expect(series.points[0]).toMatchObject({ state: "available", sourceStatus: "READY", value: 0, inputs: [{ value: 0 }] });
  });

  test("非法比率、单位、非整数人数与范围错配不生成总体人数", async () => {
    for (const extra of [{ value: .9 }, { unit: "count" }, { numerator: 1.5, value: .25 },
      { dimensions: { pid: "OTHER" } }, { dimensions: { pid: "PH", clientPlatform: "android" } },
      { businessDate: "2019-12-31" }, { businessDate: "2020-01-02" }]) {
      const { series } = await execute([metricRow(extra)]);
      expect(series.points[0].value).toBeNull();
      expect(series.points[0].state).not.toBe("available");
    }
  });

  test("多日仅输出逐日起播UV，缺日不补零且不造区间去重人数", async () => {
    const { series } = await execute([metricRow(), metricRow({ businessDate: "2020-01-02", numerator: 3, denominator: 4, value: .75 })], [date, "2020-01-03"]);
    expect(series.points.map(point => point.value)).toEqual([5, 3, null]);
    expect(series.points[2].state).toBe("no_record");
    expect(series.periodStatistics).toMatchObject({ state: "unsupported", values: [] });
  });
});

describe("观影秒值接入与既有播放发起来源", () => {
  const date="2026-09-12",q={...query,boardId:"5.9",dateRange:[date,date] as [string,string]};
  const make=(summary:Record<string,unknown>={totalUserWatchTime:7200,watchUserCount:4},fail=false)=>new DailyDashboardService({get:async(path,params)=>{
    if(path === "/api/admin/bi/v1/metrics")return{code:200,msg:{...emptyMetrics.msg,rows:params.dimensionFilters?[]:[
      {metricCode:"M102",value:summary.totalUserWatchTime,unit:"seconds"},{metricCode:"M026",value:summary.watchUserCount,unit:"count"}
    ].filter(item=>params.metricCodes.split(",").includes(item.metricCode)&&item.value!==undefined).map(item=>({...item,businessDate:date,dimensions:{pid:"PH"},numerator:item.value,denominator:0,dataStatus:"READY",metricVersion:"bi-v1",ruleVersion:item.metricCode==="M102"?"foreground-watch-duration-v1":"isolated-watch-fixture"}))}};
    if(path.endsWith("pDaySum"))return{msg:{pageData:[row({sumDate:date,watchUserCount:999})],totalCount:1}};
    if(path.includes("channelStatByTypeV2"))return{msg:{pageData:[],totalData:[summary]}};
    if(path.endsWith("pRealDayLine")){if(fail)throw new UpstreamError("UPSTREAM_TIMEOUT","timeout",504);return{msg:Array.from({length:288},(_,i)=>({pid:"PH",sumDate:new Date(Date.parse(date+"T00:00:00+08:00")+i*300000).toISOString(),graphDate:String(Math.floor(i/12)).padStart(2,"0")+":"+String(i%12*5).padStart(2,"0"),watchCount:2}))};}
    return{msg:{pageData:[],totalCount:0},data:[]};
  }},()=>new Date("2026-09-14T00:00:00Z"));
  test("隔离样本：发起次数全日累计，时长与人均复用同日秒值和观影人数",async()=>{
    const r=await make().execute(q),get=(id:string)=>r.data.series.find(s=>s.metric.id===id)!;
    expect(get("M101").points[0].value).toBe(576);
    expect(get("M102").points[0]).toMatchObject({state:"available",value:2,inputs:[{key:"totalUserWatchTime",value:7200}]});
    expect(get("M098").points[0]).toMatchObject({state:"available",value:30,inputs:[{value:7200},{value:4}]});
    expect(get("M102").metric).toMatchObject({unit:"小时",inputs:[{unit:"秒"}]});
    expect(get("M098").metric.unit).toBe("分钟/人");
    for (const id of ["M102", "M098"]) {
      expect(get(id).metric.sourceNote).toContain("foreground-watch-duration-v1");
      expect(get(id).metric.definition).toContain("播放成功后的前台观看时长");
      expect(JSON.stringify(get(id).metric)).not.toContain("后台时间");
    }
    expect(r.data).toMatchObject({validationStatus:"pending_validation",completeness:"unknown",watermark:null});
    expect(dailyDashboardMatchesMapping(r)).toBe(true);
    expect((await make().execute({...q,boardId:"5.2"})).data.sourceApiIds).toHaveLength(7);
    const playback=await make().execute({...q,boardId:"5.12"});
    expect(playback.data.series.map(series=>series.metric.id)).toEqual(["M101","M034","M036","M097", "M030", "M034.android", "M036.android", "M097.android", "M034.ios", "M036.ios", "M097.ios", "M034.web", "M036.web", "M097.web"]);
    expect(playback.data.sourceApiIds).toEqual(["/api/admin/home/pRealDayLine","/api/admin/bi/v1/playback","/api/admin/bi/v1/metrics"]);
  });
  test("同日时长真零、缺失、非法值与零分母分开，实时失败不污染时长",async()=>{
    for(const [summary,state,value] of [[{totalUserWatchTime:0,watchUserCount:4},"available",0],[{watchUserCount:4},"no_record",null],[{totalUserWatchTime:-1,watchUserCount:4},"source_failure",null],[{totalUserWatchTime:7200,watchUserCount:0},"zero_denominator",null]] as const){
      const r=await make(summary).execute(q);
      expect(r.data.series.find(s=>s.metric.id==="M098")!.points[0]).toMatchObject({state,value});
    }
    const r=await make(undefined,true).execute(q);
    expect(r.data.series.find(s=>s.metric.id==="M101")!.points[0].state).toBe("source_failure");
    expect(r.data.series.find(s=>s.metric.id==="M102")!.points[0].value).toBe(2);
  });
});

describe("bi-v1 金额、时长与同群付费率隔离样本", () => {
  const date = "2020-01-01";
  type FixtureRow = Record<string, unknown>;
  const fixture = (metricCode: string, value: number | null, unit = "count", dimensions: Record<string, string> = {}, numerator = value, denominator = 0): FixtureRow => ({
    metricCode, businessDate: date, dimensions: { pid: "PH", ...dimensions }, value, numerator, denominator, unit,
    dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: metricCode === "M058" ? "paid-order-value-v1" : metricCode === "M102" ? "foreground-watch-duration-v1" : "isolated-value-fixture-v1"
  });
  const rows = () => [fixture("M102", 64, "seconds"), fixture("M026", 4), fixture("M016", 6), fixture("M008", 3),
    fixture("M058", 162.02, "currency"), fixture("M058", 141.02, "currency", { userCohort: "new" }),
    fixture("M058", 138.02, "currency", { sourceType: "natural" }), fixture("M058", 24, "currency", { sourceType: "internal_channel" }),
    fixture("M059", 5), fixture("M059", 3, "count", { userCohort: "new" }),
    fixture("M061", 5 / 6, "ratio", {}, 5, 6), fixture("M064", 1, "ratio", {}, 3, 3)];
  const eleven = { M102: 64 / 3600, M058: 162.02, "M058.new": 141.02, "M058.nature": 138.02, "M058.internal": 24,
    M061: 5 / 6, M064: 1, M087: 162.02 / 6, M088: 141.02 / 3, M067: 162.02 / 5, "M067.new": 141.02 / 3 };
  const execute = async (transform: (row: FixtureRow) => FixtureRow | null = row => row, boardId = "5.2", dateRange: [string, string] = [date, date], fail = false, duplicateSecondDay = false) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        if (fail) throw new UpstreamError("UPSTREAM_TIMEOUT", "isolated fixture timeout", 504);
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const sourceRows = duplicateSecondDay ? rows().flatMap(row => [row, { ...row, businessDate: "2020-01-02" }]) : rows();
        const selected = sourceRows.filter(row => params.metricCodes.split(",").includes(String(row.metricCode))
          && JSON.stringify(row.dimensions) === JSON.stringify({ pid: "PH", ...filters })).map(transform).filter(Boolean);
        return { code: 200, msg: { ...emptyMetrics.msg, rows: selected } };
      }
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, loginUserCount: 99, registerUserCount: 88, watchUserCount: 77,
        diamondChargeAmt: 99999, newUserDiamondChargeAmt: 88888, totalChargeUserCount: 66, newUserChargeUserCount: 55 })], totalCount: 1 } };
      if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [{ totalUserWatchTime: 77777, watchUserCount: 66,
        natureChargeAmt: 55555, channelInternalChargeAmt: 44444, vipChargeAmt: 12.5 }] } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId, pid: "PH", dateRange });
    const series = (id: string) => result.data.series.find(series => series.metric.id === id)!;
    return { result, requests, series, point: (id: string) => series(id).points[0] };
  };

  test("11项经营投影与M098精确换算，金额原值为元、原始时长输入为秒", async () => {
    const { result, point, series } = await execute();
    for (const [id, value] of Object.entries(eleven)) expect(point(id)).toMatchObject({ state: "available", sourceStatus: "READY", value });
    expect(point("M102").inputs).toEqual([{ key: "totalUserWatchTime", value: 64 }]);
    expect(point("M098")).toMatchObject({ state: "available", sourceStatus: "READY", value: 64 / 4 / 60, inputs: [{ value: 64 }, { value: 4 }] });
    expect(series("M102").metric).toMatchObject({ unit: "小时", inputs: [{ unit: "秒" }] });
    expect(series("M098").metric).toMatchObject({ unit: "分钟/人", inputs: [{ unit: "秒" }, { unit: "人" }] });
    expect(series("M061").metric.inputs[0].name).toBe("同日活跃且支付成功的去重用户数");
    expect(series("M064").metric.inputs[0].name).toBe("注册当日付费去重用户数");
    for (const id of ["M058", "M058.new", "M058.nature", "M058.internal"]) expect(series(id).metric.unit).toBe("元");
    expect(point("M065")).toMatchObject({ state: "available", value: 12.5 });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expect(result.data.validationStatus).toBe("pending_validation");
  });

  test("获客类型金额只筛sourceType，新用户金额只筛userCohort", async () => {
    const { requests } = await execute();
    const amountRequests = requests.filter(request => request.metricCodes.split(",").includes("M058"));
    expect(amountRequests.map(request => JSON.parse(request.dimensionFilters ?? "{}")).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual([{}, { userCohort: "new" }, { sourceType: "natural" }, { sourceType: "internal_channel" }].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    for (const request of amountRequests.filter(request => request.dimensions === "sourceType"))
      expect(JSON.parse(request.dimensionFilters)).not.toHaveProperty("userCohort");
    expect(amountRequests.filter(request => request.dimensions === "sourceType")).toHaveLength(2);
    for (const request of requests) expect(request).not.toHaveProperty("expectedRuleVersions");
  });

  test("付费率直接使用接口同群输入，独立付费人数仅作为ARPPU分母", async () => {
    const { point } = await execute(row => row.metricCode === "M059" ? { ...row, value: 2, numerator: 2 } : row);
    expect(point("M061")).toMatchObject({ value: 5 / 6, inputs: [{ value: 5 }, { value: 6 }] });
    expect(point("M064")).toMatchObject({ value: 1, inputs: [{ value: 3 }, { value: 3 }] });
    expect(point("M067").value).toBe(162.02 / 2);
    expect(point("M067.new").value).toBe(141.02 / 2);
  });

  test("同群付费率拒绝M061的7/6与M064的4/3，其他指标保持独立", async () => {
    for (const [metricCode, numerator, denominator] of [["M061", 7, 6], ["M064", 4, 3]] as const) {
      const { point } = await execute(row => row.metricCode === metricCode ? { ...row, numerator, denominator, value: numerator / denominator } : row);
      expect(point(metricCode)).toMatchObject({ state: "invalid_value", value: null, sourceStatus: "READY", inputs: [{ value: null }, { value: null }] });
      const healthyRate = metricCode === "M061" ? "M064" : "M061";
      expect(point(healthyRate)).toMatchObject({ state: "available", value: eleven[healthyRate] });
      expect(point("M058")).toMatchObject({ state: "available", value: 162.02 });
      expect(point("M067")).toMatchObject({ state: "available", value: 162.02 / 5 });
    }
  });

  for (const boardId of ["5.7", "5.9", "5.10", "5.11"]) test(`${boardId}专题复用当前映射，内部依赖不增加展示卡`, async () => {
    const { result, requests, point } = await execute(row => row, boardId);
    for (const [id, value] of Object.entries(eleven).filter(([id]) => result.data.series.some(series => series.metric.id === id)))
      expect(point(id)).toMatchObject({ state: "available", value });
    if (boardId === "5.10") {
      expect(requests.find(request => !request.dimensionFilters)?.metricCodes.split(",")).toEqual(expect.arrayContaining(["M016", "M008"]));
      expect(result.data.series.map(series => series.metric.id)).not.toContain("M016");
      expect(result.data.series.map(series => series.metric.id)).not.toContain("M008");
    }
    expect(result.data.series.map(series => series.metric.id)).toEqual(dailyDashboardCatalog(true).data.items.find(item => item.id === boardId)!.metricIds);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const)
    test(`${dataStatus}保留原状态与派生状态，旧源非零值不补位`, async () => {
      const { point } = await execute(row => ["M058", "M102", "M061", "M064"].includes(String(row.metricCode)) ? { ...row, dataStatus } : row);
      for (const id of [...Object.keys(eleven), "M098"]) expect(point(id)).toMatchObject({ state, value: null, sourceStatus: dataStatus });
      for (const id of ["M058", "M102", "M061", "M064"]) {
        const diagnostic = dataStatus === "SOURCE_INCOMPLETE" ? id === "M061" ? [5, 6] : id === "M064" ? [3, 3] : null : null;
        expect(point(id).inputs.map(input => input.value)).toEqual(diagnostic ?? point(id).inputs.map(() => null));
      }
      expect(point("M059")).toMatchObject({ state: "available", value: 5 });
    });

  test("来源缺项、缺日和请求失败不借旧值或邻日，完整日才能合计", async () => {
    const absent = await execute(row => ["M058", "M102", "M061", "M064"].includes(String(row.metricCode)) ? null : row);
    for (const id of [...Object.keys(eleven), "M098"]) expect(absent.point(id)).toMatchObject({ state: "no_record", value: null });
    const missingDay = await execute(row => row, "5.2", [date, "2020-01-02"]);
    for (const id of [...Object.keys(eleven), "M098"]) expect(missingDay.series(id).points[1]).toMatchObject({ state: "no_record", value: null });
    for (const id of ["M102", "M058", "M058.new", "M058.nature", "M058.internal"])
      expect(missingDay.series(id).periodStatistics).toMatchObject({ state: "incomplete", values: [] });
    const failed = await execute(row => row, "5.2", [date, date], true);
    for (const id of [...Object.keys(eleven), "M098"]) expect(failed.point(id)).toMatchObject({ state: "source_failure", value: null });
  });

  test("真零金额时长保持可用，派生分母为零独立标记", async () => {
    const zero = await execute(row => ["M058", "M102"].includes(String(row.metricCode)) ? { ...row, value: 0, numerator: 0 } : row);
    for (const id of ["M102", "M058", "M058.new", "M058.nature", "M058.internal", "M067", "M067.new", "M087", "M088", "M098"])
      expect(zero.point(id)).toMatchObject({ state: "available", value: 0 });
    const noBase = await execute(row => ["M026", "M016", "M008", "M059"].includes(String(row.metricCode)) ? { ...row, value: 0, numerator: 0 }
      : ["M061", "M064"].includes(String(row.metricCode)) ? { ...row, value: null, numerator: 0, denominator: 0 } : row);
    for (const id of ["M067", "M067.new", "M087", "M088", "M098", "M061", "M064"])
      expect(noBase.point(id)).toMatchObject({ state: "zero_denominator", value: null });
  });

  test("错误单位和错PID、日期、来源维度不跨范围兜底，其他切片独立", async () => {
    for (const override of [{ unit: "count" }, { dimensions: { pid: "OTHER", sourceType: "natural" } },
      { businessDate: "2020-01-02" }, { dimensions: { pid: "PH", sourceType: "natural", userCohort: "new" } }]) {
      const { point } = await execute(row => row.metricCode === "M058" && (row.dimensions as Record<string, string>).sourceType === "natural" ? { ...row, ...override } : row);
      expect(point("M058.nature")).toMatchObject({ state: "unit" in override ? "invalid_value" : "source_failure", value: null });
      expect(point("M058")).toMatchObject({ state: "available", value: 162.02 });
      expect(point("M058.internal")).toMatchObject({ state: "available", value: 24 });
    }
    const wrongDuration = await execute(row => row.metricCode === "M102" ? { ...row, unit: "count" } : row);
    for (const id of ["M102", "M098"]) expect(wrongDuration.point(id)).toMatchObject({ state: "invalid_value", value: null });
  });

  test("四组金额跨日版本漂移或空版本独立拒绝，不输出部分合计或日均", async () => {
    for (const ruleVersion of ["paid-order-value-v2", ""]) {
      const { series } = await execute(row => row.metricCode === "M058" && row.businessDate === "2020-01-02" ? { ...row, ruleVersion } : row,
        "5.2", [date, "2020-01-02"], false, true);
      for (const id of ["M058", "M058.new", "M058.nature", "M058.internal"] as const) {
        expect(series(id).points[0]).toMatchObject({ state: "available", value: eleven[id] });
        expect(series(id).points[1]).toMatchObject({ state: "invalid_value", value: null });
        expect(series(id).periodStatistics).toMatchObject({ state: "incomplete", values: [] });
      }
      for (const id of ["M067", "M067.new", "M087", "M088"])
        expect(series(id).points[1]).toMatchObject({ state: "invalid_value", value: null });
      expect(series("M102").points.every(point => point.state === "available")).toBe(true);
      expect(series("M061").points.every(point => point.state === "available")).toBe(true);
    }
  });

  test("时长旧规则日值无效且不混合累计，当日正确版本和相邻观影人数保持可用", async () => {
    const { series } = await execute(row => row.metricCode === "M102" && row.businessDate === date ? { ...row, ruleVersion: "legacy-recorded-duration-v1" } : row,
      "5.9", [date, "2020-01-02"], false, true);
    for (const id of ["M102", "M098"]) {
      const [oldPoint, current] = series(id).points;
      expect(oldPoint).toMatchObject({ state: "invalid_value", value: null });
      expect(current).toMatchObject({ state: "available", value: id === "M102" ? 64 / 3600 : 64 / 4 / 60 });
    }
    expect(series("M102").periodStatistics).toMatchObject({ state: "incomplete", values: [] });
    expect(series("M026").points.every(point => point.state === "available")).toBe(true);
  });

  test("金额与时长版本不符时，非READY仍按原状态返回", async () => {
    const { point } = await execute(row => ["M058", "M102"].includes(String(row.metricCode)) ? { ...row, ruleVersion: "", dataStatus: "PROCESSING" } : row);
    for (const id of ["M058", "M058.new", "M058.nature", "M058.internal", "M102", "M098"])
      expect(point(id)).toMatchObject({ state: "no_value", sourceStatus: "PROCESSING", value: null });
  });

  test("日比率与人均不新增多日统计，旧映射缓存不能通过当前映射核验", async () => {
    const { result, series } = await execute();
    for (const id of ["M061", "M064", "M067", "M067.new", "M087", "M088", "M098"])
      expect(series(id).periodStatistics).toMatchObject({ state: "unsupported", values: [] });
    const stale = structuredClone(result);
    stale.data.series.find(series => series.metric.id === "M102")!.metric.inputs[0].unit = "秒（暂定）";
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
    for (const id of ["M058", "M102"]) {
      const ungated = structuredClone(result);
      ungated.data.series.find(series => series.metric.id === id)!.metric.sourceNote = "旧来源说明：READY结果可用";
      expect(dailyDashboardMatchesMapping(ungated)).toBe(false);
    }
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
});

describe("bi-v1 播放指标接入", () => {
  const date = "2026-09-21";
  const playbackRows = [
    ["M034", "default", 27, 27, 0, "count"], ["M036", "default", 27 / 89, 27, 89, "ratio"], ["M097", "default", 89, 89, 0, "count"],
    ["M034", "long_video", 6, 6, 0, "count"], ["M036", "long_video", 6 / 9, 6, 9, "ratio"], ["M097", "long_video", 9, 9, 0, "count"]
  ].map(([metricCode, videoType, value, numerator, denominator, unit]) => ({ metricCode, businessDate: date, dimensions: { pid: "PH", videoType }, value, numerator, denominator, unit, dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "effective_play_v3" }));
  const make = (rows: Record<string, unknown>[] = playbackRows) => new DailyDashboardService({ get: async path => {
    if (path.includes("/bi/v1/playback")) return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-22T10:00:00+08:00", watermark: "2026-09-22 10:00:00.000", rows } };
    if (path.endsWith("pRealDayLine")) return { msg: [] };
    if (path.endsWith("pDaySum")) return { msg: { pageData: [], totalCount: 0 } };
    if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [] } };
    return { data: [], msg: { pageData: [], totalData: [], totalCount: 0 } };
  } }, () => new Date("2026-09-23T00:00:00Z"));

  test("按视频类型合计计数并用总分子总分母计算比率", async () => {
    const result = await make().execute({ boardId: "5.12", pid: "PH", dateRange: [date, date] });
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M034")).toMatchObject({ state: "available", sourceStatus: "READY", value: 33, inputs: [{ value: 33 }] });
    expect(point("M097")).toMatchObject({ state: "available", sourceStatus: "READY", value: 98, inputs: [{ value: 98 }] });
    expect(point("M036")).toMatchObject({ state: "available", sourceStatus: "READY", value: 33 / 98, inputs: [{ value: 33 }, { value: 98 }] });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("核心经营明细保留有效观看与成功起播的已映射播放结果", async () => {
    const result = await make().execute({ boardId: "5.2", pid: "PH", dateRange: [date, date] });
    const core = dailyDashboardCatalog(true).data.items.find(item => item.id === "5.2")!;
    expect(core.metricIds).toEqual(expect.arrayContaining(["M034", "M036", "M097"]));
    expect(result.data.series.find(series => series.metric.id === "M034")!.points[0]).toMatchObject({ state: "available", value: 33, sourceStatus: "READY" });
    expect(result.data.series.find(series => series.metric.id === "M097")!.points[0]).toMatchObject({ state: "available", value: 98, sourceStatus: "READY" });
    expect(core.metricIds).not.toContain("M075");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("三个关联看板隔离旧有效规则并保留成功起播", async () => {
    const rows = playbackRows.map(row => row.metricCode === "M097" ? row : { ...row, ruleVersion: "effective_play_v2" });
    for (const boardId of ["5.2", "5.9", "5.12"]) {
      const result = await make(rows).execute({ boardId, pid: "PH", dateRange: [date, date] });
      for (const id of ["M034", "M036"]) {
        const point = result.data.series.find(series => series.metric.id === id)!.points[0];
        expect(point).toMatchObject({ state: "invalid_value", value: null });
        expect(point.inputs.every(input => input.value === null)).toBe(true);
      }
      expect(result.data.series.find(series => series.metric.id === "M097")!.points[0]).toMatchObject({ state: "available", value: 98 });
      expect(dailyDashboardSuccessSchema.safeParse(result).error?.issues).toBeUndefined();
    }
  });

  test("总体及全部客户端有效观看元数据使旧缓存失效，起播不附加有效门槛", async () => {
    const oldNotes: Record<string, string> = {
      M034: "来自 bi-v1 播放域；仅展示 READY 结果，其他状态保留为数据状态，不补 0。",
      M036: "来自 bi-v1 播放域；先汇总各视频类型的分子、分母再计算，不平均分类比率或日比率。"
    };
    for (const boardId of ["5.2", "5.9", "5.12"]) {
      const result = await make().execute({ boardId, pid: "PH", dateRange: [date, date] });
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
      for (const series of result.data.series.filter(series => ["M034", "M036"].includes(series.metric.referenceMetricId))) {
        expect(series.metric.sourceNote).toContain("仅接收 effective_play_v3 有效观看规则");
        const stale = structuredClone(result);
        stale.data.series.find(item => item.metric.id === series.metric.id)!.metric.sourceNote = oldNotes[series.metric.id]
          ?? "采用后台日汇总对应切片的直接结果，不相加或推算总体；身份去重方式待验数。";
        expect(dailyDashboardMatchesMapping(stale)).toBe(false);
      }
      for (const series of result.data.series.filter(series => series.metric.referenceMetricId === "M097"))
        expect(series.metric.sourceNote).not.toContain("effective_play_v3");
    }
  });

  test("未接通状态保留为状态，不补0且不污染旧接口指标", async () => {
    const rows = ["M034", "M036", "M097"].map(metricCode => ({ metricCode, dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0, unit: metricCode === "M036" ? "ratio" : "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: "" }));
    const result = await make(rows).execute({ boardId: "5.9", pid: "PH", dateRange: [date, date] });
    for (const id of ["M034", "M036", "M097"]) expect(result.data.series.find(series => series.metric.id === id)!.points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
  });
});

describe("bi-v1 付费人数与广告点击人数", () => {
  const date = "2020-01-01";
  type MetricRow = Record<string, unknown>;
  const metricRow = (metricCode: string, value: number, dimensions: Record<string, string> = {}): MetricRow => ({
    metricCode, businessDate: date, dimensions: { pid: "PH", ...dimensions }, value, numerator: value, denominator: 0,
    unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "count-fixture-v1"
  });
  const sourceRows = () => [metricRow("M016", 6), metricRow("M008", 3),
    metricRow("M059", 5), metricRow("M059", 3, { userCohort: "new" }),
    metricRow("M094", 4), metricRow("M094", 2, { userCohort: "new" })];
  const execute = async (transform: (row: MetricRow) => MetricRow | null = row => row, boardId = "5.2", fail = false) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        if (fail) throw new UpstreamError("UPSTREAM_TIMEOUT", "fixture timeout", 504);
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const codes = params.metricCodes.split(",");
        const rows = sourceRows().filter(row => codes.includes(String(row.metricCode))
          && JSON.stringify(row.dimensions) === JSON.stringify({ pid: "PH", ...filters })).map(transform).filter(Boolean);
        return { code: 200, msg: { ...emptyMetrics.msg, rows } };
      }
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, loginUserCount: 99, registerUserCount: 88,
        totalChargeUserCount: 77, newUserChargeUserCount: 66, adsClickedPerson: 55, adsClickedNewPerson: 44 })], totalCount: 1 } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });
    return { result, requests, point: (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0] };
  };
  const newRows = (row: MetricRow) => (row.dimensions as Record<string, string>).userCohort === "new";

  test("四项人数独立读取总体与新用户，不读取旧同名字段", async () => {
    const { result, requests, point } = await execute();
    for (const [id, value] of [["M059", 5], ["M059.new", 3], ["M094.ads", 4], ["M094.new", 2]] as const)
      expect(point(id)).toMatchObject({ state: "available", value, sourceStatus: "READY" });
    for (const code of ["M059", "M094"]) expect(requests.filter(request => request.metricCodes.split(",").includes(code))
      .map(request => JSON.parse(request.dimensionFilters ?? "{}"))).toEqual([{}, { userCohort: "new" }]);
    expect(result.data.series.find(series => series.metric.id === "M059")!.periodStatistics)
      .toMatchObject({ state: "available", values: [{ kind: "daily_average", value: 5 }] });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  for (const [status, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]]) {
    test(`新用户${status}不借总体或旧值`, async () => {
      const { point } = await execute(row => newRows(row) ? { ...row, dataStatus: status, value: 999 } : row);
      for (const id of ["M059.new", "M094.new"]) expect(point(id)).toMatchObject({ state, value: null, sourceStatus: status });
      for (const id of ["M059.new", "M094.new"]) expect(point(id).inputs.every(input => input.value === null)).toBe(true);
      expect(point("M059")).toMatchObject({ state: "available", value: 5 });
      expect(point("M094.ads")).toMatchObject({ state: "available", value: 4 });
    });
  }

  test("缺失新用户切片不借总体，计数真零保持可用", async () => {
    const absent = await execute(row => newRows(row) ? null : row);
    for (const id of ["M059.new", "M094.new"]) expect(absent.point(id)).toMatchObject({ state: "no_record", value: null });
    const zero = await execute(row => ({ ...row, value: 0, numerator: 0 }));
    for (const id of ["M059", "M059.new", "M094.ads", "M094.new"]) expect(zero.point(id)).toMatchObject({ state: "available", value: 0 });
  });

  test("请求失败与错误单位不由旧字段掩盖，计数异常仅影响对应指标", async () => {
    const failed = await execute(row => row, "5.2", true);
    for (const id of ["M059", "M059.new", "M094.ads", "M094.new"])
      expect(failed.point(id)).toMatchObject({ state: "source_failure", value: null });
    const invalid = await execute(row => row.metricCode === "M094" ? { ...row, unit: "ratio", value: .5, numerator: 1, denominator: 2 } : row);
    for (const id of ["M094.ads", "M094.new"]) expect(invalid.point(id)).toMatchObject({ state: "invalid_value", value: null });
    expect(invalid.point("M059")).toMatchObject({ state: "available", value: 5 });
    const fractional = await execute(row => row.metricCode === "M059" ? { ...row, value: 1.5, numerator: 1.5 } : row);
    for (const id of ["M059", "M059.new"]) expect(fractional.point(id)).toMatchObject({ state: "invalid_value", value: null });
    expect(fractional.point("M094.ads")).toMatchObject({ state: "available", value: 4 });
  });

  test("各付费专题复用同一独立付费人数映射", async () => {
    for (const boardId of ["5.7", "5.10", "5.11"]) {
      const { result, point } = await execute(row => row, boardId);
      if (boardId !== "5.7") expect(point("M059")).toMatchObject({ state: "available", value: 5 });
      if (boardId !== "5.11") expect(point("M059.new")).toMatchObject({ state: "available", value: 3 });
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    }
  });
});

describe("bi-v1 播放专题客户端切片", () => {
  const date = "2020-01-01";
  const counts = { android: [2, 3], ios: [5, 6], web: [0, 0] } as const;
  const execute = async (invalidPlatform?: string, dataStatus = "READY", transform: (row: Record<string, unknown>) => Record<string, unknown> = row => row) => {
    const requests: Record<string, string>[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        requests.push(params);
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const platform = filters.clientPlatform as keyof typeof counts;
        const rows = platform ? ["M034", "M036", "M097"].map(metricCode => {
          const [effective, starts] = counts[platform];
          const ratio = metricCode === "M036";
          const numerator = metricCode === "M097" ? starts : effective;
          return { metricCode, businessDate: date, dimensions: { pid: "PH", clientPlatform: platform },
            value: ratio ? starts === 0 ? null : effective / starts : numerator,
            numerator, denominator: ratio ? starts : 0, unit: ratio ? "ratio" : "count",
            dataStatus: platform === invalidPlatform ? dataStatus : "READY", metricVersion: "bi-v1", ruleVersion: metricCode === "M097" ? "successful-start-v1" : "effective_play_v3" };
        }).filter(row => params.metricCodes.split(",").includes(row.metricCode)).map(transform) : [];
        return { code: 200, msg: { ...emptyMetrics.msg, rows } };
      }
      if (path.endsWith("pRealDayLine")) return { msg: [] };
      return { code: 200, msg: { ...emptyMetrics.msg, rows: [] } };
    } }, () => new Date("2026-10-09T00:00:00Z")).execute({ boardId: "5.12", pid: "PH", dateRange: [date, date] });
    return { result, requests, point: (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0] };
  };

  test("各平台读取独立计数与同组比率输入，真实零及零分母保留", async () => {
    const { result, requests, point } = await execute();
    for (const [platform, [effective, starts]] of Object.entries(counts)) {
      expect(requests.find(request => JSON.parse(request.dimensionFilters ?? "{}").clientPlatform === platform))
        .toMatchObject({ dimensions: "clientPlatform", metricCodes: "M034,M036,M097" });
      expect(point(`M034.${platform}`)).toMatchObject({ state: "available", value: effective, sourceStatus: "READY" });
      expect(point(`M097.${platform}`)).toMatchObject({ state: "available", value: starts, sourceStatus: "READY" });
      expect(point(`M036.${platform}`)).toMatchObject({ state: starts ? "available" : "zero_denominator",
        value: starts ? effective / starts : null, inputs: [{ value: effective }, { value: starts }] });
      expect(result.data.series.find(series => series.metric.id === `M036.${platform}`)!.metric.inputs.map(input => input.unit)).toEqual(["次", "次"]);
    }
    const core = dailyDashboardCatalog(true).data.items.find(item => item.id === "5.2")!.metricIds;
    expect(core.some(id => /^M(034|036|097)\./.test(id))).toBe(false);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  for (const ruleVersion of ["effective_play_v2", "", undefined]) {
    test(`客户端有效规则 ${ruleVersion ?? "缺失"} 不回退，起播和其他平台保留`, async () => {
      const { point } = await execute(undefined, "READY", row => (row.dimensions as Record<string, string>).clientPlatform === "android" && row.metricCode !== "M097"
        ? { ...row, ruleVersion } : row);
      for (const code of ["M034", "M036"]) {
        expect(point(`${code}.android`)).toMatchObject({ value: null, state: ruleVersion === undefined ? "source_failure" : "invalid_value" });
        expect(point(`${code}.android`).inputs.every(input => input.value === null)).toBe(true);
        expect(point(`${code}.ios`).state).toBe("available");
      }
      expect(point("M097.android")).toMatchObject({ state: "available", value: 3 });
    });
  }

  for (const [status, state] of [["SOURCE_INCOMPLETE", "no_value"], ["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]]) {
    test(`${status} 仅影响对应客户端并丢弃附带值`, async () => {
      const { point } = await execute("android", status);
      for (const code of ["M034", "M036", "M097"]) {
        expect(point(`${code}.android`)).toMatchObject({ state, value: null, sourceStatus: status });
        expect(point(`${code}.android`).inputs.map(input => input.value)).toEqual(status === "SOURCE_INCOMPLETE" && code === "M036"
          ? [2, 3] : point(`${code}.android`).inputs.map(() => null));
        expect(point(`${code}.ios`).state).toBe("available");
      }
    });
  }

  test("来源不完整的客户端比率仅保留当前规则版本的诊断输入", async () => {
    for (const ruleVersion of ["effective_play_v3", "effective_play_v2", ""]) {
      const { point } = await execute("android", "SOURCE_INCOMPLETE", row => row.metricCode === "M036"
        && (row.dimensions as Record<string, string>).clientPlatform === "android" ? { ...row, ruleVersion } : row);
      expect(point("M036.android")).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
        inputs: ruleVersion === "effective_play_v3" ? [{ value: 2 }, { value: 3 }] : [{ value: null }, { value: null }] });
      expect(point("M036.ios")).toMatchObject({ state: "available", value: 5 / 6, sourceStatus: "READY" });
    }
  });
});

describe("bi-v1 通用指标渐进替换", () => {
  const date = "2026-09-05";
  const query = { boardId: "5.8", pid: "PH", dateRange: [date, date] as [string, string] };
  const response = (dataStatus: "READY" | "PROCESSING" | "SOURCE_INCOMPLETE") => ({ code: 200, msg: {
    metricVersion: "bi-v1",
    generatedAt: "2026-09-06T10:00:00+08:00",
    watermark: "2026-09-06 10:00:00.000",
    rows: [{
      metricCode: "M016",
      ...(dataStatus === "SOURCE_INCOMPLETE" ? {} : { businessDate: date }),
      dimensions: { pid: "PH" },
      value: dataStatus === "READY" ? 150 : null,
      numerator: dataStatus === "READY" ? 150 : 0,
      denominator: 0,
      unit: "count",
      dataStatus,
      metricVersion: "bi-v1",
      ruleVersion: dataStatus === "READY" ? "active-user-v1" : ""
    }]
  } });
  const make = (mode: "ready" | "incomplete" | "processing" | "failure") => new DailyDashboardService({ get: async path => {
    if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, loginUserCount: 100 })], totalCount: 1 } };
    if (path.includes("reletionsStatPlus")) return { data: [] };
    if (path === "/api/admin/bi/v1/metrics") {
      if (mode === "failure") throw new UpstreamError("UPSTREAM_TIMEOUT", "timeout", 504);
      return response(mode === "ready" ? "READY" : mode === "processing" ? "PROCESSING" : "SOURCE_INCOMPLETE");
    }
    return { msg: { pageData: [], totalData: [], totalCount: 0 } };
  } }, () => new Date("2026-09-08T00:00:00Z"));

  test("READY 使用新接口值，且保留分子输入与来源状态", async () => {
    const result = await make("ready").execute(query);
    expect(result.data.series.find(series => series.metric.id === "M016")!.points[0]).toMatchObject({
      state: "available", sourceStatus: "READY", value: 150, inputs: [{ key: "loginUserCount", value: 150 }]
    });
    expect(result.data.sourceApiIds).toContain("/api/admin/bi/v1/metrics");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("SOURCE_INCOMPLETE 与通用接口异常保留旧接口真值，不补0", async () => {
    for (const mode of ["incomplete", "failure"] as const) {
      const point = (await make(mode).execute(query)).data.series.find(series => series.metric.id === "M016")!.points[0];
      expect(point).toMatchObject({ state: "available", value: 100, inputs: [{ value: 100 }] });
      expect(point).not.toHaveProperty("sourceStatus");
    }
  });

  test("新接口明确处于处理中时不伪装成旧值", async () => {
    const point = (await make("processing").execute(query)).data.series.find(series => series.metric.id === "M016")!.points[0];
    expect(point).toMatchObject({ state: "no_value", sourceStatus: "PROCESSING", value: null, inputs: [{ value: null }] });
  });

  test("核心批次无关指标拒绝后支付4/4与支付看板一致，不被旧来源2/0覆盖", async () => {
    const businessDate = "2020-01-01";
    const metricCalls: string[][] = [];
    let legacyPaymentCalls = 0;
    const paymentRows = ["M113", "M112", "M060", "M114"].map(metricCode => ({
      metricCode, businessDate, dimensions: { pid: "PH" }, value: metricCode === "M114" ? 1 : 4,
      numerator: 4, denominator: metricCode === "M114" ? 4 : 0, unit: metricCode === "M114" ? "ratio" : "count",
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "payment-v1"
    }));
    const service = new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        const metricCodes = params.metricCodes.split(",");
        metricCalls.push(metricCodes);
        if (metricCodes.includes("M018")) {
          expect(params).toMatchObject({ pid: "PH", startDate: businessDate, endDate: "2020-02-01", granularity: "summary" });
          throw new UpstreamError("UPSTREAM_INVALID_REQUEST", "不支持的指标编码 M018", 422);
        }
        expect(params).toMatchObject({ pid: "PH", startDate: businessDate, endDate: "2020-01-02", granularity: "day", includeIncomplete: "true" });
        return { code: 200, msg: {
          metricVersion: "bi-v1", generatedAt: "2026-10-08T10:00:00+08:00", watermark: null,
          rows: paymentRows.filter(row => metricCodes.includes(row.metricCode))
        } };
      }
      if (path.endsWith("getRechargeSucRate")) {
        legacyPaymentCalls++;
        return { code: 200, msg: { pid: "PH", pageData: [], totalAllCount: 2, totalSurCount: 0 } };
      }
      if (path.includes("reletionsStatPlus")) return { data: [] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 } };
    } }, () => new Date("2026-10-08T10:00:00+08:00"));
    const range = { pid: "PH", dateRange: [businessDate, businessDate] as [string, string] };
    const core = await service.execute({ ...range, boardId: "5.2" });
    const coreCalls = metricCalls.length;
    const payment = await service.execute({ ...range, boardId: "5.11" });
    expect(metricCalls.slice(0, coreCalls).filter(codes => codes.includes("M018"))).toEqual([["M018"]]);
    expect(metricCalls.slice(coreCalls).every(codes => !codes.includes("M018"))).toBe(true);
    expect(metricCalls.slice(0, coreCalls).some(codes => codes.includes("M112") && codes.includes("M114"))).toBe(true);
    expect(legacyPaymentCalls).toBe(2);
    const point = (result: typeof core, id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    for (const id of ["M113", "M112", "M060", "M114"]) {
      expect(point(core, id)).toEqual(point(payment, id));
      expect(point(core, id)).toMatchObject({ state: "available", sourceStatus: "READY", value: id === "M114" ? 1 : 4 });
    }
    expect(point(core, "M114").inputs).toEqual([{ key: "totalSurCount", value: 4 }, { key: "totalAllCount", value: 4 }]);
    expect(point(core, "M018")).toMatchObject({ state: "source_failure", value: null });
    expect(point(core, "M018")).not.toHaveProperty("sourceStatus");
    expect(dailyDashboardMatchesMapping(core)).toBe(true);
    expect(dailyDashboardMatchesMapping(payment)).toBe(true);
  });

  test("核心总览批次中的未就绪脏值不压掉其他 READY 指标", async () => {
    const metricRow = (metricCode: string, value: number, numerator = value, denominator = 0, unit: "count" | "ratio" = "count") => ({
      metricCode, businessDate: date, dimensions: { pid: "PH" }, value, numerator, denominator, unit,
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1"
    });
    const result = await new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null,
        rows: [
          metricRow("M001", 400), metricRow("M002", 150), metricRow("M003", 120), metricRow("M095", 60),
          metricRow("M005", .3, 120, 400, "ratio"), metricRow("M099", .4, 60, 150, "ratio"),
          { ...metricRow("M006", 15, 15, 100, "ratio"), dataStatus: "SOURCE_INCOMPLETE", ruleVersion: "" },
          { ...metricRow("M007", 15, 15, 100, "ratio"), dataStatus: "SOURCE_INCOMPLETE", ruleVersion: "" },
          metricRow("M016", 11), metricRow("M026", 14), metricRow("M081", 1, 14, 14, "ratio"), metricRow("M103", .5, 5, 10, "ratio"),
          metricRow("M020", .8, 8, 10, "ratio"), metricRow("M021", .7, 7, 10, "ratio"),
          metricRow("M022", .6, 6, 10, "ratio"), metricRow("M023", .5, 5, 10, "ratio")
        ]
      } };
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, loginUserCount: 1, watchUserCount: 1, totalVistCount: 1 })], totalCount: 1 } };
      if (path.includes("reletionsStatPlus")) return { data: [] };
      if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [] } };
      if (path.includes("/bi/v1/playback")) return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null, rows: [] } };
      if (path.endsWith("pRealDayLine")) return { msg: [] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 } };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.2", pid: "PH", dateRange: [date, date] });
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M001")).toMatchObject({ state: "available", value: 400, sourceStatus: "READY" });
    expect(point("M002")).toMatchObject({ state: "available", value: 150, sourceStatus: "READY" });
    expect(point("M003")).toMatchObject({ state: "available", value: 120, sourceStatus: "READY" });
    expect(point("M095")).toMatchObject({ state: "available", value: 60, sourceStatus: "READY" });
    expect(point("M005")).toMatchObject({ state: "available", value: .3, sourceStatus: "READY" });
    expect(point("M099")).toMatchObject({ state: "available", value: .4, sourceStatus: "READY" });
    expect(point("M016")).toMatchObject({ state: "available", value: 11, sourceStatus: "READY" });
    expect(point("M026")).toMatchObject({ state: "available", value: 14, sourceStatus: "READY" });
    expect(point("M081")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M103")).toMatchObject({ state: "available", value: .5, sourceStatus: "READY" });
    expect(point("M115.d1")).toMatchObject({ state: "available", value: 8, sourceStatus: "READY" });
    expect(point("M115.d3")).toMatchObject({ state: "available", value: 7, sourceStatus: "READY" });
    expect(point("M115.d7")).toMatchObject({ state: "available", value: 6, sourceStatus: "READY" });
    expect(point("M115.d30")).toMatchObject({ state: "available", value: 5, sourceStatus: "READY" });
    expect(point("M006")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" });
    expect(point("M007")).toMatchObject({ state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("M006和M007在新版来源不完整时按已确认IP天趋势口径读取既有同日输入", async () => {
    const metricRow = (metricCode: string) => ({
      metricCode, businessDate: date, dimensions: { pid: "PH" }, value: 999, numerator: 999, denominator: 1,
      unit: "ratio", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: ""
    });
    const result = await new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null,
        rows: [metricRow("M006"), metricRow("M007")]
      } };
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date })], totalCount: 1 } };
      if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [{
        registerUserCount: 3, totalDownCountByIp: 4, ipStatTotalCount: 8
      }] } };
      if (path.includes("reletionsStatPlus")) return { data: [] };
      if (path.includes("/bi/v1/playback")) return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null, rows: [] } };
      if (path.endsWith("pRealDayLine")) return { msg: [] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.2", pid: "PH", dateRange: [date, date] });
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M006")).toEqual({ date, value: .75, state: "available", inputs: [
      { key: "registerUserCount", value: 3 }, { key: "totalDownCountByIp", value: 4 }
    ] });
    expect(point("M007")).toEqual({ date, value: .375, state: "available", inputs: [
      { key: "registerUserCount", value: 3 }, { key: "ipStatTotalCount", value: 8 }
    ] });
    expect(result.data.series.find(series => series.metric.id === "M006")!.metric.sourceNote).toContain("非归因趋势口径");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  describe("M006与M007旧源回退边界", () => {
    const ids = ["M006", "M007"] as const;
    const denominatorKeys = ["totalDownCountByIp", "ipStatTotalCount"] as const;
    type SourceMode = "READY" | "SOURCE_INCOMPLETE" | "PROCESSING" | "NOT_MATURE" | "FAILED" | "request_failure" | "no_record";
    const execute = (mode: SourceMode, legacyDays: Record<string, Record<string, unknown>>, options: {
      boardId?: string; dateRange?: [string, string]; sourceInputs?: [number, number]
    } = {}) => {
      const dateRange: [string, string] = options.dateRange ?? [date, date];
      const [numerator, denominator] = options.sourceInputs ?? [1, 2];
      return new DailyDashboardService({ get: async (path, params) => {
        if (path === "/api/admin/bi/v1/metrics") {
          if (mode === "request_failure") throw new UpstreamError("UPSTREAM_TIMEOUT", "timeout", 504);
          return { ...emptyMetrics, msg: { ...emptyMetrics.msg, rows: mode === "no_record" ? [] : Object.keys(legacyDays).flatMap(businessDate =>
            ["M005", ...ids].map(metricCode => ({
              metricCode, businessDate, dimensions: { pid: "PH" },
              value: mode === "READY" ? denominator ? numerator / denominator : null : 999,
              numerator: mode === "READY" ? numerator : 999, denominator: mode === "READY" ? denominator : 1,
              unit: "ratio", dataStatus: mode, metricVersion: "bi-v1", ruleVersion: "ip-day-trend-v1"
            }))) } };
        }
        if (path.includes("channelStatByTypeV2")) {
          const requestedDate = params.sumDateBegin.slice(0, 10);
          expect(params).toMatchObject({ pid: "PH", sumDateBegin: requestedDate + " 00:00:00", sumDateEnd: requestedDate + " 23:59:59" });
          const fields = legacyDays[requestedDate];
          return { msg: { pageData: [], totalData: fields ? [{ pid: "PH", sumDate: requestedDate, ...fields }] : [] } };
        }
        if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, registerUserCount: 999 })], totalCount: 1 } };
        if (path.includes("/bi/v1/playback")) return emptyMetrics;
        if (path.includes("reletionsStatPlus")) return { data: [] };
        if (path.endsWith("pRealDayLine")) return { msg: [] };
        return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
      } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: options.boardId ?? "5.7", pid: "PH", dateRange });
    };
    const points = (result: Awaited<ReturnType<typeof execute>>) => ids.map(id => result.data.series.find(series => series.metric.id === id)!.points[0]);

    for (const mode of ["SOURCE_INCOMPLETE", "request_failure", "no_record"] as const) {
      test(`${mode} 保留合法旧源零分母、真实零与IP天输入`, async () => {
        for (const boardId of ["5.2", "5.7"]) {
          for (const [registered, download, visit] of [[3, 0, 0], [0, 0, 0], [0, 4, 8], [3, 4, 8]]) {
            const result = await execute(mode, { [date]: {
              registerUserCount: registered, totalDownCountByIp: download, ipStatTotalCount: visit,
              totalDownCountNoDedup: 100, visiCountNoDedup: 200
            } }, { boardId });
            points(result).forEach((point, index) => {
              const denominator = [download, visit][index];
              expect(point).toEqual({ date, value: denominator === 0 ? null : registered / denominator,
                state: denominator === 0 ? "zero_denominator" : "available",
                inputs: [{ key: "registerUserCount", value: registered }, { key: denominatorKeys[index], value: denominator }] });
            });
            expect(dailyDashboardMatchesMapping(result)).toBe(true);
          }
        }
      });

      test(`${mode} 不用缺失或非法的旧源输入生成比率`, async () => {
        for (const [fields, legacyState] of [
          [{ registerUserCount: 3, totalDownCountNoDedup: 4, visiCountNoDedup: 8 }, "no_value"],
          [{ totalDownCountByIp: 0, ipStatTotalCount: 0 }, "no_value"],
          [{ registerUserCount: -1, totalDownCountByIp: 0, ipStatTotalCount: 0 }, "invalid_value"],
          [{ registerUserCount: 3, totalDownCountByIp: "dirty", ipStatTotalCount: -1 }, "invalid_value"]
        ] as const) {
          const result = await execute(mode, { [date]: fields });
          for (const point of points(result)) {
            expect(point.value).toBeNull();
            expect(point.state).toBe(mode === "no_record" ? legacyState : mode === "request_failure" ? "source_failure" : "no_value");
            expect(point.sourceStatus).toBe(mode === "SOURCE_INCOMPLETE" ? mode : undefined);
            if (mode !== "no_record") expect(point.inputs.map(input => input.value)).toEqual(mode === "SOURCE_INCOMPLETE" ? [999, 1] : [null, null]);
          }
        }
      });
    }

    test("READY正值、真实零和零分母都优先采用新版同批输入", async () => {
      for (const sourceInputs of [[1, 2], [0, 2], [0, 0]] as [number, number][]) {
        const result = await execute("READY", { [date]: { registerUserCount: 9, totalDownCountByIp: 3, ipStatTotalCount: 3 } }, { sourceInputs });
        const [numerator, denominator] = sourceInputs;
        points(result).forEach((point, index) => expect(point).toEqual({ date, sourceStatus: "READY",
          state: denominator ? "available" : "zero_denominator", value: denominator ? numerator / denominator : null,
          inputs: [{ key: "registerUserCount", value: numerator }, { key: denominatorKeys[index], value: denominator }] }));
      }
    });

    for (const [mode, state] of [["PROCESSING", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
      test(`${mode} 保留新版明确状态`, async () => {
        for (const denominator of [0, 4]) {
          const result = await execute(mode, { [date]: { registerUserCount: 3, totalDownCountByIp: denominator, ipStatTotalCount: denominator } });
          for (const point of points(result)) expect(point).toMatchObject({ sourceStatus: mode, state, value: null, inputs: [{ value: null }, { value: null }] });
        }
      });
    }

    test("旧源PID或业务日不匹配时拒绝零分母回退", async () => {
      for (const scope of [{ pid: "other" }, { sumDate: "2026-09-04" }]) {
        const result = await execute("no_record", { [date]: { ...scope, registerUserCount: 3, totalDownCountByIp: 0, ipStatTotalCount: 0 } });
        for (const point of points(result)) expect(point).toMatchObject({ state: "source_failure", value: null, inputs: [{ value: null }, { value: null }] });
      }
    });

    test("其他指标沿用既有零分母回退策略", async () => {
      const result = await execute("SOURCE_INCOMPLETE", { [date]: {
        registerUserCount: 0, totalDownCountByIp: 0, ipStatTotalCount: 0, totalDownCountNoDedup: 0, visiCountNoDedup: 0
      } });
      expect(result.data.series.find(series => series.metric.id === "M005")!.points[0])
        .toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ value: 999 }, { value: 1 }] });
    });

    test("多日仅返回各业务日输入与比率，周期统计保持未支持", async () => {
      const result = await execute("SOURCE_INCOMPLETE", {
        [date]: { registerUserCount: 3, totalDownCountByIp: 4, ipStatTotalCount: 8 },
        "2026-09-06": { registerUserCount: 9, totalDownCountByIp: 36, ipStatTotalCount: 72 }
      }, { dateRange: [date, "2026-09-06"] });
      ids.forEach((id, index) => {
        const series = result.data.series.find(series => series.metric.id === id)!;
        expect(series.points.map(point => point.value)).toEqual(index === 0 ? [.75, .25] : [.375, .125]);
        expect(series.points.map(point => point.inputs)).toEqual([
          [{ key: "registerUserCount", value: 3 }, { key: denominatorKeys[index], value: index === 0 ? 4 : 8 }],
          [{ key: "registerUserCount", value: 9 }, { key: denominatorKeys[index], value: index === 0 ? 36 : 72 }]
        ]);
        expect(series.periodStatistics).toMatchObject({ state: "unsupported", values: [] });
      });
    });
  });

  test("经营明细总体与交叉维度一次接入，不把已返回维度误判为待支持", async () => {
    const metricRow = (metricCode: string, value: number, dimensions: Record<string, string> = {}, numerator = value, denominator = 0, unit: "count" | "ratio" | "count_per_user" = "count") => ({
      metricCode, businessDate: date, dimensions: { pid: "PH", ...dimensions }, value, numerator, denominator, unit,
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "first-batch-v1"
    });
    const rows = [
      metricRow("M018", 9),
      metricRow("M008", 3), metricRow("M008", 2, { registerPlatform: "Android" }), metricRow("M008", 1, { acquisitionType: "natural" }),
      metricRow("M016", 6), metricRow("M016", 4, { clientPlatform: "Android" }), metricRow("M016", 2, { clientPlatform: "iOS" }), metricRow("M016", 2, { userType: "new" }),
      metricRow("M016", 3, { clientPlatform: "Android", userType: "old" }), metricRow("M016", 1, { clientPlatform: "iOS", userType: "old" }),
      metricRow("M026", 5), metricRow("M026", 3, { clientPlatform: "Android" }), metricRow("M026", 2, { clientPlatform: "iOS" }),
      metricRow("M026", 2, { clientPlatform: "Android", userType: "old" }), metricRow("M026", 1, { clientPlatform: "iOS", userType: "old" }),
      metricRow("M081", 5 / 6, {}, 5, 6, "ratio"), metricRow("M081", 1 / 2, { userType: "new" }, 1, 2, "ratio"),
      metricRow("M081", 3 / 4, { clientPlatform: "Android" }, 3, 4, "ratio"), metricRow("M081", 1, { clientPlatform: "iOS" }, 2, 2, "ratio"),
      metricRow("M081", 2 / 3, { clientPlatform: "Android", userType: "old" }, 2, 3, "ratio"), metricRow("M081", 1, { clientPlatform: "iOS", userType: "old" }, 1, 1, "ratio"),
      metricRow("M020", .8, {}, 8, 10, "ratio"), metricRow("M020", .75, { d0Platform: "Android" }, 3, 4, "ratio"),
      metricRow("M020", 1, { d0Platform: "iOS" }, 2, 2, "ratio"), metricRow("M020", .5, { acquisitionType: "natural" }, 2, 4, "ratio"),
      metricRow("M020", 1, { acquisitionType: "internal_channel" }, 2, 2, "ratio"),
      metricRow("M110", 2, { userType: "new" }, 4, 2, "count_per_user"), metricRow("M111", .5, { userType: "new" }, 1, 2, "ratio"),
      metricRow("M113", 4), metricRow("M113", 1, { payment_method: "alipay" }), metricRow("M113", 2, { payment_method: "wechat" }), metricRow("M113", 1, { payment_method: "usdt" }),
      metricRow("M112", 2, { payment_method: "usdt" }), metricRow("M060", 1, { payment_method: "usdt" }), metricRow("M114", .5, { payment_method: "usdt" }, 1, 2, "ratio")
    ];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null, rows: rows.filter(row => params.metricCodes.split(",").includes(row.metricCode)) } };
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date })], totalCount: 1 } };
      if (path.includes("reletionsStatPlus")) return { data: [] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.2", pid: "PH", dateRange: [date, date] });
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M018")).toMatchObject({ state: "available", value: 9, sourceStatus: "READY" });
    expect(point("M008.android")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(point("M008.nature")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M016.android")).toMatchObject({ state: "available", value: 4, sourceStatus: "READY" });
    expect(point("M016.new")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(point("M016.androidOld")).toMatchObject({ state: "available", value: 3, sourceStatus: "READY" });
    expect(point("M026.android")).toMatchObject({ state: "available", value: 3, sourceStatus: "READY" });
    expect(point("M026.iosOld")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M081.android")).toMatchObject({ state: "available", value: 3 / 4, sourceStatus: "READY" });
    expect(point("M081.androidOld")).toMatchObject({ state: "available", value: 2 / 3, sourceStatus: "READY" });
    expect(point("M020.android")).toMatchObject({ state: "available", value: .75, sourceStatus: "READY" });
    expect(point("M020.internal")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M115.d1")).toMatchObject({ state: "available", value: 8, sourceStatus: "READY" });
    expect(point("M110.new")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(point("M111.new")).toMatchObject({ state: "available", value: .5, sourceStatus: "READY" });
    expect(point("M113.alipay")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M113.usdt")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M112.usdt")).toMatchObject({ state: "available", value: 2, sourceStatus: "READY" });
    expect(point("M060.usdt")).toMatchObject({ state: "available", value: 1, sourceStatus: "READY" });
    expect(point("M114.usdt")).toMatchObject({ state: "available", value: .5, sourceStatus: "READY" });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("支付首批新指标直接呈现 bi-v1 状态，不回退旧字段或伪造0", async () => {
    const rows = [
      { metricCode: "M113", businessDate: date, dimensions: { pid: "PH" }, value: 3, numerator: 3, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "order-fetch-user-v1" },
      { metricCode: "M084", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0, unit: "count", dataStatus: "PROCESSING", metricVersion: "bi-v1", ruleVersion: "" },
      { metricCode: "M086", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0, unit: "count", dataStatus: "SOURCE_INCOMPLETE", metricVersion: "bi-v1", ruleVersion: "" },
      { metricCode: "M090", dimensions: { pid: "PH" }, value: null, numerator: 0, denominator: 0, unit: "ratio", dataStatus: "NOT_MATURE", metricVersion: "bi-v1", ruleVersion: "payment-credit-v1" }
    ];
    const result = await new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null, rows } };
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, orderFetchUserCount: 999, paymentSubmitCount: 999, creditedOrderCount: 999 })], totalCount: 1 } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.11", pid: "PH", dateRange: [date, date] });
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M113")).toMatchObject({ state: "available", sourceStatus: "READY", value: 3, inputs: [{ key: "orderFetchUserCount", value: 3 }] });
    expect(point("M084")).toMatchObject({ state: "no_value", sourceStatus: "PROCESSING", value: null });
    expect(point("M086")).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
    expect(point("M090")).toMatchObject({ state: "immature", sourceStatus: "NOT_MATURE", value: null });
    const paymentBoard = dailyDashboardCatalog(true).data.items.find(item => item.id === "5.11")!;
    expect(paymentBoard.metricIds).toEqual(expect.arrayContaining(["M084", "M086", "M090", "M113"]));
    expect(paymentBoard.pendingMetricNames).not.toContain("拉单人数");
    expect(dailyDashboardProjectionDocumentation().find(item => item.id === "M084")?.sourceApi).toBe("/api/admin/bi/v1/metrics");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("支付链路 READY 结果保留真实零、成功值和零分母，不从旧字段推算", async () => {
    const execute = async (rows: Record<string, unknown>[]) => new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: "2026-09-05T23:59:59+08:00", rows } };
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, paymentSubmitCount: 999, creditedOrderCount: 999 })], totalCount: 1 } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.11", pid: "PH", dateRange: [date, date] });
    const metric = (metricCode: string, value: number | null, numerator: number, denominator: number, unit: "count" | "ratio") => ({
      metricCode, businessDate: date, dimensions: { pid: "PH" }, value, numerator, denominator, unit,
      dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "payment-chain-v1"
    });
    const success = await execute([metric("M084", 4, 4, 0, "count"), metric("M086", 3, 3, 0, "count"), metric("M090", .75, 3, 4, "ratio")]);
    const point = (result: typeof success, id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point(success, "M084")).toMatchObject({ state: "available", sourceStatus: "READY", value: 4, inputs: [{ value: 4 }] });
    expect(point(success, "M086")).toMatchObject({ state: "available", sourceStatus: "READY", value: 3, inputs: [{ value: 3 }] });
    expect(point(success, "M090")).toMatchObject({ state: "available", sourceStatus: "READY", value: .75, inputs: [{ value: 3 }, { value: 4 }] });

    const noBusiness = await execute([metric("M084", 0, 0, 0, "count"), metric("M086", 0, 0, 0, "count"), metric("M090", null, 0, 0, "ratio")]);
    expect(point(noBusiness, "M084")).toMatchObject({ state: "available", sourceStatus: "READY", value: 0, inputs: [{ value: 0 }] });
    expect(point(noBusiness, "M086")).toMatchObject({ state: "available", sourceStatus: "READY", value: 0, inputs: [{ value: 0 }] });
    expect(point(noBusiness, "M090")).toMatchObject({ state: "zero_denominator", sourceStatus: "READY", value: null, inputs: [{ value: 0 }, { value: 0 }] });
  });

  test("支付首批新指标接口失败时显示来源失败，不读取旧接口同名脏字段", async () => {
    const result = await new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") throw new UpstreamError("UPSTREAM_TIMEOUT", "timeout", 504);
      if (path.endsWith("pDaySum")) return { msg: { pageData: [row({ sumDate: date, orderFetchUserCount: 999, paymentSubmitCount: 999, creditedOrderCount: 999 })], totalCount: 1 } };
      return { msg: { pageData: [], totalData: [], totalCount: 0, orderFetchUserCount: 999 }, data: [] };
    } }, () => new Date("2026-09-08T00:00:00Z")).execute({ boardId: "5.11", pid: "PH", dateRange: [date, date] });
    for (const id of ["M084", "M086", "M090", "M113"]) {
      expect(result.data.series.find(series => series.metric.id === id)!.points[0]).toMatchObject({ state: "source_failure", value: null });
    }
  });
});

describe("来源不完整的诊断输入与正式值隔离", () => {
  const historicalDate = "2020-01-01";
  const execute = async (boardId: string, date = historicalDate, legacy = false) => {
    const ready = date === "2020-02-20";
    return new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        const filters = JSON.parse(params.dimensionFilters ?? "{}");
        const denominator = filters.clientPlatform === "ios" || filters.sourceType === "internal_channel" ? 1 : 2;
        const rows = params.metricCodes.split(",").filter(code => ["M020", "M103", "M110"].includes(code)).map(code => {
          const numerator = ready || code !== "M020" ? 2 : Object.keys(filters).length ? 1 : 8;
          const base = ready || code !== "M020" ? 3 : Object.keys(filters).length ? denominator : 10;
          return { metricCode: code, businessDate: date, dimensions: { pid: "PH", ...filters },
            value: ready ? numerator / base : null, numerator, denominator: base,
            unit: code === "M110" ? "count_per_user" : "ratio", dataStatus: ready ? "READY" : "SOURCE_INCOMPLETE",
            metricVersion: "bi-v1", ruleVersion: "retention-d0-D1-v1" };
        });
        return { ...emptyMetrics, msg: { ...emptyMetrics.msg, rows } };
      }
      if (legacy && path.includes("reletionsStatPlus")) return { data: [{ pid: "PH", sumDate: date,
        registerCount: 10, afterFirstData1: { date: "2020-01-02", loginCnt: 9 } }] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });
  };
  const series = (result: Awaited<ReturnType<typeof execute>>, id: string) => result.data.series.find(s => s.metric.id === id)!;

  test("历史四组保留原始诊断人数，主率、M115和周期统计均不生成可用值", async () => {
    for (const boardId of ["5.2", "5.8"]) {
      const result = await execute(boardId);
      for (const [suffix, numerator, denominator] of [["android", 1, 2], ["ios", 1, 1], ["natural", 1, 2], ["internal", 1, 1]] as const) {
        expect(series(result, `M020.${suffix}`).points[0]).toMatchObject({ date: historicalDate, state: "no_value",
          sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ value: numerator }, { value: denominator }] });
        expect(series(result, `M020.${suffix}`).periodStatistics?.values).toEqual([]);
      }
      expect(series(result, "M020").points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
        inputs: [{ value: 8 }, { value: 10 }] });
      expect(series(result, "M115.d1").points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
        inputs: [{ value: null }] });
      expect(series(result, "M115.d1").periodStatistics?.values).toEqual([]);
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    }
  });

  test("私有诊断不进入起播人数或广告点击次数的分子派生与汇总", async () => {
    const playback = await execute("5.12");
    expect(series(playback, "M030").points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
      inputs: [{ value: null }] });
    const operating = await execute("5.2");
    expect(series(operating, "M103").points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
      inputs: [{ value: 2 }, { value: 3 }] });
    for (const id of ["M055.ads", "M055.new"]) {
      expect(series(operating, id).points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null, inputs: [{ value: null }] });
      expect(series(operating, id).periodStatistics).toMatchObject({ state: "incomplete", values: [] });
    }
  });

  test("独立旧源回退仍使用完整旧源输入，不混入不完整的新源输入", async () => {
    const result = await execute("5.8", historicalDate, true);
    expect(series(result, "M020").points[0]).toMatchObject({ state: "available", value: .9, inputs: [{ value: 9 }, { value: 10 }] });
    expect(series(result, "M115.d1").points[0]).toMatchObject({ state: "available", value: 9, inputs: [{ value: 9 }] });
    expect(series(result, "M020.android").points[0]).toMatchObject({ state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null,
      inputs: [{ value: 1 }, { value: 2 }] });
  });

  test("2020-02-20独立READY形状保留2/3和M115人数，不覆盖历史状态", async () => {
    const current = await execute("5.8", "2020-02-20");
    expect(series(current, "M020.android").points[0]).toMatchObject({ date: "2020-02-20", state: "available", sourceStatus: "READY",
      value: 2 / 3, inputs: [{ value: 2 }, { value: 3 }] });
    expect(series(current, "M115.d1").points[0]).toMatchObject({ state: "available", sourceStatus: "READY", value: 2 });
    const historical = await execute("5.8");
    expect(series(historical, "M020.android").points[0]).toMatchObject({ date: historicalDate, state: "no_value", sourceStatus: "SOURCE_INCOMPLETE", value: null });
  });

  test("诊断输入来源说明使旧映射缓存失效，公共响应不增加私有字段", async () => {
    const result = await execute("5.8");
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    const stale = structuredClone(result);
    const oldMetric = series(stale, "M020.android").metric;
    oldMetric.sourceNote = oldMetric.sourceNote!.replace(" 所选来源不完整时，合法分子分母仅作为诊断输入，不用于计算正式值、人数或汇总。", "");
    expect(dailyDashboardMatchesMapping(stale)).toBe(false);
    expect(JSON.stringify(result)).not.toContain("diagnosticInputs");
    expect(series(result, "M115.d1").metric.sourceNote).not.toContain("诊断输入");
  });
});

describe("bi-v1 注册留存四周期与五范围", () => {
  const date = "2026-09-01";
  const codes = ["M020", "M021", "M022", "M023"] as const;
  type Scope = Record<string, string>;
  type MetricRow = Record<string, unknown>;
  const scopes: { suffix: string; filters: Scope; numerator: number; denominator: number }[] = [
    { suffix: "", filters: {}, numerator: 8, denominator: 20 },
    { suffix: ".android", filters: { clientPlatform: "android" }, numerator: 1, denominator: 3 },
    { suffix: ".ios", filters: { clientPlatform: "ios" }, numerator: 2, denominator: 5 },
    { suffix: ".natural", filters: { sourceType: "natural" }, numerator: 3, denominator: 7 },
    { suffix: ".internal", filters: { sourceType: "internal_channel" }, numerator: 4, denominator: 11 }
  ];
  const scopeSpec = (scope: Scope) => scopes.find(item => JSON.stringify(item.filters) === JSON.stringify(scope))!;
  const metricRow = (code: string, scope: Scope, overrides: MetricRow = {}) => {
    const spec = scopeSpec(scope);
    return { metricCode: code, businessDate: date, dimensions: { pid: "PH", ...scope },
      value: spec.numerator / spec.denominator, numerator: spec.numerator, denominator: spec.denominator,
      unit: "ratio", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "registration-retention-v1", ...overrides };
  };
  const execute = async (rowForScope: (code: string, scope: Scope) => MetricRow | null = metricRow, boardId = "5.8") => {
    const requests: { codes: string[]; filters: Scope; dimensions: string[] }[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        const filters = JSON.parse(params.dimensionFilters ?? "{}") as Scope;
        const requestedCodes = params.metricCodes.split(",");
        requests.push({ codes: requestedCodes, filters, dimensions: params.dimensions?.split(",") ?? [] });
        if (params.granularity === "summary") return emptyMetrics;
        expect(params).toMatchObject({ pid: "PH", startDate: date, endDate: "2026-09-02", granularity: "day", includeIncomplete: "true" });
        const rows = requestedCodes.filter(code => codes.some(retentionCode => retentionCode === code))
          .map(code => rowForScope(code, filters)).filter(row => row !== null);
        return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-10-09T00:00:00Z", watermark: null, rows } };
      }
      if (path.includes("reletionsStatPlus")) return { data: [{ pid: "PH", sumDate: date, registerCount: 100,
        afterFirstData1: { date: "2026-09-02", loginCnt: 90 }, afterFirstData3: { date: "2026-09-04", loginCnt: 80 },
        afterFirstData7: { date: "2026-09-08", loginCnt: 70 }, afterFirstData30: { date: "2026-10-01", loginCnt: 60 } }] };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });
    return { result, requests, point: (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0] };
  };

  test("四周期分别请求总体、注册端别与D0获客类型，保留同范围精确分子分母", async () => {
    const { result, requests, point } = await execute();
    const retentionRequests = requests.filter(request => request.codes.includes("M020"));
    expect(retentionRequests).toHaveLength(5);
    for (const spec of scopes) {
      const request = retentionRequests.find(item => JSON.stringify(item.filters) === JSON.stringify(spec.filters))!;
      expect(request.codes.filter(code => codes.some(retentionCode => retentionCode === code))).toEqual([...codes]);
      expect(request.dimensions).toEqual(Object.keys(spec.filters));
      for (const code of codes) expect(point(`${code}${spec.suffix}`)).toMatchObject({ state: "available", sourceStatus: "READY",
        value: spec.numerator / spec.denominator, inputs: [{ value: spec.numerator }, { value: spec.denominator }] });
    }
    expect(result.data.series.filter(series => series.metric.id.startsWith("M115.")).map(series => series.metric.id))
      .toEqual(["M115.d1", "M115.d3", "M115.d7", "M115.d30"]);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  for (const [dataStatus, state] of [["NOT_MATURE", "immature"], ["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["FAILED", "source_failure"]] as const) {
    test(`四周期Android切片保留${dataStatus}且不消费附带值，其他范围独立可用`, async () => {
      const { point } = await execute((code, scope) => metricRow(code, scope, scope.clientPlatform === "android" ? { dataStatus } : {}));
      for (const code of codes) {
        expect(point(`${code}.android`)).toMatchObject({ state, sourceStatus: dataStatus, value: null,
          inputs: dataStatus === "SOURCE_INCOMPLETE" ? [{ value: 1 }, { value: 3 }] : [{ value: null }, { value: null }] });
        for (const spec of scopes.filter(item => item.suffix !== ".android")) expect(point(`${code}${spec.suffix}`))
          .toMatchObject({ state: "available", value: spec.numerator / spec.denominator });
      }
    });
  }

  test("四周期切片无记录不借总体或旧留存，真实零与零基数分别返回", async () => {
    const { point } = await execute((code, scope) => scope.clientPlatform === "android" ? null
      : metricRow(code, scope, scope.clientPlatform === "ios" ? { numerator: 0, value: 0 }
        : scope.sourceType === "natural" ? { numerator: 0, denominator: 0, value: null } : {}));
    for (const code of codes) {
      expect(point(`${code}.android`)).toMatchObject({ state: "no_record", value: null, inputs: [{ value: null }, { value: null }] });
      expect(point(`${code}.ios`)).toMatchObject({ state: "available", value: 0, inputs: [{ value: 0 }, { value: 5 }] });
      expect(point(`${code}.natural`)).toMatchObject({ state: "zero_denominator", value: null, inputs: [{ value: 0 }, { value: 0 }] });
      expect(point(code)).toMatchObject({ state: "available", value: 8 / 20 });
    }
  });

  test("异常值按周期隔离，错误分组不回退总体，失败筛选组不影响其他范围", async () => {
    const { point } = await execute((code, scope) => {
      if (scope.sourceType === "internal_channel") throw new UpstreamError("UPSTREAM_TIMEOUT", "timeout", 504);
      return metricRow(code, scope, scope.clientPlatform === "android" && code === "M021" ? { value: .9 }
        : scope.sourceType === "natural" ? { dimensions: { pid: "PH" } } : {});
    });
    expect(point("M021.android")).toMatchObject({ state: "invalid_value", value: null });
    for (const code of codes) {
      if (code !== "M021") expect(point(`${code}.android`)).toMatchObject({ state: "available", value: 1 / 3 });
      expect(point(`${code}.natural`)).toMatchObject({ state: "source_failure", value: null });
      expect(point(`${code}.internal`)).toMatchObject({ state: "source_failure", value: null });
      expect(point(`${code}.ios`)).toMatchObject({ state: "available", value: 2 / 5 });
      expect(point(code)).toMatchObject({ state: "available", value: 8 / 20 });
    }
  });

  test("经营明细保留原投影和未知支付方式，不增加留存及播放专题专用分组", async () => {
    const expected = [
      "M034", "M036", "M097", "M101", "M102", "M098", "M018", "M016.new", "M016.androidNew", "M016.iosNew", "M016.androidOld", "M016.iosOld",
      "M026.old", "M026.androidNew", "M026.iosNew", "M026.androidOld", "M026.iosOld", "M081.old", "M081.new", "M081.androidNew", "M081.iosNew", "M081.androidOld", "M081.iosOld",
      "M112", "M113", "M060", "M114", "M084", "M086", "M090", "M112.alipay", "M113.alipay", "M060.alipay", "M114.alipay", "M112.wechat", "M113.wechat", "M060.wechat", "M114.wechat",
      "M112.usdt", "M113.usdt", "M060.usdt", "M114.usdt", "M112.unknown", "M113.unknown", "M060.unknown", "M114.unknown", "M008.nature", "M008.internal", "M058.nature", "M058.internal", "M065", "M066", "M065.new", "M066.new",
      "M003", "M002", "M095", "M005", "M099", "M006", "M007", "M016.web", "M008.web", "M026.web", "M081.web", "M055.navigation.new", "M094.navigation.new", "M055.total.new", "M094.total.new",
      "M020", "M020.android", "M020.ios", "M020.natural", "M020.internal", "M115.d1", "M021", "M115.d3", "M022", "M115.d7", "M023", "M115.d30",
      "M016.android", "M016.ios", "M016.old", "M008.android", "M008.ios", "M026.android", "M026.ios", "M026.new", "M081.android", "M081.ios", "M055.new", "M094.new", "M058.new", "M088", "M067.new",
      "display:M016", "display:M008", "M001", "M016", "M026", "M059", "M081", "M103", "M061", "M008", "M064", "M058", "M067", "M087", "M110", "M110.new", "M111", "M111.new", "M059.new",
      "M055.ads", "M055.navigation", "M055.total", "M094.ads", "M094.navigation", "M094.total"
    ];
    const { result, requests } = await execute(metricRow, "5.2");
    const catalogIds: string[] = dailyDashboardCatalog(true).data.items.find(item => item.id === "5.2")!.metricIds;
    expect(catalogIds).toEqual(expected);
    expect(result.data.series.map(series => series.metric.id)).toEqual(expected);
    for (const request of requests.filter(request => Object.keys(request.filters).length > 0))
      expect(request.codes.filter(code => ["M021", "M022", "M023"].includes(code))).toEqual([]);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
});

describe("bi-v1 广告次数分子与新用户交叉投影", () => {
  const date = "2026-09-05";
  type Scope = Record<string, string>;
  type MetricRow = Record<string, unknown>;
  const metricRow = (metricCode: string, dimensions: Scope, numerator: number, denominator = 0, overrides: MetricRow = {}) => ({
    metricCode, businessDate: date, dimensions: { pid: "PH", ...dimensions }, numerator, denominator,
    value: denominator ? numerator / denominator : numerator,
    unit: metricCode === "M110" ? "count_per_user" : metricCode === "M081" || metricCode === "M111" ? "ratio" : "count",
    dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1", ...overrides
  });
  const execute = async (boardId: string, rowsForScope: (scope: Scope) => MetricRow[], legacyRows: MetricRow[] = []) => {
    const requests: { codes: string[]; scope: Scope; dimensions: string[] }[] = [];
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics") {
        const scope = JSON.parse(params.dimensionFilters ?? "{}") as Scope;
        const codes = params.metricCodes.split(",");
        requests.push({ codes, scope, dimensions: params.dimensions?.split(",") ?? [] });
        expect(params).toMatchObject({ pid: "PH", startDate: params.granularity === "summary" ? "2026-09-01" : date });
        return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null,
          rows: rowsForScope(scope).filter(row => codes.includes(String(row.metricCode))) } };
      }
      if (path.endsWith("pDaySum")) return { msg: { pageData: legacyRows, totalCount: legacyRows.length } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });
    return { result, requests, point: (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0] };
  };
  const adRows = (scope: Scope, overrides: MetricRow = {}) => Object.keys(scope).some(key => key !== "userCohort") || scope.userCohort === "old"
    ? [] : [metricRow("M110", scope, scope.userCohort === "new" ? 2 : 5, scope.userCohort === "new" ? 3 : 6, overrides),
      metricRow("M111", scope, scope.userCohort === "new" ? 2 : 4, scope.userCohort === "new" ? 3 : 6)];

  test("广告次数直接读取同范围M110分子，总体5、新用户2，点击人数不复用M111", async () => {
    const { result, requests, point } = await execute("5.2", scope => adRows(scope), [row({ sumDate: date, adsCount: 99, adsClickedNewCount: 88, adsClickedPerson: 11, adsClickedNewPerson: 7 })]);
    expect(point("M055.ads")).toMatchObject({ state: "available", sourceStatus: "READY", value: 5, inputs: [{ key: "adsCount", value: 5 }] });
    expect(point("M055.new")).toMatchObject({ state: "available", sourceStatus: "READY", value: 2, inputs: [{ key: "adsClickedNewCount", value: 2 }] });
    expect(point("M110").value).toBe(5 / 6);
    expect(point("M110.new").value).toBe(2 / 3);
    expect(point("M094.ads")).toMatchObject({ state: "no_record", value: null });
    expect(point("M094.new")).toMatchObject({ state: "no_record", value: null });
    expect(point("M094.ads")).not.toHaveProperty("sourceStatus");
    expect(requests.filter(request => request.codes.includes("M110")).map(({ scope, dimensions }) => ({ scope, dimensions })))
      .toEqual([{ scope: {}, dimensions: [] }, { scope: { userCohort: "new" }, dimensions: ["userCohort"] }]);
    expect(requests.every(request => !request.codes.includes("M055"))).toBe(true);
    expect(requests.filter(request => request.codes.includes("M094")).map(request => request.scope))
      .toEqual([{}, { userCohort: "new" }]);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });

  test("READY零分母的点击次数真零仍可用，人均次数保持zero_denominator", async () => {
    const { point } = await execute("5.2", scope => adRows(scope, { numerator: 0, denominator: 0, value: null }));
    for (const id of ["M055.ads", "M055.new"]) expect(point(id)).toMatchObject({ state: "available", sourceStatus: "READY", value: 0, inputs: [{ value: 0 }] });
    for (const id of ["M110", "M110.new"]) expect(point(id)).toMatchObject({ state: "zero_denominator", sourceStatus: "READY", value: null });
    for (const id of ["M094.ads", "M094.new"]) expect(point(id)).toMatchObject({ state: "no_record", value: null });
  });

  for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    test(`广告次数不消费${dataStatus}附带分子，新用户状态不受总体READY影响`, async () => {
      const { point } = await execute("5.2", scope => adRows(scope, scope.userCohort === "new" ? { dataStatus } : {}));
      expect(point("M055.ads")).toMatchObject({ state: "available", sourceStatus: "READY", value: 5 });
      expect(point("M055.new")).toMatchObject({ state, sourceStatus: dataStatus, value: null, inputs: [{ value: null }] });
    });
  }

  for (const [numerator, state] of [[undefined, "source_failure"], [null, "source_failure"], [-1, "source_failure"], [.5, "invalid_value"], [Number.MAX_SAFE_INTEGER + 1, "invalid_value"]] as const) {
    test(`广告次数拒绝缺失或非法分子${String(numerator)}，不从value反推`, async () => {
      const { point } = await execute("5.2", scope => adRows(scope, scope.userCohort === "new" ? { numerator, value: 2 / 3 } : {}));
      expect(point("M055.ads")).toMatchObject({ state: "available", value: 5 });
      expect(point("M055.new")).toMatchObject({ state, value: null, inputs: [{ value: null }] });
    });
  }

  test("广告次数拒绝错误单位；精确新用户分子不能由总体或含端别的交叉行代替", async () => {
    for (const invalidRows of [
      [metricRow("M110", { userCohort: "new" }, 2, 3, { unit: "ratio" })],
      [metricRow("M110", {}, 5, 6), metricRow("M110", { clientPlatform: "android", userCohort: "new" }, 2, 3)]
    ]) {
      const { point } = await execute("5.2", scope => scope.userCohort === "new" ? invalidRows : adRows(scope));
      expect(point("M055.ads")).toMatchObject({ state: "available", value: 5 });
      expect(point("M055.new")).toMatchObject({ state: invalidRows.length === 1 ? "invalid_value" : "source_failure", value: null, inputs: [{ value: null }] });
    }
  });

  test("广告次数仅在旧源完整有效时沿用既有SOURCE_INCOMPLETE回退", async () => {
    const { point } = await execute("5.2", scope => adRows(scope, { dataStatus: "SOURCE_INCOMPLETE" }),
      [row({ sumDate: date, adsCount: 8, adsClickedNewCount: 0 })]);
    expect(point("M055.ads")).toMatchObject({ state: "available", value: 8 });
    expect(point("M055.new")).toMatchObject({ state: "available", value: 0 });
    for (const id of ["M055.ads", "M055.new"]) expect(point(id)).not.toHaveProperty("sourceStatus");
  });

  const crossRows = (scope: Scope) => {
    const active = scope.userCohort === "new" && scope.clientPlatform ? scope.clientPlatform === "android" ? 6 : 4 : 99;
    const viewers = active === 6 ? 2 : active === 4 ? 3 : 88;
    return [metricRow("M016", scope, active), metricRow("M026", scope, viewers), metricRow("M081", scope, viewers, active)];
  };
  for (const boardId of ["5.8", "5.9"]) {
    const codes = boardId === "5.8" ? ["M016"] : ["M026", "M081"];
    test(`${boardId}新用户交叉投影按两个过滤字段查询，不借单维值、不相加`, async () => {
      const { result, requests, point } = await execute(boardId, crossRows);
      for (const clientPlatform of ["android", "ios"]) {
        const active = clientPlatform === "android" ? 6 : 4;
        const viewers = clientPlatform === "android" ? 2 : 3;
        const request = requests.find(request => request.scope.clientPlatform === clientPlatform && request.scope.userCohort === "new")!;
        expect(request).toMatchObject({ codes, scope: { clientPlatform, userCohort: "new" } });
        expect(request.dimensions.toSorted()).toEqual(["clientPlatform", "userCohort"]);
        for (const code of codes) {
          const value = code === "M016" ? active : code === "M026" ? viewers : viewers / active;
          expect(point(`${code}.${clientPlatform}New`)).toMatchObject({ state: "available", sourceStatus: "READY", value });
          expect(point(`${code}.${clientPlatform}New`).inputs.map(input => input.value)).toEqual(code === "M081" ? [viewers, active] : [value]);
          expect(result.data.series.find(series => series.metric.id === `${code}.${clientPlatform}New`)!.periodStatistics)
            .toMatchObject(code === "M081" ? { state: "unsupported" } : { state: "available", values: [{ kind: "daily_average", value }] });
        }
      }
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    });

    test(`${boardId}新用户交叉响应缺少端别时拒绝，其他客户端与单维保持可用`, async () => {
      const { point } = await execute(boardId, scope => crossRows(scope).map(row => scope.clientPlatform === "android" && scope.userCohort === "new"
        ? { ...row, dimensions: { pid: "PH", userCohort: "new" } } : row));
      for (const code of codes) {
        expect(point(`${code}.androidNew`)).toMatchObject({ state: "source_failure", value: null });
        expect(point(`${code}.iosNew`).state).toBe("available");
        expect(point(`${code}.new`).state).toBe("available");
      }
    });
  }
});

describe("bi-v1 分维单位与状态回归", () => {
  const date = "2026-09-05";
  const metricRow = (metricCode: string, overrides: Record<string, unknown> = {}) => ({
    metricCode, businessDate: date, dimensions: { pid: "PH" }, value: 1, numerator: 1, denominator: 0,
    unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1", ...overrides
  });
  const execute = (rows: Record<string, unknown>[], boardId = "5.2") => new DailyDashboardService({ get: async (path, params) => {
    if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: {
      metricVersion: "bi-v1", generatedAt: "2026-09-06T10:00:00+08:00", watermark: null, rows: rows.filter(row => params.metricCodes.split(",").includes(String(row.metricCode)))
    } };
    return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
  } }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [date, date] });

  for (const cohortField of ["userCohort", "userType"] as const) {
    for (const [numerator, denominator] of [[2, 3], [5, 2]] as const) {
      test(`人均广告次数按${cohortField}读取count_per_user并保留${numerator}/${denominator}精确结果`, async () => {
        const result = await execute([metricRow("M110", {
          dimensions: { pid: "PH", [cohortField]: "new" }, value: numerator / denominator,
          numerator, denominator, unit: "count_per_user"
        })]);
        const series = result.data.series.find(item => item.metric.id === "M110.new")!;
        expect(series.points[0]).toMatchObject({ state: "available", sourceStatus: "READY", value: numerator / denominator,
          inputs: [{ key: "newUserAdClickCount", value: numerator }, { key: "newUserActiveUserCount", value: denominator }] });
        expect(series.metric).toMatchObject({ unit: "次/人", inputs: [{ unit: "次" }, { unit: "人" }] });
        expect(series.periodStatistics.state).toBe("unsupported");
        expect(dailyDashboardMatchesMapping(result)).toBe(true);
      });
    }
  }

  for (const [numerator, denominator, value, state] of [[0, 2, 0, "available"], [0, 0, null, "zero_denominator"]] as const) {
    test(`人均广告次数保留${state}状态与真实输入`, async () => {
      const result = await execute([metricRow("M110", {
        dimensions: { pid: "PH", userCohort: "new" }, value, numerator, denominator, unit: "count_per_user"
      })]);
      expect(result.data.series.find(item => item.metric.id === "M110.new")!.points[0]).toMatchObject({
        state, value, sourceStatus: "READY", inputs: [{ value: numerator }, { value: denominator }]
      });
    });
  }

  for (const unit of ["ratio", "count"] as const) {
    test(`人均广告次数拒绝错误${unit}单位，不消费其数值与输入`, async () => {
      const result = await execute([metricRow("M110", {
        dimensions: { pid: "PH", userCohort: "new" }, unit,
        value: unit === "count" ? 2 : 2 / 3, numerator: 2, denominator: unit === "count" ? 0 : 3
      })]);
      expect(result.data.series.find(item => item.metric.id === "M110.new")!.points[0]).toMatchObject({
        state: "invalid_value", value: null, sourceStatus: "READY", inputs: [{ value: null }, { value: null }]
      });
    });
  }

  test("广告渗透率不展示超过100%的异常值，人均次数仍可大于1", async () => {
    const result = await execute([
      metricRow("M111", { value: 2, numerator: 2, denominator: 1, unit: "ratio" }),
      metricRow("M111", { dimensions: { pid: "PH", userCohort: "new" }, value: 2, numerator: 2, denominator: 1, unit: "ratio" }),
      metricRow("M110", { value: 2, numerator: 2, denominator: 1, unit: "count_per_user" })
    ]);
    for (const id of ["M111", "M111.new"]) expect(result.data.series.find(s => s.metric.id === id)!.points[0])
      .toMatchObject({ state: "invalid_value", value: null });
    expect(result.data.series.find(s => s.metric.id === "M110")!.points[0]).toMatchObject({ state: "available", value: 2 });
  });

  test("普通比率拒绝count_per_user，保留同批合法人均广告结果", async () => {
    const result = await execute([
      metricRow("M110", { dimensions: { pid: "PH", userCohort: "new" }, value: 2 / 3, numerator: 2, denominator: 3, unit: "count_per_user" }),
      metricRow("M111", { dimensions: { pid: "PH", userCohort: "new" }, value: .5, numerator: 1, denominator: 2, unit: "count_per_user" }),
      metricRow("M114", { value: .5, numerator: 1, denominator: 2, unit: "count_per_user" }),
      metricRow("M114", { dimensions: { pid: "PH", paymentMethod: "ali_pay" }, value: .5, numerator: 1, denominator: 2, unit: "count_per_user" })
    ]);
    const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
    expect(point("M110.new")).toMatchObject({ state: "available", sourceStatus: "READY", value: 2 / 3,
      inputs: [{ value: 2 }, { value: 3 }] });
    for (const id of ["M111.new", "M114", "M114.alipay"]) {
      expect(point(id)).toMatchObject({ state: "invalid_value", sourceStatus: "READY", value: null,
        inputs: [{ value: null }, { value: null }] });
    }
  });

  for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
    test(`广告分维和留存人数保留${dataStatus}而不消费附带数值`, async () => {
      const result = await execute([
        ...["M110", "M111"].map(code => metricRow(code, {
          dimensions: { pid: "PH", userCohort: "new" }, value: .5, numerator: 1, denominator: 2,
          unit: code === "M110" ? "count_per_user" : "ratio", dataStatus
        })),
        metricRow("M020", { value: .5, numerator: 1, denominator: 2, unit: "ratio", dataStatus })
      ]);
      const ids = dataStatus === "SOURCE_INCOMPLETE" ? ["M110.new", "M111.new"] : ["M110.new", "M111.new", "M020", "M115.d1"];
      for (const id of ids) {
        const point = result.data.series.find(item => item.metric.id === id)!.points[0];
        expect(point).toMatchObject({ state, sourceStatus: dataStatus, value: null });
        expect(point.inputs.map(input => input.value)).toEqual(dataStatus === "SOURCE_INCOMPLETE" && id === "M111.new" ? [1, 2] : point.inputs.map(() => null));
      }
    });
  }

  const paymentCodes = ["M112", "M113", "M060", "M114"] as const;
  const paymentRows = (dimensions: Record<string, string>, [requests, users, successes]: readonly [number, number, number], dataStatus = "READY") => [
    metricRow("M112", { dimensions: { pid: "PH", ...dimensions }, value: requests, numerator: requests, dataStatus }),
    metricRow("M113", { dimensions: { pid: "PH", ...dimensions }, value: users, numerator: users, dataStatus }),
    metricRow("M060", { dimensions: { pid: "PH", ...dimensions }, value: successes, numerator: successes, dataStatus }),
    metricRow("M114", { dimensions: { pid: "PH", ...dimensions }, value: successes / requests,
      numerator: successes, denominator: requests, unit: "ratio", dataStatus })
  ];
  const paymentMethods = [
    { id: "alipay", formal: "ali_pay", counts: [2, 1, 1] },
    { id: "wechat", formal: "wx_pay", counts: [5, 3, 2] },
    { id: "usdt", formal: "usdt_pay", counts: [11, 6, 7] }
  ] as const;

  for (const dimensionField of ["paymentMethod", "payment_method"] as const) {
    for (const boardId of ["5.2", "5.11"]) {
      for (const sourceValues of ["formal", "legacy"] as const) {
        test(`${boardId}按${dimensionField}的${sourceValues}支付值精确分组，总体与unknown独立`, async () => {
          const result = await execute([
            ...paymentRows({}, [41, 23, 17]),
            ...paymentMethods.flatMap(method => paymentRows({ [dimensionField]: sourceValues === "formal" ? method.formal : method.id }, method.counts)),
            ...paymentRows({ [dimensionField]: "unknown" }, [101, 70, 89])
          ], boardId);
          const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
          for (const [method, requests, users, successes] of [["all", 41, 23, 17], ["alipay", 2, 1, 1], ["wechat", 5, 3, 2], ["usdt", 11, 6, 7], ["unknown", 101, 70, 89]] as const) {
            const values = [requests, users, successes, successes / requests];
            paymentCodes.forEach((code, index) => {
              const id = method === "all" ? code : `${code}.${method}`;
              expect(point(id)).toMatchObject({ state: "available", value: values[index], sourceStatus: "READY" });
              expect(point(id).inputs.map(input => input.value)).toEqual(code === "M114" ? [successes, requests] : [values[index]]);
            });
          }
          expect(dailyDashboardMatchesMapping(result)).toBe(true);
        });
      }

      test(`${boardId}仅有${dimensionField}=unknown时不生成总体或三种支付方式结果`, async () => {
        const result = await execute(paymentRows({ [dimensionField]: "unknown" }, [101, 70, 89]), boardId);
        paymentCodes.forEach((code, index) => expect(result.data.series.find(series => series.metric.id === `${code}.unknown`)!.points[0])
          .toMatchObject({ state: "available", value: [101, 70, 89, 89 / 101][index], sourceStatus: "READY" }));
        for (const code of paymentCodes) for (const method of ["", ".alipay", ".wechat", ".usdt"]) {
          const id = `${code}${method}`;
          const point = result.data.series.find(series => series.metric.id === id)!.points[0];
          expect(point).toMatchObject({
            state: "source_failure", value: null
          });
          expect(point).not.toHaveProperty("sourceStatus");
          expect(point.inputs.every(input => input.value === null)).toBe(true);
        }
      });

      for (const [dataStatus, state] of [["PROCESSING", "no_value"], ["SOURCE_INCOMPLETE", "no_value"], ["NOT_MATURE", "immature"], ["FAILED", "source_failure"]] as const) {
        test(`${boardId}的${dimensionField}分组${dataStatus}状态独立于总体READY`, async () => {
          for (const businessDate of [date, undefined]) {
            const result = await execute([
              ...paymentRows({}, [41, 23, 17]),
              ...paymentMethods.flatMap(method => paymentRows({ [dimensionField]: method.formal }, method.counts, dataStatus)
                .map(row => ({ ...row, businessDate }))),
              ...paymentRows({ [dimensionField]: "unknown" }, [101, 70, 89], dataStatus).map(row => ({ ...row, businessDate }))
            ], boardId);
            const point = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0];
            paymentCodes.forEach((code, index) => {
              expect(point(code)).toMatchObject({ state: "available", value: [41, 23, 17, 17 / 41][index], sourceStatus: "READY" });
              for (const method of [...paymentMethods, { id: "unknown", counts: [101, 70, 89] }]) {
                expect(point(`${code}.${method.id}`)).toMatchObject({ state, value: null, sourceStatus: dataStatus });
                expect(point(`${code}.${method.id}`).inputs.map(input => input.value)).toEqual(dataStatus === "SOURCE_INCOMPLETE" && businessDate && code === "M114"
                  ? [method.counts[2], method.counts[0]] : point(`${code}.${method.id}`).inputs.map(() => null));
              }
            });
          }
        });
      }
    }
  }

  test("D1/D3/D7/D30人数使用同批精确分子，零基数保留人数真零", async () => {
    const codes = ["M020", "M021", "M022", "M023"] as const;
    const periods = ["d1", "d3", "d7", "d30"] as const;
    for (const denominator of [3, 0]) {
      const numerator = denominator ? 1 : 0;
      const result = await execute(codes.map(code => metricRow(code, {
        value: denominator ? numerator / denominator : null, numerator, denominator, unit: "ratio"
      })));
      codes.forEach((code, index) => {
        const ratio = result.data.series.find(item => item.metric.id === code)!.points[0];
        const count = result.data.series.find(item => item.metric.id === `M115.${periods[index]}`)!.points[0];
        expect(count).toMatchObject({ state: "available", sourceStatus: "READY", value: numerator, inputs: [{ value: numerator }] });
        expect(ratio).toMatchObject({ state: denominator ? "available" : "zero_denominator", inputs: [{ value: numerator }, { value: denominator }] });
      });
    }
  });

  test("支付方式计数和比率输入保留次单位，人数保持人单位", () => {
    const definitions = dailyDashboardProjectionDocumentation();
    for (const method of ["alipay", "wechat", "usdt"]) {
      for (const code of ["M060", "M112", "M114"]) {
        expect(definitions.find(metric => metric.id === `${code}.${method}`)!.inputs.map(input => input.unit))
          .toEqual(code === "M114" ? ["次", "次"] : ["次"]);
      }
      expect(definitions.find(metric => metric.id === `M113.${method}`)!.inputs[0].unit).toBe("人");
    }
  });

  test("月活独立读取自然月汇总，不生成每日快照、日均或合计", async () => {
    const nextDate = "2026-09-06";
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path === "/api/admin/bi/v1/metrics" && params.metricCodes === "M018") {
        expect(params).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-10", granularity: "summary" });
        return { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: "2026-09-07T10:00:00+08:00", watermark: null,
        rows: [metricRow("M018", { businessDate: undefined, value: 15, numerator: 15 })]
      } }; }
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-10T00:00:00Z")).execute({ boardId: "5.8", pid: "PH", dateRange: [date, nextDate] });
    const series = result.data.series.find(item => item.metric.id === "M018")!;
    expect(series.points.map(point => point.value)).toEqual([null, 15]);
    expect(series.periodStatistics).toMatchObject({ state: "unsupported", values: [] });
  });

  test("下载去重IP日值可计算日均，跨日可能重复的IP不生成区间合计", async () => {
    const nextDate = "2026-09-06";
    const result = await new DailyDashboardService({ get: async path => {
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: "2026-09-07T10:00:00+08:00", watermark: null,
        rows: [date, nextDate].map(businessDate => metricRow("M095", { businessDate, value: 3, numerator: 3 }))
      } };
      return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
    } }, () => new Date("2026-09-10T00:00:00Z")).execute({ boardId: "5.7", pid: "PH", dateRange: [date, nextDate] });
    const series = result.data.series.find(item => item.metric.id === "M095")!;
    expect(series.points.map(point => point.value)).toEqual([3, 3]);
    expect(series.periodStatistics).toMatchObject({ state: "available", values: [{ kind: "daily_average", value: 3 }] });
    expect(series.periodStatistics.values.some(value => value.kind === "period_sum")).toBe(false);
  });
});

describe("多来源真实数据边界",()=>{
  for (const scope of ["payment-summary", "payment-row", "channel-summary", "checkin"] as const) test(`已回显的PID冲突拒绝，来源独立隔离：${scope}`, async()=>{
    const day="2026-09-05";
    const result=await new DailyDashboardService({get:async(path)=>{
      if(path.endsWith("pDaySum"))return{msg:{pageData:[row()],totalCount:1}};
      if(path.includes("reletionsStatPlus"))return{data:[]};
      if(path.includes("channelStatByTypeV2"))return{msg:{pageData:[],totalData:[{pid:scope==="channel-summary"?"FBI":"PH",sumDate:day,natureRegisterCount:12}]}};
      if(path.includes("dataDashboard/overview"))return{msg:{pid:"FBI",date:day,signInRate:{raw:{signed:20}}}};
      return{msg:{pid:scope==="payment-summary"?"FBI":"PH",pageData:[{pid:scope==="payment-row"?"FBI":"PH",sumDate:day}],totalAllCount:10}};
    }}).execute({...query,boardId:scope==="checkin"?"5.14":"5.2",dateRange:[day,day]});
    const id=scope==="checkin"?"M075":scope==="channel-summary"?"M008.nature":"M112";
    expect(result.data.series.find(series=>series.metric.id===id)!.points[0]).toMatchObject({state:"source_failure",value:null});
    if(scope!=="checkin")expect(result.data.series.find(series=>series.metric.id==="M016")!.points[0].value).toBe(100);
  });
  test("签到来源按所选日独立读取，不触发无关来源，不用比例或UV替代人数",async()=>{
    const paths:string[]=[];
    const result=await new DailyDashboardService({get:async(path,params)=>{
      paths.push(path);expect(params.pid).toBe("PH");
      return {msg:{date:params.date,uv:{value:999},signInRate:{value:50,raw:{signed:0,dau:500}},taskCompleteRate:{raw:{task:99}}}};
    }}).execute({...query,boardId:"5.14"});
    expect(paths.every(path=>path==="/api/admin/dataDashboard/overview")).toBe(true);
    expect(result.data.series).toHaveLength(1);
    expect(result.data.series[0].points.every(point=>point.state==="available"&&point.value===0)).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
    expect(result.data.sourceApiIds).toEqual(["/api/admin/dataDashboard/overview"]);
  });
  test("签到返回日期不一致拒绝，缺人数不补0",async()=>{
    for(const [msg,state] of [[{date:"2026-08-01",signInRate:{raw:{signed:20}}},"source_failure"],[{date:query.dateRange[0]},"no_value"]] as const){
      const result=await new DailyDashboardService({get:async()=>({msg})}).execute({...query,boardId:"5.14",dateRange:[query.dateRange[0],query.dateRange[0]]});
      expect(result.data.series[0].points[0]).toMatchObject({state,value:null});
    }
  });
  const day="2026-08-01", q={...query,dateRange:[day,day] as [string,string]};
  const make=(badDaily=false,badCohort=false)=>new DailyDashboardService({get:async(path,params)=>{
    expect(params.pid).toBe("PH");
    if(path.endsWith("pDaySum")){if(badDaily)throw new Error("source unavailable");return{msg:{pageData:[row({sumDate:day})],totalCount:1}};}
    if(path.includes("reletionsStatPlus"))return{data:[{pid:badCohort?"FBI":"PH",sumDate:day,registerCount:100,...Object.fromEntries([1,3,7,30].map(days=>["afterFirstData"+days,{date:new Date(Date.parse(day)+days*86400000).toISOString().slice(0,10),loginCnt:days===1?0:20,retentionRate:"99.99%"}]))}]};
    if(path.includes("channelStatByTypeV2"))return{msg:{pageData:[{pid:"PH",sumDate:day,natureRegisterCount:999}],totalData:[{natureRegisterCount:40,channelInternalRegisterCount:20,vipChargeAmt:"30.25",goldChargeAmt:"10.25",oldUserWatchUserCount:20,oldUserLoginUserCount:40}]}};
    if(path === "/api/admin/bi/v1/metrics")return{code:200,msg:{metricVersion:"bi-v1",generatedAt:"2026-09-12T10:00:00+08:00",watermark:null,rows:[
      {metricCode:"M008",businessDate:day,dimensions:{pid:"PH",acquisitionType:"natural"},value:40,numerator:40,denominator:0,unit:"count",dataStatus:"READY",metricVersion:"bi-v1",ruleVersion:"rule-v1"},
      ...([["alipay",3,4],["wechat",4,5]] as const).map(([paymentMethod,numerator,denominator])=>({metricCode:"M114",businessDate:day,dimensions:{pid:"PH",payment_method:paymentMethod},value:numerator/denominator,numerator,denominator,unit:"ratio",dataStatus:"READY",metricVersion:"bi-v1",ruleVersion:"rule-v1"}))
    ].filter(row => params.metricCodes.split(",").includes(row.metricCode))}};
    return{msg:{pageData:[{sumDate:day,payType:"ali_pay"}],totalAllCount:10,totalSurCount:7,aliTotalCount:4,aliTotalSucCount:3,wxTotalCount:5,wxTotalSucCount:4,totalSucRate:"99%",globalTotalCount:99999,privateToken:"never-return"}};
  }},()=>new Date("2026-09-12T00:00:00Z"));
  test("渠道独立合计、支付总体、方式切片保持各自来源",async()=>{
    const result=await make().execute(q),s=(id:string)=>result.data.series.find(s=>s.metric.id===id)!;
    expect(s("M008.nature").points[0].value).toBe(40);
    expect(s("M065").points[0].value).toBe(30.25);
    expect(s("M081.old").points[0].value).toBe(.5);
    expect(s("M112").points[0].value).toBe(10);
    expect(s("M114").points[0].value).toBe(.7);
    expect(s("M114.alipay").points[0].value).toBe(.75);
    expect(s("M114.wechat").points[0].value).toBe(.8);
    expect(s("M114").metric.inputs.every(i=>i.unit==="次")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("global");expect(JSON.stringify(result)).not.toContain("never-return");
  });
  test("一个来源失败不阻断其他三个来源",async()=>{
    const result=await make(true).execute(q),s=(id:string)=>result.data.series.find(s=>s.metric.id===id)!.points[0];
    expect(s("M016")).toMatchObject({state:"source_failure",value:null});
    expect(s("M020")).toMatchObject({state:"available",value:0});
    expect(s("M065").state).toBe("available");expect(s("M114").state).toBe("available");
  });
  test("留存跨平台拒绝，不污染日汇总或支付",async()=>{
    const result=await make(false,true).execute(q);
    expect(result.data.series.find(s=>s.metric.id==="M020")!.points[0].state).toBe("source_failure");
    expect(result.data.series.find(s=>s.metric.id==="M016")!.points[0].value).toBe(100);
  });
  test("留存使用计数计算而非接口百分数字符串，未结束观察不采0",async()=>{
    const result=await make().execute(q);
    expect(result.data.series.find(s=>s.metric.id==="M023")!.points[0].value).toBe(.2);
    const recent=await new DailyDashboardService({get:async(path)=>path === "/api/admin/bi/v1/metrics" ? emptyMetrics : path.includes("reletionsStatPlus")?{data:[{pid:"PH",sumDate:"2026-09-11",registerCount:100,afterFirstData1:{date:"2026-09-12",loginCnt:0}}]}:{msg:{pageData:[],totalCount:0}}},()=>new Date("2026-09-12T08:00:00Z")).execute({...q,boardId:"5.8",dateRange:["2026-09-11","2026-09-11"]});
    expect(recent.data.series.find(s=>s.metric.id==="M020")!.points[0]).toMatchObject({state:"immature",value:null,inputs:[{value:null},{value:100}]});
  });
});

describe("日看板真实候选读取", () => {
  test("旧直接字段与广告总量保持独立，金额和付费率等待bi-v1结果", async () => {
    const result = await service().execute(query);
    const value = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0].value;
    expect(value("M016")).toBe(100); expect(value("M008")).toBe(30);
    expect(value("M081")).toBe(.8);
    expect(result.data.series.find(series => series.metric.id === "M059")!.points[0]).toMatchObject({ state: "no_record", value: null });
    for (const id of ["M058", "M067", "M087", "M061"]) expect(result.data.series.find(series => series.metric.id === id)!.points[0]).toMatchObject({ state: "no_record", value: null });
    expect(result.data.series.find(series=>series.metric.id==="M058")!.metric).toMatchObject({unit:"元",inputs:[{unit:"元"}]});
    for(const id of ["M067","M087"]) expect(result.data.series.find(series=>series.metric.id===id)!.metric).toMatchObject({unit:"元/人",inputs:[{unit:"元"},{unit:"人"}]});
    expect(result.data.series.find(series=>series.metric.id==="M058")!.metric.sourceNote).toContain("人民币元");
    expect(value("M055.navigation")).toBe(5); expect(value("M055.total")).toBe(26); expect(value("M094.total")).toBe(11);
    expect(value("M110")).toBe(.2); expect(value("M111")).toBe(.1);
    expect(JSON.stringify(result)).not.toContain("must-never-project");
    expect(result.data).toMatchObject({ validationStatus: "pending_validation", completeness: "unknown", watermark: null });
    expect(result.data.series.find(series=>series.metric.id==="M016")!.points[1].state).toBe("no_record");
    expect(dailyDashboardSuccessSchema.safeParse(result).success).toBe(true);
    expect(dailyDashboardMatchesQuery(result, query, dailyDashboardCatalog(true).data.items[0].metricIds)).toBe(true);
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
  test("真实0、缺字段和无记录不同，不回退近似新增字段", async () => {
    expect((await getSeries("M016", { loginUserCount: 0 })).points[0]).toMatchObject({ value: 0, state: "available" });
    expect((await getSeries("M008", { registerUserCount: null, newUserCount: 900 })).points[0]).toMatchObject({ value: null, state: "no_value" });
    expect((await getSeries("M081", { loginUserCount: 0 })).points[0].state).toBe("zero_denominator");
    expect((await getSeries("M081", { watchUserCount: 101 })).points[0].state).toBe("invalid_value");
    expect((await service([]).execute(query)).data.series.find(series=>series.metric.id==="M016")!.points.every(point => point.state === "no_record")).toBe(true);
  });
  for (const bad of [-1, true, {}, "NaN", "Infinity", "0x10", "1e3", "0b10", 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    test(`坏人数独立失败 ${JSON.stringify(bad)}`, async () => {
      const result = await service([row({ loginUserCount: bad })]).execute(query);
      expect(result.data.series.find(series => series.metric.id === "M016")!.points[0].state).toBe("invalid_value");
      expect(result.data.series.find(series => series.metric.id === "M026")!.points[0].value).toBe(80);
    });
  }
  test("旧金额不参与bi-v1金额状态，不补0", async () => {
    expect((await getSeries("M058", { diamondChargeAmt: "-10.5" })).points[0].state).toBe("no_record");
    expect((await getSeries("M058", { diamondChargeAmt: " " })).points[0].state).toBe("no_record");
  });
  for (const rows of [[row(), row()], [row({ pid: "FBI" })], [row({ sumDate: "2026-09-07" })], [row({ sumDate: "2026-02-31" })], [row({ sumDate: "nonsense" })]]) {
    test("来源日期/PID冲突隔离日汇总来源", async () => { const result=await service(rows).execute(query); expect(result.data.series.find(series=>series.metric.id==="M016")!.points.every(point=>point.state==="source_failure"&&point.value===null)).toBe(true); });
  }
  for (const envelope of [{ totalCount: 2 }, { totalCount: "0x1" }, { totalCount: 1, total: 2 }, { totalCount: null, total: null }]) {
    test("分页数目缺失/冲突/截断不显示日汇总", async () => { const result=await service([row()],envelope).execute(query);expect(result.data.series.find(series=>series.metric.id==="M016")!.points.every(point=>point.state==="source_failure"&&point.value===null)).toBe(true); });
  }
  test("新增付费与同群比率缺少bi-v1结果时保持未返回记录", async () => {
    const result = await service().execute({ ...query, boardId: "5.7" });
    expect(["M008","M059.new","M064"].map(id=>result.data.series.find(series=>series.metric.id===id)!.points[0].value)).toEqual([30, null, null]);
  });
  test("查询上限366天与严格请求", () => {
    for (const dateRange of [["2024-01-01", "2024-12-31"], ["2026-09-05", "2026-09-05"]]) expect(dailyDashboardQuerySchema.safeParse({ ...query, dateRange }).success).toBe(true);
    for (const dateRange of [["2024-01-01", "2025-01-01"], ["2026-09-06", "2026-09-05"], ["2026-02-30", "2026-03-01"]]) expect(dailyDashboardQuerySchema.safeParse({ ...query, dateRange }).success).toBe(false);
    expect(dailyDashboardQuerySchema.safeParse({ ...query, token: "not-accepted" }).success).toBe(false);
  });
  test("开关默认关闭，生产及非本地监听不可开启", () => {
    expect(loadEnv({}).BI_LOCAL_DASHBOARD_READING_ENABLED).toBe(false);
    expect(loadEnv({ BI_LOCAL_DASHBOARD_READING_ENABLED: "true" }).BI_LOCAL_DASHBOARD_READING_ENABLED).toBe(true);
    for (const settings of [{ NODE_ENV: "production" }, { HOST: "0.0.0.0" }]) expect(() => loadEnv({ ...settings, BI_LOCAL_DASHBOARD_READING_ENABLED: "true" })).toThrow("仅允许非生产环境");
  });
  test("测试数据模式显式开启且要求完整后台配置，生产地址必须使用 HTTPS", () => {
    expect(loadEnv({}).BI_TEST_DATA_PREVIEW_ENABLED).toBe(false);
    expect(() => loadEnv({ BI_TEST_DATA_PREVIEW_ENABLED: "true" })).toThrow("必须配置测试后台地址和用户名");
    expect(() => loadEnv({ UPSTREAM_TEST_API_BASE_URL: "https://test.example.com" })).toThrow("必须同时配置或同时省略");
    expect(loadEnv({ BI_TEST_DATA_PREVIEW_ENABLED: "true", UPSTREAM_TEST_API_BASE_URL: "https://test.example.com", UPSTREAM_TEST_USER_NAME: "test-user" }).BI_TEST_DATA_PREVIEW_ENABLED).toBe(true);
  });
});

describe("服务端所选日期合计与日均", () => {
  test("自然新增与内部导量独立返回周期累计，缺日与非READY不输出部分累计", async () => {
    for (const scenario of ["complete", "zero", "missing", "processing"] as const) {
      const result = await new DailyDashboardService({ get: async (path, params) => {
        if (path !== "/api/admin/bi/v1/metrics") return { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] };
        const requested = params.dimensionFilters ? JSON.parse(params.dimensionFilters) : {};
        return { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-07T10:00:00+08:00", watermark: null,
          rows: ["natural", "internal_channel"].flatMap(sourceType => query.dateRange.flatMap((businessDate, index) => {
            if (!params.metricCodes.split(",").includes("M008") || requested.sourceType && requested.sourceType !== sourceType) return [];
            if (scenario === "missing" && sourceType === "natural" && index === 1) return [];
            const value = sourceType === "natural" ? scenario === "zero" ? 0 : index + 2 : index + 4;
            return [{ metricCode: "M008", businessDate, dimensions: { pid: "PH", sourceType }, value, numerator: value, denominator: 0,
              unit: "count", dataStatus: scenario === "processing" && sourceType === "natural" && index === 1 ? "PROCESSING" : "READY",
              metricVersion: "bi-v1", ruleVersion: "registration-test" }];
          })) } };
      } }, () => new Date("2026-09-08T00:00:00Z")).execute({ ...query, boardId: "5.7" });
      const stats = (id: string) => result.data.series.find(series => series.metric.id === id)!.periodStatistics;
      expect(stats("M008.internal")).toMatchObject({ state: "available", values: [{ kind: "period_sum", value: 9 }, { kind: "daily_average", value: 4.5 }] });
      expect(stats("M008.nature")).toMatchObject(scenario === "missing" || scenario === "processing" ? { state: "incomplete", values: [] }
        : { state: "available", values: [{ kind: "period_sum", value: scenario === "zero" ? 0 : 5 }, { kind: "daily_average", value: scenario === "zero" ? 0 : 2.5 }] });
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    }
  });
  test("金额保持元的小数原值，时长从原始秒汇总后换算小时；缺日与人均不混算", async () => {
    const make=(missing=false)=>new DailyDashboardService({get:async(path,params)=>{
      if(path === "/api/admin/bi/v1/metrics") {
        const filters=JSON.parse(params.dimensionFilters??"{}");
        return {code:200,msg:{...emptyMetrics.msg,rows:query.dateRange.flatMap((businessDate,index)=>missing&&index===1?[]:["M058","M102"].filter(code=>params.metricCodes.split(",").includes(code)).map(metricCode=>{
          const value=metricCode==="M102"?1801:index===0?.1:.2;
          return {metricCode,businessDate,dimensions:{pid:"PH",...filters},value,numerator:value,denominator:0,unit:metricCode==="M102"?"seconds":"currency",dataStatus:"READY",metricVersion:"bi-v1",ruleVersion:metricCode==="M102"?"foreground-watch-duration-v1":"paid-order-value-v1"};
        }))}};
      }
      if(path.endsWith("pDaySum"))return{msg:{pageData:[row({diamondChargeAmt:.1}),row({sumDate:"2026-09-06",diamondChargeAmt:.2})],totalCount:2}};
      if(path.includes("channelStatByTypeV2"))return{msg:{pageData:[],totalData:missing&&params.sumDateBegin.startsWith("2026-09-06")?[]:[{totalUserWatchTime:1801,watchUserCount:2,vipChargeAmt:.1,goldChargeAmt:.2,newUserVipChargeAmt:.1,newUserGoldChargeAmt:.1,natureChargeAmt:.1,channelInternalChargeAmt:.1}]}};
      return{msg:{pageData:[],totalCount:0},data:[]};
    }},()=>new Date("2026-09-14T00:00:00Z"));
    const r=await make().execute(query),get=(id:string)=>r.data.series.find(s=>s.metric.id===id)!;
    expect(get("M058").periodStatistics.values[0].value).toBeCloseTo(.3,12);
    expect(get("M058").periodStatistics.values[1].value).toBeCloseTo(.15,12);
    expect(get("M102").periodStatistics.values).toEqual([{kind:"period_sum",value:3602/3600},{kind:"daily_average",value:1801/3600}]);
    for(const id of ["M065","M066","M065.new","M066.new","M058.nature","M058.internal"])expect(get(id).periodStatistics.state).toBe("available");
    for(const id of ["M067","M087","M088","M067.new","M098"])expect(get(id).periodStatistics.state).toBe("unsupported");
    const incomplete=await make(true).execute(query);
    for(const id of ["M102","M065"])expect(incomplete.data.series.find(s=>s.metric.id===id)!.periodStatistics.state).toBe("incomplete");
  });
  const twoDays = (first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) => service([
    row({ totalVistCount: 0, ...first }), row({ sumDate: "2026-09-06", totalVistCount: 5, loginUserCount: 200, registerUserCount: 50, ...second })
  ]);
  test("v2服务端累计次数、新增并保留小数日均，真实0参与", async () => {
    const result = await twoDays().execute(query), get = (id: string) => result.data.series.find(item => item.metric.id === id)!.periodStatistics;
    expect(result.data.schemaVersion).toBe("day-dashboard/v2");
    expect(get("M001")).toMatchObject({ state: "available", dayCount: 2, dateRange: query.dateRange,
      values: [{ kind: "period_sum", value: 5 }, { kind: "daily_average", value: 2.5 }], reason: null });
    expect(get("M008").values).toEqual([{ kind: "period_sum", value: 80 }, { kind: "daily_average", value: 40 }]);
    expect(result.data).toMatchObject({ validationStatus: "pending_validation", completeness: "unknown", watermark: null });
    expect(dailyDashboardMatchesMapping(result)).toBe(true);
  });
  test("日去重人数仅提供日均，比率、人均、固定批次不生成周期值", async () => {
    const result = await twoDays().execute(query), get = (id: string) => result.data.series.find(item => item.metric.id === id)!.periodStatistics;
    expect(get("M016").values).toEqual([{ kind: "daily_average", value: 150 }]);
    expect(get("M026").values).toEqual([{ kind: "daily_average", value: 80 }]);
    expect(get("M059")).toMatchObject({ state: "incomplete", values: [] });
    for (const id of ["M081", "M061", "M067", "M020", "M098"]) expect(get(id)).toMatchObject({ state: "unsupported", values: [] });
    expect(get("M058")).toMatchObject({state:"incomplete",values:[]});
  });
  test("全零合法且单日保持同一统计规则", async () => {
    const result = await twoDays({}, { totalVistCount: 0 }).execute(query);
    expect(result.data.series.find(item => item.metric.id === "M001")!.periodStatistics.values).toEqual([{ kind: "period_sum", value: 0 }, { kind: "daily_average", value: 0 }]);
    const one = await service([row({ totalVistCount: 5 })]).execute({ ...query, dateRange: [query.dateRange[0], query.dateRange[0]] });
    expect(one.data.series.find(item => item.metric.id === "M001")!.periodStatistics).toMatchObject({ dayCount: 1, values: [{ kind: "period_sum", value: 5 }, { kind: "daily_average", value: 5 }] });
  });
  test("缺记录、缺值、异常和来源失败都不能跳过后输出整段统计", async () => {
    for (const source of [service([row({ totalVistCount: 5 })]), twoDays({}, { totalVistCount: null }), twoDays({}, { totalVistCount: -1 }), service([row(), row()])]) {
      const result = await source.execute(query);
      expect(result.data.series.find(item => item.metric.id === "M001")!.periodStatistics).toMatchObject({ state: "incomplete", values: [] });
    }
  });
  test("未结束业务日与未来日期保留日值但不生成周期统计", async () => {
    for (const now of ["2026-09-05T16:00:00.000Z", "2026-09-04T16:00:00.000Z"]) {
      const result = await new DailyDashboardService({ get: async path => path.endsWith("pDaySum") ? { msg: { pageData: [row({ totalVistCount: 5 }), row({ sumDate: "2026-09-06", totalVistCount: 10 })], totalCount: 2 } } : { msg: { pageData: [], totalData: [], totalCount: 0 } } }, () => new Date(now)).execute(query);
      const item = result.data.series.find(item => item.metric.id === "M001")!;
      expect(item.points.map(point => point.value)).toEqual([5, 10]);
      expect(item.periodStatistics).toMatchObject({ state: "incomplete", values: [], reason: "所选日期包含尚未结束的业务日" });
      expect(dailyDashboardMatchesMapping(result)).toBe(true);
    }
  });
  test("超过安全整数范围的累计不展示失真值", async () => {
    const result = await twoDays({ totalVistCount: Number.MAX_SAFE_INTEGER }, { totalVistCount: 1 }).execute(query);
    expect(result.data.series.find(item => item.metric.id === "M001")!.periodStatistics).toMatchObject({ state: "incomplete", values: [], reason: "日值合计超出可安全计算的范围" });
  });
  test("渠道与支付次数按各自独立日汇总累计，计算率保持日值", async () => {
    const result = await new DailyDashboardService({ get: async (path, params) => {
      if (path.endsWith("pDaySum")) return { msg: { pageData: [], totalCount: 0 } };
      if (path.includes("reletionsStatPlus")) return { data: [] };
      if (path.includes("channelStatByTypeV2")) return { msg: { pageData: [], totalData: [{ totalDownCountNoDedup: params.sumDateBegin.startsWith("2026-09-05") ? 1 : 4, visiCountNoDedup: 10 }] } };
      if (path === "/api/admin/bi/v1/metrics") return { code: 200, msg: {
        metricVersion: "bi-v1", generatedAt: "2026-09-07T10:00:00+08:00", watermark: null,
        rows: query.dateRange.map(businessDate => ({ metricCode: "M112", businessDate, dimensions: { pid: "PH", payment_method: "alipay" },
          value: 2, numerator: 2, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1" }))
      } };
      return { msg: { pageData: [], totalAllCount: 10, totalSurCount: params.startTime.startsWith("2026-09-05") ? 3 : 8, aliTotalCount: 2, aliTotalSucCount: 1 } };
    } }).execute(query);
    const get = (id: string) => result.data.series.find(item => item.metric.id === id)!.periodStatistics;
    expect(get("M003").values).toEqual([{ kind: "period_sum", value: 5 }, { kind: "daily_average", value: 2.5 }]);
    expect(get("M060").values).toEqual([{ kind: "period_sum", value: 11 }, { kind: "daily_average", value: 5.5 }]);
    expect(get("M112.alipay").values).toEqual([{ kind: "period_sum", value: 4 }, { kind: "daily_average", value: 2 }]);
    expect(get("M005").state).toBe("unsupported"); expect(get("M114").state).toBe("unsupported");
  });
});

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const reader = (role = "reader", pidScope: "all" | string[] = ["PH"]): IdentityResolution => ({ status: "authenticated", principal: { subjectId: "test", roles: [role], permissions: ["bi:read"], pidScope } });
async function appFor(identity: IdentityResolution = reader(), executor: DailyDashboardExecutor | undefined = service()) {
  const app = Fastify(); apps.push(app);
  await app.register(v2BiPlugin, {
    prefix: "/api/bi/v2",
    identityProvider: { resolve: async () => identity },
    metricQueryService: { execute: async () => { throw Error("formal must remain closed"); } },
    dailyDashboardService: executor,
    productionDailyDashboardEnabled: true
  });
  return app;
}
describe("日看板接口边界", () => {
  test("测试数据环境把整张日看板查询置于临时测试后台配置", async () => {
    let observed: ReturnType<typeof currentUpstreamRequestProfile>;
    const app = Fastify(); apps.push(app);
    await app.register(v2BiPlugin, {
      prefix: "/api/bi/v2",
      identityProvider: { resolve: async () => reader() },
      metricQueryService: { execute: async () => { throw Error("formal must remain closed"); } },
      dailyDashboardService: {
        execute: async request => {
          observed = currentUpstreamRequestProfile();
          return service().execute(request);
        }
      },
      dataEnvironmentResolver: {
        testAvailable: true,
        resolveTest: () => ({ status: "active", expiresAt: Date.now() + 60_000, profile: {
          environment: "test", baseUrl: "https://test.example.com", token: "secret-test-token", userName: "test-user", cachePartition: "preview-daily-reading"
        } })
      }
    });

    const response = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", headers: { "x-ypbi-data-environment": "test" }, payload: query });
    expect(response.statusCode).toBe(200);
    expect(observed).toMatchObject({ baseUrl: "https://test.example.com", userName: "test-user", cachePartition: "preview-daily-reading" });
    expect(response.body).not.toContain("secret-test-token");
  });

  for (const role of ["reader", "analyst", "maintainer"]) test(`${role}可读但不放宽正式查询`, async () => {
    const app = await appFor(reader(role));
    const response = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toContain("no-store");
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/metrics", payload: { metricId: "M016", pid: "PH", grain: "day", dateRange: query.dateRange } })).statusCode).not.toBe(200);
  });
  for (const [identity, status] of [[{ status: "unauthenticated" }, 401], [{ status: "unavailable", reason: "test" }, 503], [{ status: "authenticated", principal: { subjectId: "none", roles: [], permissions: [], pidScope: "all" } }, 403]] as const) test(`身份拒绝${status}`, async () => {
    let called = false; const app = await appFor(identity, { execute: async () => { called = true; throw Error(); } });
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query })).statusCode).toBe(status); expect(called).toBe(false);
  });
  for (const pid of ["FBI", "unknown"]) test(`范围外平台${pid}`, async () => {
    let called = false; const app = await appFor(reader(), { execute: async () => { called = true; throw Error(); } });
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: { ...query, pid } })).statusCode).toBe(403); expect(called).toBe(false);
  });
  test("关闭读取与未接入看板", async () => {
    const closed = Fastify(); apps.push(closed); await closed.register(v2BiPlugin, { prefix: "/api/bi/v2", identityProvider: { resolve: async () => reader() }, metricQueryService: { execute: async () => { throw Error("formal must remain closed"); } } });
    expect((await closed.inject({ url: "/api/bi/v2/catalog/readable-dashboards" })).json().data.enabled).toBe(false);
    expect((await closed.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query })).json().error.code).toBe("DAILY_READING_DISABLED");
    const app = await appFor();
    expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: { ...query, boardId: "5.5" } })).statusCode).toBe(422);
  });
  for (const mutate of [
    (result: any) => { result.data.query.pid = "FBI"; },
    (result: any) => { result.data.series[0].points[0].inputs.push({ key: "secret", value: 123 }); },
    (result: any) => { result.data.series[0].metric.inputs[0].key = "unknown"; result.data.series[0].points.forEach((point: any) => { point.inputs[0].key = "unknown"; }); },
    (result: any) => { result.data.sourceApiIds = ["unknown"]; },
    (result: any) => { result.data.series.reverse(); },
    (result: any) => { result.data.series[0].points[0].rawToken = "secret"; },
    (result: any) => { result.data.series[0].periodStatistics.dateRange = ["2026-09-04", "2026-09-05"]; },
    (result: any) => { result.data.series[0].periodStatistics = { ...result.data.series[0].periodStatistics, state: "available", values: [{ kind: "period_sum", value: 999 }], reason: null }; },
    (result: any) => { delete result.data.series[0].periodStatistics; }
  ]) test("执行器输出漂移拒绝", async () => {
    const result = await service().execute(query); mutate(result);
    const app = await appFor(reader(), { execute: async () => result });
    const response = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(response.statusCode).toBe(502); expect(response.body).not.toContain("secret");
  });
  test("上游错误脱敏并可重试", async () => {
    let failure = true;
    const app = await appFor(reader(), { execute: async q => { if (failure) throw new UpstreamError("UPSTREAM_TIMEOUT", "secret-message", 504); return service().execute(q); } });
    const response = await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query });
    expect(response.statusCode).toBe(504); expect(response.body).not.toContain("secret-message");
    failure = false; expect((await app.inject({ method: "POST", url: "/api/bi/v2/queries/dashboards/daily-reading", payload: query })).statusCode).toBe(200);
  });
});
