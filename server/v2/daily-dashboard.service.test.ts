import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { dailyDashboardMatchesQuery, dailyDashboardQuerySchema, dailyDashboardSuccessSchema } from "../../contracts/daily-dashboard";
import { loadEnv } from "../config/env";
import type { IdentityResolution } from "../identity/identity-provider";
import { UpstreamError } from "../upstream/client";
import { DailyDashboardService, dailyDashboardCatalog, dailyDashboardMatchesMapping, type DailyDashboardExecutor } from "./daily-dashboard.service";
import { v2BiPlugin } from "./plugin";

const query = { boardId: "5.2", pid: "PH", dateRange: ["2026-09-05", "2026-09-06"] as [string, string] };
const row = (fields: Record<string, unknown> = {}) => ({ pid: "PH", sumDate: "2026-09-04T16:00:00.000Z", loginUserCount: 100, registerUserCount: 30,
  watchUserCount: 80, totalChargeUserCount: 4, newUserChargeUserCount: 2, diamondChargeAmt: "40.50", adsCount: 20, navCount: 5,
  totalClickedCount: 26, adsClickedPerson: 10, navClickedPerson: 3, totalClickedPerson: 11, secret: "must-never-project", ...fields });
const service = (rows: Record<string, unknown>[] = [row()], envelope = {}) => new DailyDashboardService({ get: async (path) => path.endsWith("pDaySum") ? ({ code: 200, msg: { pageData: rows, totalCount: rows.length, ...envelope } }) : path.includes("reletionsStatPlus") ? {data:[]} : {msg:{pageData:[],totalData:[],totalCount:0}} });
const getSeries = async (id: string, fields: Record<string, unknown> = {}) => (await service([row(fields)]).execute(query)).data.series.find(series => series.metric.id === id)!;

describe("观影旧接口待验数接入", () => {
  const date="2026-09-12",q={...query,boardId:"5.9",dateRange:[date,date] as [string,string]};
  const make=(summary:Record<string,unknown>={totalUserWatchTime:7200,watchUserCount:4},fail=false)=>new DailyDashboardService({get:async(path)=>{
    if(path.endsWith("pDaySum"))return{msg:{pageData:[row({sumDate:date,watchUserCount:999})],totalCount:1}};
    if(path.includes("channelStatByTypeV2"))return{msg:{pageData:[],totalData:[summary]}};
    if(path.endsWith("pRealDayLine")){if(fail)throw new UpstreamError("UPSTREAM_TIMEOUT","timeout",504);return{msg:Array.from({length:288},(_,i)=>({pid:"PH",sumDate:new Date(Date.parse(date+"T00:00:00+08:00")+i*300000).toISOString(),graphDate:String(Math.floor(i/12)).padStart(2,"0")+":"+String(i%12*5).padStart(2,"0"),watchCount:2}))};}
    return{msg:{pageData:[],totalCount:0},data:[]};
  }},()=>new Date("2026-09-14T00:00:00Z"));
  test("发起次数全日累计，时长与人均保留同源输入和暂定秒边界",async()=>{
    const r=await make().execute(q),get=(id:string)=>r.data.series.find(s=>s.metric.id===id)!;
    expect(get("M101").points[0].value).toBe(576);
    expect(get("M102").points[0]).toMatchObject({state:"available",value:2,inputs:[{key:"totalUserWatchTime",value:7200}]});
    expect(get("M098").points[0]).toMatchObject({state:"available",value:30,inputs:[{value:7200},{value:4}]});
    expect(get("M102").metric).toMatchObject({unit:"小时",inputs:[{unit:"秒（暂定）"}]});
    expect(get("M098").metric.unit).toBe("分钟/人");
    expect(get("M098").metric.sourceNote).toContain("未额外剔除暂停、缓冲及后台时间");
    expect(get("M102").metric.sourceNote).toContain("实际前台观看时长口径仍待核对");
    expect(r.data).toMatchObject({validationStatus:"pending_validation",completeness:"unknown",watermark:null});
    expect(dailyDashboardMatchesMapping(r)).toBe(true);
    expect((await make().execute({...q,boardId:"5.2"})).data.sourceApiIds).toHaveLength(5);
    const playback=await make().execute({...q,boardId:"5.12"});
    expect(playback.data.series.map(series=>series.metric.id)).toEqual(["M101"]);
    expect(playback.data.sourceApiIds).toEqual(["/api/admin/home/pRealDayLine"]);
  });
  test("同源时长真零、缺失、非法值与零分母分开，实时失败不污染时长",async()=>{
    for(const [summary,state,value] of [[{totalUserWatchTime:0,watchUserCount:4},"available",0],[{watchUserCount:4},"no_value",null],[{totalUserWatchTime:-1,watchUserCount:4},"invalid_value",null],[{totalUserWatchTime:7200,watchUserCount:0},"zero_denominator",null]] as const){
      const r=await make(summary).execute(q);
      expect(r.data.series.find(s=>s.metric.id==="M098")!.points[0]).toMatchObject({state,value});
    }
    const r=await make(undefined,true).execute(q);
    expect(r.data.series.find(s=>s.metric.id==="M101")!.points[0].state).toBe("source_failure");
    expect(r.data.series.find(s=>s.metric.id==="M102")!.points[0].value).toBe(2);
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
    const recent=await new DailyDashboardService({get:async(path)=>path.includes("reletionsStatPlus")?{data:[{pid:"PH",sumDate:"2026-09-11",registerCount:100,afterFirstData1:{date:"2026-09-12",loginCnt:0}}]}:{msg:{pageData:[],totalCount:0}}},()=>new Date("2026-09-12T08:00:00Z")).execute({...q,boardId:"5.8",dateRange:["2026-09-11","2026-09-11"]});
    expect(recent.data.series.find(s=>s.metric.id==="M020")!.points[0]).toMatchObject({state:"immature",value:null,inputs:[{value:null},{value:100}]});
  });
});

describe("日看板真实候选读取", () => {
  test("直接字段、单日比率、元金额、广告总量保持独立", async () => {
    const result = await service().execute(query);
    const value = (id: string) => result.data.series.find(series => series.metric.id === id)!.points[0].value;
    expect(value("M016")).toBe(100); expect(value("M008")).toBe(30);
    expect(value("M081")).toBe(.8); expect(value("M061")).toBe(.04);
    expect(value("M058")).toBe(40.5); expect(value("M067")).toBe(10.125); expect(value("M087")).toBe(.405);
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
  test("坏金额、空白金额不补0", async () => {
    expect((await getSeries("M058", { diamondChargeAmt: "-10.5" })).points[0].state).toBe("invalid_value");
    expect((await getSeries("M058", { diamondChargeAmt: " " })).points[0].state).toBe("no_value");
  });
  for (const rows of [[row(), row()], [row({ pid: "FBI" })], [row({ sumDate: "2026-09-07" })], [row({ sumDate: "2026-02-31" })], [row({ sumDate: "nonsense" })]]) {
    test("来源日期/PID冲突隔离日汇总来源", async () => { const result=await service(rows).execute(query); expect(result.data.series.find(series=>series.metric.id==="M016")!.points.every(point=>point.state==="source_failure"&&point.value===null)).toBe(true); });
  }
  for (const envelope of [{ totalCount: 2 }, { totalCount: "0x1" }, { totalCount: 1, total: 2 }, { totalCount: null, total: null }]) {
    test("分页数目缺失/冲突/截断不显示日汇总", async () => { const result=await service([row()],envelope).execute(query);expect(result.data.series.find(series=>series.metric.id==="M016")!.points.every(point=>point.state==="source_failure"&&point.value===null)).toBe(true); });
  }
  test("新增付费只使用指定切片", async () => {
    const result = await service().execute({ ...query, boardId: "5.7" });
    expect(["M008","M059.new","M064"].map(id=>result.data.series.find(series=>series.metric.id===id)!.points[0].value)).toEqual([30, 2, 2 / 30]);
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
});

describe("服务端所选日期合计与日均", () => {
  test("金额保持元的小数原值，时长从原始秒汇总后换算小时；缺日与人均不混算", async () => {
    const make=(missing=false)=>new DailyDashboardService({get:async(path,params)=>{
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
    expect(get("M059").values).toEqual([{ kind: "daily_average", value: 4 }]);
    for (const id of ["M081", "M061", "M067", "M020", "M098"]) expect(get(id)).toMatchObject({ state: "unsupported", values: [] });
    expect(get("M058")).toMatchObject({state:"available",values:[{kind:"period_sum",value:81},{kind:"daily_average",value:40.5}]});
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
  await app.register(v2BiPlugin, { prefix: "/api/bi/v2", identityProvider: { resolve: async () => identity }, metricQueryService: { execute: async () => { throw Error("formal must remain closed"); } }, dailyDashboardService: executor });
  return app;
}
describe("日看板接口边界", () => {
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
