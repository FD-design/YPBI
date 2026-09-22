import { test, expect } from "bun:test";
import { emptyAnalysis, localId, type AnalysisConfig } from "./personal-workspace-model";
import { configurationError, queryAnalysisPreview, workspaceEvents } from "./personal-query-preview";
import { sampleEventFacts, aggregateFacts, matchesFilter, retargetEventItem, drillEventConfig } from "./event-analysis-preview";
import { resultPresentation } from "./analysis-presentation";
import { computeFunnel, funnelFacts } from "./funnel-analysis-preview";

function config(event="page_stay"):AnalysisConfig { const c=emptyAnalysis("events"); c.items=[{key:localId(),ref:event,version:workspaceEvents.find(e=>e.id===event)!.version,measure:"count"}]; return c; }
test("换事件保留兼容条件，只移除失效属性统计",()=>{
  const c=config(), item={...c.items[0],alias:"测试别名",measure:"property" as const,property:"stay_duration_ms",aggregation:"sum" as const,filters:[{key:"p",field:"platform",operator:"in" as const,values:["ios"]},{key:"t",field:"stay_duration_ms",operator:"gt" as const,values:["1"]}]};
  const changed=retargetEventItem(item,"app_launch",workspaceEvents.find(e=>e.id==="app_launch")!.version);
  expect(changed.next.filters).toEqual([item.filters[0]]);
  expect(changed.next.alias).toBe("测试别名");
  expect(changed.next.measure).toBe("count");
  expect(changed.next.property).toBeUndefined();
  expect(changed.removed).toHaveLength(2);
});
test("筛选数量、非法枚举与漏斗分组失败关闭",()=>{
  const c=config(); c.filters=Array.from({length:6},(_,i)=>({key:String(i),field:"platform",operator:"in" as const,values:["ios"]}));
  expect(configurationError(c)).toContain("5条全局");
  c.filters=[{key:"p",field:"platform",operator:"in",values:["unknown"]}];
  expect(configurationError(c)).toContain("失效枚举");
  c.filters=[]; c.kind="funnels"; c.items=["video_content_click","video_play_start"].map(ref=>({key:ref,ref,version:workspaceEvents.find(e=>e.id===ref)!.version,measure:"users"})); c.group="platform";c.secondaryGroup="is_login";
  expect(configurationError(c)).toContain("一个分组");
});
test("继续拆解收窄已有多选，不因同字段而丢失点击分组",()=>{
  const c=config("app_launch"); c.group="platform"; c.filters=[{key:"p",field:"platform",operator:"in",values:["android","ios"]}];
  const next=drillEventConfig(c,{platform:"ios"},"is_login");
  expect(next.filters![0].values).toEqual(["ios"]);
  expect(c.filters[0].values).toEqual(["android","ios"]);
  expect(queryAnalysisPreview(next).totals![0].summaryRaw).toBeLessThan(queryAnalysisPreview(c).totals![0].summaryRaw!);
  expect(()=>drillEventConfig(c,{platform:"web"},"is_login")).toThrow("冲突");
});
test("局部、全局条件与实际二维交叉同源，UV不累计日值",()=>{
  const c=config(); c.group="platform"; c.secondaryGroup="is_login"; c.filters=[{key:"f",field:"platform",operator:"in",values:["ios"]}];
  c.items[0].measure="users";
  const r=queryAnalysisPreview(c);
  expect(r.series).toHaveLength(2);
  expect(r.series.every(s=>s.groupValues!.platform==="ios")).toBe(true);
  expect(r.totals![0].summaryRaw).toBe(16);
  expect(r.series.every(s=>s.summaryRaw!<s.points.reduce((n,p)=>n+p.value!,0))).toBe(true);
  expect(resultPresentation(r).cross).toBe(true);
  expect(resultPresentation(r).pie).toBe(false);
});
test("属性统计、区间条件、缺失值与零",()=>{
  const c=config(); c.items[0]={...c.items[0],measure:"property",property:"stay_duration_ms",aggregation:"avg",filters:[{key:"p",field:"stay_duration_ms",operator:"between",values:["0","3000"]}]};
  const facts=sampleEventFacts("page_stay",c.range.start,c.range.end).filter(f=>matchesFilter(f,c.items[0].filters![0]));
  expect(queryAnalysisPreview(c).totals![0].summaryRaw).toBe(aggregateFacts(facts,c.items[0]));
  c.items[0].filters![0].values=["3000","0"]; expect(configurationError(c)).toContain("区间");
  c.items[0].filters=[]; c.items[0].aggregation="min";
  expect(queryAnalysisPreview(c).totals![0].summaryRaw).toBe(0);
});
test("周月重算而非日UV相加，实际对比日期完整",()=>{
  const c=config("app_launch"); c.range={start:"2026-08-20",end:"2026-09-08"}; c.grain="month"; c.comparison=true; c.items[0].measure="users";
  const r=queryAnalysisPreview(c);
  expect(r.series[0].points).toHaveLength(2);
  expect(r.series[0].points[0].value).toBe(48);
  expect(r.series[1].points[0].actualDate).toBe("2026-07-31");
  expect(r.series[1].points[1].actualDate).toBe("2026-08-01 至 2026-08-19");
});
test("饼图仅在单属性事件次数构成开放，UV/平均值关闭",()=>{
  const c=config("app_launch"); c.group="platform";
  expect(resultPresentation(queryAnalysisPreview(c)).pie).toBe(true);
  c.items[0].measure="users"; expect(resultPresentation(queryAnalysisPreview(c)).pie).toBe(false);
  c.items[0].measure="average"; expect(resultPresentation(queryAnalysisPreview(c)).pie).toBe(false);
});
test("漏斗按用户有序匹配，短窗口改变结果，未成熟不算流失",()=>{
  const c=config(); c.kind="funnels"; c.items=["video_content_click","video_play_start","video_watch_stay"].map(ref=>({key:localId(),ref,version:"1.0",measure:"users"})); c.windowMinutes=1440;
  const facts=funnelFacts(c.range.start,"2026-10-08");
  const result=computeFunnel(c,facts),group=result.groups[0];
  expect(group.steps[0].count).toBe(24); expect(group.steps[2].count).toBe(24);
  c.windowMinutes=1; expect(computeFunnel(c,facts).groups[0].steps[2].count).toBe(0);
  c.windowMinutes=43200; const immature=computeFunnel(c,facts);
  expect(immature.pending).toBeGreaterThan(0); expect(immature.groups[0].steps[0].count).toBe(0); expect(immature.groups[0].steps[2].overall).toBeNull();
  c.windowMinutes=1440; c.items[1]={...c.items[0],key:localId()};
  expect(computeFunnel(c,facts).groups[0].steps[1].count).toBeLessThanOrEqual(24);
});
