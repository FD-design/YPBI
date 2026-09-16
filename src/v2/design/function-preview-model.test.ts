import { test, expect } from "bun:test";
import { DEFAULT_FUNCTION_VIEW, functionCatalog, functionResult, functionRows, functionMetric, functionHref, parseFunctionView } from "./function-preview-model";
import { resolveDevelopmentPreview } from "./development-preview-route";
import { OVERALL_USAGE_SCOPE, USAGE_SCOPES, usageScopeKey } from "./usage-observation-fixtures";
import { functionObservations } from "./function-preview-model";
import { functionStructureSheet } from "./FunctionUsageStructure";
test("功能目录来自权威页面，通用模板不新建指标；主比较没有TopN", () => {
  expect(functionCatalog.items).toHaveLength(50);
  expect(new Set(functionCatalog.items.map(item => item.id)).size).toBe(50);
  expect(functionRows(DEFAULT_FUNCTION_VIEW)).toHaveLength(50);
  const model = functionMetric("video_home", DEFAULT_FUNCTION_VIEW.range, true);
  expect(model.metric.id).toBe("template:module-penetration");
  const mixed = functionRows({ ...DEFAULT_FUNCTION_VIEW, mixed: true });
  expect(mixed[0].current!.rate).toBe(0);
  expect(mixed.slice(1,5).map(row => row.status)).toEqual(["未启用", "无记录", "未产出", "查询失败"]);
  expect(mixed.slice(1,5).every(row => row.current === null)).toBe(true);
  const zero = functionMetric(mixed[0].id, DEFAULT_FUNCTION_VIEW.range, true, OVERALL_USAGE_SCOPE, true);
  expect(zero.result.status).toBe("available");
  if (zero.result.status === "available") {
    expect(zero.result.value.raw).toBe(0);
    expect(zero.result.trend.current.every(point => point.value?.raw === 0)).toBe(true);
    expect(zero.result.trend.current.every(point => (point.counterpart?.raw ?? 0) > 0)).toBe(true);
  }
  expect(functionResult(mixed[0].id, DEFAULT_FUNCTION_VIEW.range, { client: "android", audience: "new" }, true).users).toBe(0);
});

test("功能单选范围与全部交叉来自同一观测，摘要、逐日、实名输入及导出一致", () => {
  const range = DEFAULT_FUNCTION_VIEW.range, facts = functionObservations("video_home", range), sheet = functionStructureSheet("video_home", "视频首页", range, true, false);
  for (const scope of USAGE_SCOPES) {
    const result = functionResult("video_home", range, scope), row = facts.summary.find(row => usageScopeKey(row.scope) === usageScopeKey(scope))!;
    expect(result.users).toBe(row.users); expect(result.active).toBe(row.active);
    expect(result.rate).toBe(row.active ? row.users / row.active : null);
    const model = functionMetric("video_home", range, true, scope);
    if (model.result.status === "available") {
      expect(model.result.calculation?.numerator.value).toBe(row.users); expect(model.result.calculation?.denominator.value).toBe(row.active);
      for (const point of model.result.trend.current) {
        const fact = facts.daily.find(day => day.date === point.actualDate && usageScopeKey(day.scope) === usageScopeKey(scope))!;
        expect(point.calculation?.numerator.value).toBe(fact.users); expect(point.calculation?.denominator.value).toBe(fact.active);
      }
    }
  }
  expect(sheet.rows).toHaveLength(37);
  expect(JSON.stringify(sheet.rows)).toContain("未识别客户端"); expect(JSON.stringify(sheet.rows)).toContain("对比期");
  expect(JSON.stringify(sheet.rows)).not.toContain("clicks");
  const zero = functionResult("video_home", range, { client: "unknown", audience: "overall" }, true);
  expect(zero).toEqual({ users: 0, active: 0, rate: null });
  expect(functionMetric("video_home", range, false, { client: "unknown", audience: "overall" }, true).result.status).toBe("no_values");
  expect(parseFunctionView(JSON.stringify({ ...DEFAULT_FUNCTION_VIEW, structureScope: { client: "ios", audience: "new" } }))?.structureScope).toEqual({ client: "ios", audience: "new" });
  expect(parseFunctionView(JSON.stringify({ ...DEFAULT_FUNCTION_VIEW, structureScope: { client: "ios", audience: "alien" } }))).toBeNull();
});
test("日期结果用同范围样本、不反推分子；多功能深链最多5项且无重复", () => {
  for (const range of [{ start: "2026-09-03", end: "2026-09-03" }, { start: "2026-08-01", end: "2026-08-31" }, { start: "2025-09-08", end: "2026-09-08" }]) {
    const row = functionResult("video_home", range);
    expect(row.rate).toBe(row.users / row.active); expect(row.users).toBeLessThanOrEqual(row.active);
    const model = functionMetric("video_home", range, false);
    expect(model.result.status === "available" && model.result.comparison).toBeNull();
  }
  expect(parseFunctionView(JSON.stringify({ ...DEFAULT_FUNCTION_VIEW, selected: functionCatalog.items.slice(0,6).map(item => item.id) }))).toBeNull();
  expect(parseFunctionView(JSON.stringify({ ...DEFAULT_FUNCTION_VIEW, selected: ["video_home", "video_home"] }))).toBeNull();
  expect(parseFunctionView(JSON.stringify({ ...DEFAULT_FUNCTION_VIEW, selected: ["invalid"] }))).toBeNull();
  expect(resolveDevelopmentPreview(new URL(functionHref(DEFAULT_FUNCTION_VIEW), "http://localhost"))).toBe("dashboard-center");
});
