import { expect, test } from "bun:test";
import { DailyDashboardService } from "../../../../server/v2/daily-dashboard.service";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../../contracts/daily-dashboard";
import { liveMetricModel, liveDailyReferenceRows, liveValue, type LiveDashboardReading } from "./LiveDashboardContext";
import type { DashboardMetricCardModel } from "./dashboard-metric-card-model";
import { operatingLiveRows,operatingLiveSummary,operatingLiveCalculationRows,operatingLiveColumns,OPERATING_LIVE_IDS } from "../../design/operating-live-model";
import { operatingDetailBreakdown } from "../../design/operating-detail-snapshot";
import { connectedCohortRows } from "../../design/ConnectedCohorts";
import { connectedPaymentPoints, connectedPaymentUnit } from "../../design/connected-payment-data";
import { prepareWorkbookSheets, buildPreviewWorkbook } from "../../design/preview-workbook";
import { availablePeriodStatistics } from "./live-period-statistics";

const query: DailyDashboardQuery = { boardId: "5.2", pid: "PH", dateRange: ["2026-09-05", "2026-09-06"] };
test("小额人均值保留四位，0与缺失独立，金额本身仍按原精度", () => {
  expect(liveValue(2204 / 209272, "元/人")).toBe("0.0105");
  expect(liveValue(11603 / 852800, "元/人")).toBe("0.0136");
  expect(liveValue(0, "元/人")).toBe("0");
  expect(liveValue(null, "元/人")).toBe("—");
  expect(liveValue(11603, "元")).toBe("11,603");
});
test("多指标下载的工作表名合法唯一，保留完整业务名称索引",()=>{
  const name="当前期-"+"业务指标".repeat(12);
  const source=[{name:"当前期-日活Android:iOS比值",rows:[[1]]},{name,rows:[[2]]},{name,rows:[[3]]},{name:"Case",rows:[[4]]},{name:"case",rows:[[5]]}];
  const prepared=prepareWorkbookSheets(source);
  expect(prepared).toHaveLength(6);
  expect(prepared.slice(0,5).every(sheet=>sheet.name.length<=31&&!/[\\/*?:\[\]]/.test(sheet.name))).toBe(true);
  expect(new Set(prepared.map(sheet=>sheet.name.toLowerCase())).size).toBe(6);
  expect(prepared[5].rows[1][1]).toBe(source[0].name);
  expect(prepared[5].rows[2][1]).toBe(name);
  expect(()=>buildPreviewWorkbook(prepared)).not.toThrow();
  expect(prepareWorkbookSheets([{name:"普通报表",rows:[[0]]}])).toEqual([{name:"普通报表",rows:[[0]]}]);
});
const original = (id = "M016"): DashboardMetricCardModel => ({ metric: { id, name: "测试指标", definitionLabel: "权威定义", aggregationLabel: "原演示范围" }, result: { status: "no_values", contextLabel: "演示", retryable: false } });
async function data(values: (number | null)[], range = query.dateRange) {
  const rows = values.flatMap((value, index) => value === null ? [] : [{ pid: "PH", sumDate: range[index], loginUserCount: value, watchUserCount: value / 2 }]);
  return new DailyDashboardService({ get: async () => ({ code: 200, msg: { pageData: rows, totalCount: rows.length } }) }).execute({ ...query, dateRange: range });
}
function reading(result: DailyDashboardSuccess): LiveDashboardReading {
  return { query: result.data.query, metricIds: ["M016", "M081"], state: { status: "success", data: result, refreshing: false, refreshError: null }, platformName: "测试平台", retry() {}, canExport: false,
    controls: { date: null, scope: null, comparison: null, dirty: false, acceptsSharedRange: () => true, apply() {}, export() {} } };
}

test("留存率分母0不丢掉真实留存人数0",async()=>{
  const result=await new DailyDashboardService({get:async(path)=>path.includes("reletionsStatPlus")?{data:[{pid:"PH",sumDate:query.dateRange[0],registerCount:0,afterFirstData1:{date:query.dateRange[1],loginCnt:0}}]}:{msg:{pageData:[],totalCount:0}}},()=>new Date("2026-09-12T00:00:00Z")).execute({...query,boardId:"5.8"});
  const rows=connectedCohortRows(query,{status:"success",data:result,refreshing:false,refreshError:null});
  expect(rows[0].base).toBe(0);expect(rows[0].cells[0]).toMatchObject({rate:null,count:0,status:"分母为0 · 待验数"});
});
test("支付总体ARPPU与占比保留计算依据；不完整分类不闭合",async()=>{
  const result=await new DailyDashboardService({get:async(path,params)=>path.endsWith("pDaySum")?{msg:{pageData:[{pid:"PH",sumDate:query.dateRange[0],diamondChargeAmt:100,totalChargeUserCount:10}],totalCount:1}}:path.includes("channelStatByTypeV2")?{msg:{pageData:[],totalData:[{vipChargeAmt:70,goldChargeAmt:30}]}}:{data:[],msg:{pageData:[]}}}).execute({...query,boardId:"5.10"});
  const live=reading(result);live.query=result.data.query;live.metricIds=result.data.series.map(s=>s.metric.id);
  expect(connectedPaymentUnit(live)).toBe("元");expect(connectedPaymentUnit(live,"arppu")).toBe("元/人");
  expect(connectedPaymentPoints(live,"product","share")[0].overallBasis?.numerator.unit).toBe("元");
  expect(connectedPaymentPoints(live,"stage","arppu")[0].overallBasis).toMatchObject({numerator:{value:100},denominator:{value:10}});
  expect(connectedPaymentPoints(live,"product","amount")[0].shares).toEqual({vip:.7,coin:.3});
  expect(connectedPaymentPoints(live,"product","share")[0].overallBasis).toMatchObject({numerator:{value:100},denominator:{value:100},result:"100.00%"});
  expect(connectedPaymentPoints(live,"stage","amount")[0].shares).toBeUndefined();
});

test("主值为结束日，趋势和公式输入同源，不变成日均或累计", async () => {
  const live = reading(await data([100, 200]));
  const result = liveMetricModel(original(), live).result;
  expect(result.status).toBe("available");
  if (result.status !== "available") throw Error("expected available");
  expect(result.value.raw).toBe(200); expect(result.trend.current.map(point => point.value?.raw)).toEqual([100, 200]);
  expect(result.completeness).toBe("unknown"); expect(result.validationLabel).not.toBe("已验数"); expect(result.watermarkLabel).toBe("");
  const ratio = liveMetricModel(original("M081"), live).result;
  if (ratio.status !== "available") throw Error("expected ratio");
  expect(ratio.calculation?.numerator.value).toBe(100); expect(ratio.calculation?.denominator.value).toBe(200); expect(ratio.value.raw).toBe(.5);
});
test("真实周期统计来自服务端：人数只有日均，次数支持合计与日均，零参与均值", async () => {
  const result = await new DailyDashboardService({ get: async () => ({ msg: { pageData: query.dateRange.map((date, i) => ({ pid: "PH", sumDate: date, loginUserCount: i ? 101 : 0, totalVistCount: i ? 101 : 0 })), totalCount: 2 } }) }).execute({ ...query, boardId: "5.7" });
  const live = reading(result), card = liveMetricModel(original("M001"), live);
  expect(card.result.reading?.statistics.map(item => [item.label, item.display])).toEqual([["合计", "101"], ["均值", "50.5"]]);
  expect(card.result.status === "available" && card.result.value.raw).toBe(101);
  const users = liveMetricModel(original(), reading(await data([0, 101])));
  expect(users.result.reading?.statistics.map(item => [item.label, item.display])).toEqual([["均值", "50.5"]]);
  expect(users.result.reading?.statistics[0].detail).toContain("不是区间去重人数");
  expect(liveMetricModel(original("M081"), reading(await data([100, 200]))).result.reading?.statistics).toEqual([]);
});
test("周期统计不借用其他范围或平台；旧响应与缺日不补算，刷新失败保留同快照标识", async () => {
  const result = await data([100, 200]), live = reading(result), series = result.data.series.find(item => item.metric.id === "M016")!;
  expect(availablePeriodStatistics(series, result, { ...query, pid: "other" })).toBeNull();
  live.query = { ...query, dateRange: [query.dateRange[1], query.dateRange[1]] };
  expect(liveMetricModel(original(), live).result.reading?.statistics).toEqual([]);
  const old = { ...result, data: { ...result.data, schemaVersion: "day-dashboard/v1" as const, series: result.data.series.map(item => ({ metric: item.metric, points: item.points })) } };
  expect(liveMetricModel(original(), reading(old)).result.reading?.statistics).toEqual([]);
  expect(liveMetricModel(original(), reading(await data([null, 200]))).result.reading?.statistics).toEqual([]);
  live.query = query;
  live.state = { status: "success", data: result, refreshing: false, refreshError: { code: "UPSTREAM_TIMEOUT", message: "超时" } };
  expect(liveMetricModel(original(), live).result.reading?.statistics[0]).toMatchObject({ display: "150" });
  expect(liveMetricModel(original(), live).result.reading?.statistics[0].detail).toContain("刷新失败");
});
test("结束日缺失时主值仍缺失，已存在的历史保留", async () => {
  const result = liveMetricModel(original(), reading(await data([100, null]))).result;
  if (result.status === "available") throw Error("must not promote an earlier date");
  expect(result.status).toBe("no_records"); expect(result.history?.value.display).toBe("—");
  expect(result.history?.trend.current.map(point => point.value?.raw ?? null)).toEqual([100, null]);
});
test("当前期全空也保留有值的对比期", async () => {
  const live = reading(await data([null, null])), before: [string, string] = ["2026-09-03", "2026-09-04"];
  live.comparison = { label: "上一等长周期", query: { ...query, dateRange: before }, state: { status: "success", data: await data([50, 60], before), refreshing: false, refreshError: null } };
  const result = liveMetricModel(original(), live).result;
  if (result.status === "available") throw Error("current still absent");
  expect(result.history?.trend.current.every(point => point.value === null)).toBe(true);
  expect(result.history?.trend.comparison?.map(point => point.value?.raw)).toEqual([50, 60]);
  expect(result.history?.comparison?.status).toBe("unavailable");
});
test("对比期刷新失败保留明确标识的旧基准", async () => {
  const live = reading(await data([100, 200])), before: [string, string] = ["2026-09-03", "2026-09-04"];
  live.comparison = { label: "上一等长周期", query: { ...query, dateRange: before }, state: { status: "success", data: await data([50, 60], before), refreshing: false, refreshError: { code: "UPSTREAM_TIMEOUT", message: "超时" } } };
  const result = liveMetricModel(original(), live).result;
  if (result.status !== "available") throw Error("current survives");
  expect(result.refresh.status).toBe("failed"); expect(result.comparison?.detail).toContain("上次查询基准");
  expect(result.trend.comparison?.[0]).toMatchObject({ actualDate: before[0], value: { raw: 50 }, counterpart: { raw: 100, actualDate: query.dateRange[0] } });
});
test("真实0、分母为0、首次失败和未返回指标不补演示", async () => {
  const live = reading(await data([0, 0]));
  const result = liveMetricModel(original(), live).result;
  expect(result.status === "available" && result.value.display).toBe("0");
  expect(liveMetricModel(original("M081"), live).result.status).toBe("no_values");
  expect(liveMetricModel(original("unmapped"), live).result.status).toBe("no_values");
  live.state = { status: "failure", kind: "error", code: "UPSTREAM_TIMEOUT", message: "超时" };
  const failed = liveMetricModel(original(), live).result;
  expect(failed.status).toBe("failed"); expect("value" in failed).toBe(false);
});

test("所选日期从准确日点读取，不能把序列最后一天标成其他日期",async()=>{
  const live=reading(await data([100,200]));live.query={...query,dateRange:["2026-09-05","2026-09-05"]};
  const model=liveMetricModel(original(),live);expect(model.result.status==="available"&&model.result.value.raw).toBe(100);
});
test("分源失败可重试，不能转成普通缺值",async()=>{
  const live=reading(await new DailyDashboardService({get:async()=>{throw Error("unavailable");}}).execute(query));
  expect(liveMetricModel(original(),live).result).toMatchObject({status:"failed",retryable:true,label:"来源读取失败"});
});
test("经营摘要支持真实日期，旧日期资源不能冒充新日期",async()=>{
  const result=await data([100,200]),live=reading(result);live.metricIds=Object.values(OPERATING_LIVE_IDS);live.query={...query,dateRange:["2026-09-09","2026-09-09"]};
  const resources={PH:{status:"success" as const,data:result,refreshing:false,refreshError:null}},rows=operatingLiveRows(live,resources);
  const models=operatingLiveSummary(live,resources,rows,"PH");
  expect(models.find(m=>m.metric.id==="M016")!.result.status).toBe("loading");
  expect(rows[0].values[0].current).toBeNull();
  const all=operatingLiveSummary(live,resources,rows,"all");
  expect(all.every(model=>model.result.status==="unsupported")).toBe(true);
  expect(all.every(model=>model.metric.aggregationLabel.includes("2026-09-09"))).toBe(true);
});

test("真实经营明细的未映射列不回退演示值，全部平台也不冒充大盘结果",async()=>{
  const result=await data([100,200]),live=reading(result);live.query=result.data.query;
  const resources={PH:{status:"success" as const,data:result,refreshing:false,refreshError:null}},rows=operatingLiveRows(live,resources);
  const mau=rows[0].values[DETAIL_COLUMNS.findIndex(column=>column.metric.id==="M018")];
  expect(mau).toMatchObject({current:null,previousDay:null,previousWeek:null,state:"unsupported"});
  const exported=operatingLiveExportRows(rows,operatingLiveColumns(live),result.data.query.dateRange[1]);
  expect(exported.flat()).not.toContain("演示数据");
  expect(exported.flat()).toContain("待接口支持");
  expect(operatingLiveSummary(live,resources,rows,"all").every(model=>model.result.status==="unsupported")).toBe(true);
});

test("经营下载保留逐周期实际输入与0，不把演示字段纳入真实计算表",async()=>{
  const result=await data([0,100],["2026-08-30","2026-09-06"]),live=reading(result);
  live.query=result.data.query;
  const resources={PH:{status:"success" as const,data:result,refreshing:false,refreshError:null}};
  const rows=operatingLiveRows(live,resources),exported=operatingLiveCalculationRows(rows,operatingLiveColumns(live));
  const names=exported[0], index=(name:string)=>names.indexOf(name);
  const ratio=exported.filter(row=>row[index("列键")]==="M081:overall");
  expect(ratio).toHaveLength(6);
  expect(ratio.filter(row=>row[index("周期")]==="当日").map(row=>row[index("输入值")])).toEqual([50,100]);
  expect(ratio.filter(row=>row[index("周期")]==="上周同日").map(row=>row[index("输入值")])).toEqual([0,0]);
  expect(ratio.filter(row=>row[index("周期")]==="昨日").every(row=>row[index("输入值")]===null)).toBe(true);
  expect(exported.some(row=>row[index("列键")]==="M018:overall")).toBe(false);
});
test("总体缺失时真实金额切片仍用元，不沿用演示USD",async()=>{
  const date="2026-09-09",r=await new DailyDashboardService({get:async(path)=>path.endsWith("pDaySum")?{msg:{pageData:[{pid:"PH",sumDate:date,newUserDiamondChargeAmt:30}],totalCount:1}}:{msg:{pageData:[],totalData:[],totalCount:0},data:[]}}).execute({...query,dateRange:["2026-09-02",date]});
  const live={...reading(r),query:{...query,dateRange:[date,date] as [string,string]},metricIds:Object.values(OPERATING_LIVE_IDS)};
  const resources={PH:{status:"success" as const,data:r,refreshing:false,refreshError:null}},rows=operatingLiveRows(live,resources),model=operatingLiveSummary(live,resources,rows,"PH").find(m=>m.metric.id==="M058")!;
  expect(model.result.status).not.toBe("available");expect(operatingDetailBreakdown(model,rows,"PH",date).unit).toBe("元");
  expect(operatingLiveColumns(live).find(column=>column.metric.id==="M058")?.unit).toBe("元");
  const calculationRows=operatingLiveCalculationRows(rows,operatingLiveColumns(live));
  expect(calculationRows.some(row=>row.includes("新增充值金额")&&row.includes(30)&&row.includes("元"))).toBe(true);
});
test("经营时长表头、字段说明和计算导出保留接口候选边界",async()=>{
  const date="2026-09-09",r=await new DailyDashboardService({get:async(path)=>path.endsWith("pDaySum")?{msg:{pageData:[],totalCount:0}}:path.includes("channelStatByTypeV2")?{msg:{pageData:[],totalData:[{totalUserWatchTime:7200,watchUserCount:4}]}}:{msg:{pageData:[],totalCount:0},data:[]}}).execute({...query,dateRange:["2026-09-02",date]});
  const live={...reading(r),metricIds:r.data.series.map(series=>series.metric.id)},columns=operatingLiveColumns(live),column=columns.find(item=>item.metric.id==="M102")!;
  expect(column.unit).toBe("小时");
  expect(column.metric.definition).toContain("未额外剔除暂停、缓冲及后台时间");
  expect(column.metric.definition).toContain("字段单位、完整性和区间去重分母待验数");
  const resources={PH:{status:"success" as const,data:r,refreshing:false,refreshError:null}},rows=operatingLiveRows(live,resources);
  expect(operatingLiveCalculationRows(rows,columns).some(row=>row.includes(7200)&&row.includes("秒（暂定）")&&row.some(cell=>typeof cell==="string"&&cell.includes("未额外剔除暂停")))).toBe(true);
});
test("留存按共同批次比较，不用缺一批的对比期生成变化",async()=>{
  const service=new DailyDashboardService({get:async(path,params)=>path.includes("reletionsStatPlus")?{data:[0,1].map(i=>{const d=new Date(Date.parse(params.registerDate.slice(0,10))+i*86400000).toISOString().slice(0,10);return{pid:"PH",sumDate:d,registerCount:i?300:100,afterFirstData1:{date:new Date(Date.parse(d)+86400000).toISOString().slice(0,10),loginCnt:i?90:10}};})}:{msg:{pageData:[],totalCount:0}}},()=>new Date("2026-09-12T00:00:00Z"));
  const now=await service.execute({...query,boardId:"5.8"}),prior=await service.execute({...query,boardId:"5.8",dateRange:["2026-09-03","2026-09-04"]}),live=reading(now);
  live.comparison={label:"上一等长周期",query:prior.data.query,state:{status:"success",data:prior,refreshing:false,refreshError:null}};
  const s=prior.data.series.find(s=>s.metric.id==="M020")!;s.points[1]={...s.points[1],state:"no_value",value:null};
  const model=liveMetricModel(original("M020"),live);
  expect(model.result.status==="available"&&model.result.value.raw).toBe(.25);
  expect(model.result.status==="available"&&model.result.comparison?.status).toBe("unavailable");
});

test("单日主卡D-1/D-7与区间对比独立，两个参考行支持完整导出", async () => {
  const current = await data([200], ["2026-09-06", "2026-09-06"]), live = reading(current);
  const previous = await data([100], ["2026-09-05", "2026-09-05"]), week = await data([50], ["2026-08-30", "2026-08-30"]);
  live.comparison = { label: "上一等长周期", query: previous.data.query, state: { status: "success", data: previous, refreshing: false, refreshError: null } };
  live.dayReference = { query: week.data.query, state: { status: "success", data: week, refreshing: false, refreshError: null } };
  const result = liveMetricModel(original(), live).result;
  expect(result.status).toBe("available"); expect(result.reading?.primaryLabel).toBe("所选日 2026-09-06");
  expect(result.reading?.statistics).toEqual([]);
  expect(result.reading?.comparisons.map(item => item.status === "available" ? item.display : "—")).toEqual(["+100.00%", "+300.00%"]);
  const references = liveDailyReferenceRows(live, ["M016", "M081"]);
  expect(references.map(row => [row.label, row.date, row.value])).toEqual([["较前一天", "2026-09-05", 100], ["较上周同日", "2026-08-30", 50], ["较前一天", "2026-09-05", .5], ["较上周同日", "2026-08-30", .5]]);
  expect(references[3].calculation?.denominator.value).toBe(50);
  if (result.status === "available") expect(result.trend.current).toHaveLength(1);
  live.comparison = undefined;
  expect(liveDailyReferenceRows(live, ["M016"])).toEqual([]);
  expect(liveMetricModel(original(), live).result.reading?.comparisons).toEqual([]);
});

test("日基准失败或旧PID不冒充数值，刷新失败notice及导出保留旧快照身份", async () => {
  const live = reading(await data([200], ["2026-09-06", "2026-09-06"]));
  const previous = await data([100], ["2026-09-05", "2026-09-05"]), week = await data([50], ["2026-08-30", "2026-08-30"]);
  live.comparison = { label: "上一等长周期", query: previous.data.query, state: { status: "success", data: previous, refreshing: false, refreshError: null } };
  live.dayReference = { query: week.data.query, state: { status: "success", data: week, refreshing: false, refreshError: { code: "UPSTREAM_TIMEOUT", message: "超时" } } };
  const compared = liveMetricModel(original(), live).result.reading!.comparisons[1];
  expect(compared.status === "available" && compared.notice).toContain("刷新失败");
  expect(liveDailyReferenceRows(live, ["M016"])[1].freshness).toContain("上次查询结果");
  week.data.query.pid = "another-platform";
  expect(liveMetricModel(original(), live).result.reading!.comparisons[1].status).toBe("unavailable");
  live.dayReference.state = { status: "failure", kind: "error", code: "UPSTREAM_TIMEOUT", message: "超时" };
  expect(liveDailyReferenceRows(live, ["M016"])[1]).toMatchObject({ value: null, reason: "该日查询失败", fetchedAt: "" });
  live.query = { ...live.query, pid: "wrong-platform" };
  expect(liveMetricModel(original(), live).result.status).toBe("no_values");
});
