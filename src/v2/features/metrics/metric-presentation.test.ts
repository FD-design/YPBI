import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BUSINESS_EXPLANATION_PENDING, containsTechnicalExpression, metricBusinessExplanation } from "./metric-presentation.ts";
import { containsInternalReferenceCode, formatMetricAuthorityText, hideInternalReferenceCodes } from "./metric-presentation.ts";

const metricNames = new Map([
  ["M016", "日活跃用户数"],
  ["M026", "观影用户数"],
  ["DM002", "累计观影人天"]
]);

const catalog = JSON.parse(readFileSync(new URL("../../../../server/v2/generated/metric-definitions.json", import.meta.url), "utf8"));
const names = new Map<string, string>(catalog.items.map((item: { id: string; name: string }) => [item.id, item.name]));
const explanation = (id: string) => metricBusinessExplanation(catalog.items.find((item: { id: string }) => item.id === id), names);

test("全部指标展示释义可读，不包含协议代码且不修改权威源", () => {
  const before = JSON.stringify(catalog);
  for (const metric of catalog.items) {
    const result = metricBusinessExplanation(metric, names);
    assert.equal(containsTechnicalExpression(result.text), false, metric.id);
    assert.equal(containsInternalReferenceCode(result.text), false, metric.id);
    assert.equal(result.text.includes(BUSINESS_EXPLANATION_PENDING), false, metric.id);
    for (const field of ["definition", "developmentFormula", "deduplication", "windowAndGrain", "dataSource", "exclusions", "knownIssues", "recommendedDefinition", "boundary"]) {
      assert.notEqual(formatMetricAuthorityText(metric.authority[field], names), BUSINESS_EXPLANATION_PENDING, `${metric.id} ${field}`);
    }
  }
  assert.equal(JSON.stringify(catalog), before);
});

test("启动成熟分母、有效观看门槛和短视频例外完整保留", () => {
  const launch = explanation("M080").formula;
  assert.match(launch, /已成熟的有效启动/);
  assert.match(launch, /不同启动标识启动数 × 100%/);
  const effective = explanation("M035").text;
  for (const fact of ["首帧成功", "至少 15 秒", "至少 3 秒", "不足 3 秒", "完整播放", "同一有效观看规则", "去重用户数"]) assert.ok(effective.includes(fact), fact);
  const currentRule = catalog.items.find((item: { id: string }) => item.id === "M034").authority.registeredFormula;
  assert.ok(currentRule.includes("watch_duration_ms>=15000") && currentRule.includes("3000<=video_duration_ms<15000") && currentRule.includes("watch_duration_ms>=3000") && currentRule.includes("0<video_duration_ms<3000") && currentRule.includes("watch_end_reason=completed"), "有效观看规则变化时必须更新业务释义");
  assert.match(explanation("M031").formula, /已完成结果判断的有效播放尝试数/);
  assert.match(explanation("M043").formula, /按当前有效观看规则完成至少一次观看/);
  assert.match(explanation("M043").formula, /统计窗口内有效观影用户数/);
});

test("注册转化保留 IP·天分母，百分率与金额均值分别处理", () => {
  assert.match(explanation("M006").formula, /注册用户数区间排重 ÷ 总下载IP·天合计 × 100%/);
  assert.match(explanation("M007").formula, /落地页访问IP·天合计 × 100%/);
  assert.match(explanation("M036").formula, /有效观看次数 ÷ 起播次数 × 100%/);
  assert.ok(!explanation("M067").formula.includes("100%"));
  assert.equal(formatMetricAuthorityText("new_event.result_status=true", names), BUSINESS_EXPLANATION_PENDING);
});

test("权威定义中的指标编号转换为业务名称并消除重复名称", () => {
  assert.equal(
    formatMetricAuthorityText("M016 日活跃用户数 ÷ M026 观影用户数", metricNames),
    "日活跃用户数 ÷ 观影用户数"
  );
  assert.equal(
    formatMetricAuthorityText("多日逐日相加得到 DM002 累计观影人天", metricNames),
    "多日逐日相加得到累计观影人天"
  );
});

test("未知内部编号和文档编号不会泄露到用户文案", () => {
  const result = formatMetricAuthorityText("依赖 M999 与 MD-06，并见 01A", metricNames);
  assert.equal(result, "依赖相关指标与相关能力，并见相关能力");
  assert.equal(containsInternalReferenceCode(result), false);
});

test("服务端动态消息在展示前移除内部编号", () => {
  const result = hideInternalReferenceCodes("M016 查询失败；映射 m016-pday-sum-v1；请核对 MD-06 与 01B");
  assert.equal(result, "相关指标查询失败；映射相关指标-pday-sum-v1；请核对相关能力与相关能力");
  assert.equal(containsInternalReferenceCode(result), false);
});
