import { test, expect } from "bun:test";
import { localId, emptyAnalysis, saveWorkspaceObject, readWorkspace, removePersonalObject, addAnalysisToBoard, validName, stageAnalysisDraft, readAnalysisDraft, clearAnalysisDraft } from "./personal-workspace-model";
import { queryAnalysisPreview, configurationError, workspaceEvents, quickMetricDate, analysisCellDisplay, workspaceMetrics, workspacePlatforms, quickPlatformSample } from "./personal-query-preview";
test("速览进入分析保留指标、平台和日期，平台演示数据与明细一致",()=>{
  const config=emptyAnalysis("metrics"),metric=workspaceMetrics.find(m=>m.id==="M016")!;
  config.items=[{key:metric.id,ref:metric.id,version:metric.authority.version,measure:"count"}];
  config.range={start:"2026-09-08",end:"2026-09-08"};
  const original=queryAnalysisPreview(config).series[0],pid=workspacePlatforms[0].pid;
  const fixture=quickPlatformSample(original,pid)!;
  config.scope=pid;
  stageAnalysisDraft(config);config.range.start="2026-09-07";
  const draft=readAnalysisDraft("metrics")!;
  expect(draft.range.start).toBe("2026-09-08");
  expect(draft.scope).toBe(pid);
  expect(readAnalysisDraft("events")).toBeNull();
  const result=queryAnalysisPreview(draft);
  expect(result.warnings).toEqual([]);
  expect(result.series[0].summaryRaw).toBe(fixture.summaryRaw);
  expect(result.series[0].points).toEqual(fixture.points);
  expect(result.series[0].summaryRaw).not.toBe(original.summaryRaw);
  clearAnalysisDraft();expect(readAnalysisDraft("metrics")).toBeNull();
});
test("数值列不重复单位，比例只缩放一次，0和缺失保持区别", () => {
  expect(analysisCellDisplay(0, "人")).toBe("0");
  expect(analysisCellDisplay(null, "人")).toBe("—");
  expect(analysisCellDisplay(198282, "人")).toBe("198,282");
  expect(analysisCellDisplay(.4079, "%")).toBe("40.79");
});
test("次留选择最近成熟注册日且历史参考日不再向前错移", () => {
  expect(quickMetricDate("M020", "2026-09-08")).toBe("2026-09-07");
  expect(quickMetricDate("M020", "2026-09-03")).toBe("2026-09-03");
  expect(quickMetricDate("M016", "2026-09-08")).toBe("2026-09-08");
});
test("体验对象按稳定引用关联，删除看板不删除来源，旧修订不能覆盖", () => {
  const source = saveWorkspaceObject("analyses", { id: localId(), revision: 0, name: "分析", config: emptyAnalysis("metrics"), updated: "" });
  const board = saveWorkspaceObject("boards", { id: localId(), revision: 0, name: "看板", components: [], updated: "" });
  addAnalysisToBoard(source.id, board.id);
  expect(readWorkspace().boards.find(b => b.id === board.id)?.components[0].sourceId).toBe(source.id);
  expect(() => saveWorkspaceObject("boards", board)).toThrow("已更新");
  removePersonalObject("boards", board.id);
  expect(readWorkspace().analyses.some(a => a.id === source.id)).toBe(true);
  expect(validName("   ")).toBe(false); expect(validName("名".repeat(61))).toBe(false);
});
test("空项与超限阻止查询，版本变化不能静默替换", () => {
  const config = emptyAnalysis("events");
  expect(configurationError(config)).toContain("选择");
  config.items = Array.from({ length: 6 }, () => ({ key: localId(), ref: "app_launch", version: "1.0", measure: "count" }));
  expect(configurationError(config)).toContain("1～5");
  config.items = [{ key: localId(), ref: "app_launch", version: "wrong", measure: "count" }];
  expect(configurationError(config)).toContain("版本");
});
test("事件人均以区间事实/区间主体计算，按端分组和单平台缺口不伪造", () => {
  const config = emptyAnalysis("events"), version = workspaceEvents.find(e => e.id === "app_launch")!.version;
  config.items = ["count", "users", "average"].map(measure => ({ key: localId(), ref: "app_launch", version, measure: measure as "count" | "users" | "average" }));
  const result = queryAnalysisPreview(config), [count, users, average] = result.series;
  expect(Number(users.summary)).toBeLessThan(users.points.reduce((sum, point) => sum + point.value!, 0));
  expect(Number(average.summary)).toBeCloseTo(Number(count.summary) / Number(users.summary), 2);
  config.group = "platform";
  expect(queryAnalysisPreview(config).series).toHaveLength(9);
  config.scope = "PH";
  expect(queryAnalysisPreview(config).series).toHaveLength(0);
  expect(queryAnalysisPreview(config).warnings[0]).toContain("未以大盘结果替代");
});
