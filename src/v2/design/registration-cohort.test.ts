import { expect, test } from "bun:test";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";
import type { DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { connectedCohortRows } from "./ConnectedCohorts";
import { DEFAULT_TOPIC_READING, DEFAULT_TOPIC_VIEW, parseTopicView } from "./topic-preview-view";
import { REGISTRATION_COHORT_SCOPES, REGISTRATION_RETENTION_WINDOWS, readableRegistrationCohortSeries, registrationCohortMetricId } from "../features/dashboards/registration-cohort";
import { liveCalculation, liveDailyReferenceRows, liveMetricModel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";

const date = "2026-08-01", query = {boardId:"5.8",pid:"PH",dateRange:[date,date] as [string,string]};
async function fixture() {
  return new DailyDashboardService({get:async(path,params)=>{
    if (!path.endsWith("/bi/v1/metrics")) return {msg:{pageData:[],totalCount:0},data:[]};
    const filters=JSON.parse(params.dimensionFilters??"{}");
    const n = filters.clientPlatform==="android"?1:filters.clientPlatform==="ios"?2:filters.sourceType==="natural"?3:filters.sourceType==="internal_channel"?4:8;
    return {code:200,msg:{metricVersion:"bi-v1",generatedAt:"2026-10-09T00:00:00Z",watermark:null,rows:params.metricCodes.split(",").filter((id:string)=>REGISTRATION_RETENTION_WINDOWS.some(([code])=>id===code)).map((metricCode:string)=>({metricCode,businessDate:params.startDate,dimensions:{pid:"PH",...filters},unit:"ratio",dataStatus:"READY",metricVersion:"bi-v1",ruleVersion:"registration-retention-v1",numerator:n,denominator:10,value:n/10}))}};
  }},()=>new Date("2026-10-09T00:00:00Z")).execute(query);
}
function reading(data:DailyDashboardSuccess):LiveDashboardReading {return {query:data.data.query,metricIds:data.data.series.map(s=>s.metric.id),state:{status:"success",data,refreshing:false,refreshError:null},platformName:"测试平台",retry(){},canExport:true,controls:{date:null,scope:null,comparison:null,dirty:false,acceptsSharedRange:()=>true,apply(){},export(){}}};}
const original=(id:string)=>({metric:{id,name:"注册留存率",aggregationLabel:"",definitionLabel:""},result:{status:"no_values" as const,contextLabel:"",retryable:false}});

test("独立cohortScope只接受五范围，旧链接总体，活跃scope不变",()=>{
  for(const {value} of REGISTRATION_COHORT_SCOPES) {
    const view={...DEFAULT_TOPIC_VIEW,reading:{...DEFAULT_TOPIC_READING,structureId:"M016",scope:{client:"web",audience:"existing"},cohortScope:value}};
    expect(parseTopicView(JSON.stringify(view),"5.8")?.reading).toMatchObject({cohortScope:value,scope:{client:"web",audience:"existing"}});
    expect(parseTopicView(JSON.stringify(view),"5.9")).toBeNull();
  }
  expect(parseTopicView(JSON.stringify(DEFAULT_TOPIC_VIEW),"5.8")?.reading?.cohortScope??"overall").toBe("overall");
  for(const invalid of ["web","new","old","channel","androidNew",{client:"android"}]) expect(parseTopicView(JSON.stringify({...DEFAULT_TOPIC_VIEW,reading:{...DEFAULT_TOPIC_READING,structureId:"M016",cohortScope:invalid}}),"5.8")).toBeNull();
});

test("四周期五范围卡片、趋势、矩阵人数和详情全部读取精确D0切片",async()=>{
  const live=reading(await fixture());
  for(const [{value:scope},n] of REGISTRATION_COHORT_SCOPES.map((item,index)=>[item,[8,1,2,3,4][index]] as const)) {
    const rows=connectedCohortRows(query,live.state,scope);
    for(const [id] of REGISTRATION_RETENTION_WINDOWS) {
      expect(rows[0].cells.find(c=>c.id===id)).toMatchObject({count:n,base:10,rate:n/10});
      const model=liveMetricModel(original(registrationCohortMetricId(id,scope)),live);
      expect(model.result.status).toBe("available");
      if(model.result.status!=="available")throw Error("expected available");
      expect(model.result.value.raw).toBe(n/10);
      expect(model.result.calculation?.numerator.value).toBe(n);
      expect(model.result.calculation?.scope).toContain("注册日");
      expect(model.result.trend.current[0].value?.raw).toBe(n/10);
      expect(liveDailyReferenceRows(live,[registrationCohortMetricId(id,scope)])).toEqual([]);
    }
  }
});

test("D1缺失不污染D3，周期各自分母且绝不借M115总体或其他scope",async()=>{
  const live=reading(await fixture()), series=live.state.status==="success"?live.state.data.data.series:[];
  const d1=series.find(s=>s.metric.id==="M020.android")!.points[0];
  Object.assign(d1,{state:"no_record",value:null,inputs:d1.inputs.map(i=>({...i,value:null}))});
  const d3=series.find(s=>s.metric.id==="M021.android")!.points[0];
  d3.inputs[1].value=7;d3.value=1/7;
  const d7=series.find(s=>s.metric.id==="M022.android")!.points[0];
  Object.assign(d7,{state:"source_failure",sourceStatus:"FAILED",value:null});
  const rows=connectedCohortRows(query,live.state,"android");
  expect(rows[0].base).toBeNull();
  expect(rows[0].cells[0]).toMatchObject({rate:null,count:null,base:null});
  expect(rows[0].cells[1]).toMatchObject({rate:1/7,count:1,base:7});
  expect(rows[0].cells[2]).toMatchObject({rate:null,count:null,base:null,status:"数据异常 · 待验数"});
  expect(rows[0].cells[3]).toMatchObject({rate:.1,count:1,base:10});
  expect(liveMetricModel(original("M021.android"),live).result.status).toBe("available");
  expect(liveCalculation(series.find(s=>s.metric.id==="M021.android")!,d3)?.denominator.value).toBe(7);
});

test("非READY附带值不进入矩阵，零基数0保留直接人数",async()=>{
  const live=reading(await fixture()), series=live.state.status==="success"?live.state.data.data.series:[];
  for(const sourceStatus of ["NOT_MATURE","PROCESSING","SOURCE_INCOMPLETE","FAILED"] as const) {
    series.find(s=>s.metric.id==="M020.android")!.points[0].sourceStatus=sourceStatus;
    expect(connectedCohortRows(query,live.state,"android")[0].cells[0]).toMatchObject({rate:null,count:null,base:null});
    const model=liveMetricModel(original("M020.android"),live);
    expect(model.result.status).not.toBe("available");
    const safe=readableRegistrationCohortSeries(series.find(s=>s.metric.id==="M020.android")!);
    expect(safe.points[0]).toMatchObject({value:null,inputs:[{value:null},{value:null}]});
  }
  const point=series.find(s=>s.metric.id==="M021.android")!.points[0];
  Object.assign(point,{state:"zero_denominator",value:null,inputs:point.inputs.map(i=>({...i,value:0}))});
  expect(connectedCohortRows(query,live.state,"android")[0].cells[1]).toMatchObject({rate:null,count:0,base:0});
});

test("留存摘要只纳入READY批次，对比脏状态不参加计算，非留存保持既有行为",async()=>{
  for(const sourceStatus of ["NOT_MATURE","PROCESSING","SOURCE_INCOMPLETE","FAILED"] as const) {
    const current=await fixture();current.data.query.dateRange=[date,"2026-08-02"];
    const source=current.data.series.find(s=>s.metric.id==="M020.android")!;
    source.points.push({...structuredClone(source.points[0]),date:"2026-08-02",sourceStatus,value:.99,inputs:source.points[0].inputs.map((input,i)=>({...input,value:i===0?99:100}))});
    const live=reading(current),model=liveMetricModel(original("M020.android"),live);
    expect(model.result.status).toBe("available");
    if(model.result.status!=="available")throw Error("expected available");
    expect(model.result.value.raw).toBe(.1);
    expect(model.result.calculation).toMatchObject({numerator:{value:1},denominator:{value:10}});
    expect(model.result.trend.current.map(point=>point.value?.raw??null)).toEqual([.1,null]);
    expect(model.result.trend.current[1].calculation).toMatchObject({numerator:{value:null},denominator:{value:null}});
    const previous=structuredClone(current);
    previous.data.series.find(s=>s.metric.id==="M020.android")!.points[0].sourceStatus=sourceStatus;
    live.comparison={label:"上一等长周期",query:previous.data.query,state:{status:"success",data:previous,refreshing:false,refreshError:null}};
    const compared=liveMetricModel(original("M020.android"),live).result;
    expect(compared.status==="available"&&compared.comparison?.status).toBe("unavailable");
    expect(compared.status==="available"&&compared.trend.comparison?.every(point=>point.value===null)).toBe(true);
    expect(liveDailyReferenceRows(live,["M020.android"])).toEqual([]);
    const normal={...source,metric:{...source.metric,id:"M081"}};
    expect(readableRegistrationCohortSeries(normal)).toBe(normal);
  }
});
