import { expect, test } from "bun:test";
import { DEFAULT_TOPIC_READING, DEFAULT_TOPIC_SCOPE, DEFAULT_TOPIC_VIEW, parseTopicView } from "./topic-preview-view";
import { topicCard, datesIn } from "./topic-preview-fixtures";
import { topicScopeCells, topicScopeExport, topicScopeModel, topicLiveScopeId } from "./topic-scope-model";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";

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
  expect(topicLiveScopeId("M016",{client:"android",audience:"new"})).toBeNull();
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,DEFAULT_TOPIC_SCOPE,live).result.status).toBe("failed");
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,{client:"android",audience:"new"},live).result.status).toBe("not_ready");
  expect(topicScopeModel("M016",DEFAULT_TOPIC_VIEW,{client:"ios",audience:"overall"},live).result.status).toBe("not_ready");
  const rows=topicScopeExport("M016",{...DEFAULT_TOPIC_VIEW,compared:true},live);
  expect(rows.every(row=>row.length===rows[0].length)).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("194,319");
});

test("二维范围深链白名单及旧维度链接保留", () => {
  const input={...DEFAULT_TOPIC_VIEW,reading:{...DEFAULT_TOPIC_READING,dimension:"cross",scope:{client:"ios",audience:"existing"}}};
  expect(parseTopicView(JSON.stringify(input),"5.9")?.reading?.scope).toEqual(input.reading.scope);
  expect(parseTopicView(JSON.stringify({...input,reading:{...input.reading,scope:{client:"android",audience:"vip"}}}),"5.9")).toBeNull();
  for(const dimension of ["platform","users","cross"])expect(parseTopicView(JSON.stringify({...input,reading:{...DEFAULT_TOPIC_READING,structureId:"M016",dimension}}),"5.8")).not.toBeNull();
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
