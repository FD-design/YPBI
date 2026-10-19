import { expect, test } from "bun:test";
import type { DailyPoint, DailyReadingMetric } from "../../../contracts/daily-dashboard";
import { OPERATING_SUMMARY_IDS } from "./operating-detail-columns";
import { operatingPlatformSummary, type AggregateSummaryEntry } from "./operating-platform-summary";

const date = "2026-10-12";
function entry(id: string, pid: string, value: number | null, values: number[] = [value ?? 0], overrides: Partial<AggregateSummaryEntry> = {}): AggregateSummaryEntry {
  const ratio = ["M081", "M020", "M061", "M111"].includes(id), divide = ratio || id === "M067" || id === "M110";
  const unit = ratio ? "%" : id === "M058" ? "元" : id === "M067" ? "元/人" : id === "M110" ? "次/人" : "人";
  const metric: DailyReadingMetric = { id, referenceMetricId: id, name: id, unit, definition: "来源定义", authorityVersion: "fixture-v1", sourceNote: null,
    formula: divide ? "分子 ÷ 分母" : null, inputs: (divide ? ["numerator", "denominator"] : ["value"]).map((key, index) => ({ key, name: index === 0 ? "分子" : "分母", unit: id === "M067" && index === 0 ? "元" : "人" })) };
  const point: DailyPoint = { date, state: value === null ? "zero_denominator" : "available", sourceStatus: "READY", value,
    inputs: metric.inputs.map((input, index) => ({ key: input.key, value: values[index] ?? null })) };
  return { pid, name: pid, metric, point, ...overrides };
}
function summary(id: string, entries: AggregateSummaryEntry[]) { return operatingPlatformSummary(date, { [id]: entries }).find(model => model.metric.id === id)!; }
function available(id: string, entries: AggregateSummaryEntry[]) {
  const model = summary(id, entries);
  if (model.result.status !== "available") throw Error(JSON.stringify(model.result));
  return model.result;
}

test("返回十项固定顺序，空范围保持不可用", () => {
  const models = operatingPlatformSummary(date, {});
  expect(models.map(model => model.metric.id)).toEqual(OPERATING_SUMMARY_IDS);
  expect(models.every(model => model.result.status === "unsupported")).toBe(true);
  expect(models[0].metric.aggregationLabel).toContain("覆盖0/0平台");
});

test("计数及金额逐平台相加，真实0及元保持", () => {
  expect(available("M016", [entry("M016", "A", 0), entry("M016", "B", 6)]).value.raw).toBe(6);
  expect(available("M016", [entry("M016", "A", 0)]).value.raw).toBe(0);
  const amount = available("M058", [entry("M058", "A", 1.2), entry("M058", "B", 2.3)]);
  expect(amount.value).toEqual({ raw: 3.5, display: "3.5", unit: "元" });
});

test("比率只按同指标输入合计重算，保留91/102及一次百分比格式化", () => {
  const result = available("M081", [entry("M081", "A", .5, [1, 2]), entry("M081", "B", .9, [90, 100])]);
  expect(result.value.raw).toBe(91 / 102);
  expect(result.value.display).toBe("89.22");
  expect(result.calculation?.numerator.value).toBe(91);
  expect(result.calculation?.denominator.value).toBe(102);
  expect(result.calculation?.scope).toContain("未跨PID去重");
  expect(result.calculation?.scope).toContain("不是全站唯一人数");
});

test("人均金额按同指标金额和人数组成，保留元/人及小额精度", () => {
  const result = available("M067", [entry("M067", "A", .004, [.012, 3]), entry("M067", "B", .008, [.008, 1])]);
  expect(result.value.raw).toBe(.005);
  expect(result.value.display).toBe("0.005");
  expect(result.value.unit).toBe("元/人");
  expect(result.calculation?.numerator.value).toBe(.02);
  expect(result.calculation?.denominator.value).toBe(4);
});

test("0/0可与有效平台合并，整体0/0保留零分母而不输出0%", () => {
  const zero = entry("M020", "A", null, [0, 0]);
  expect(available("M020", [zero, entry("M020", "B", .5, [1, 2])]).value.raw).toBe(.5);
  const result = summary("M020", [zero]).result;
  expect(result.status).toBe("no_values");
  expect(result).toMatchObject({ label: "分母为0", calculation: { numerator: { value: 0 }, denominator: { value: 0 } } });
  expect(available("M020", [entry("M020", "A", 0, [0, 5])]).value.display).toBe("0.00");
});

test("合法非零分子与零分母保留原输入及分母为0状态", () => {
  for (const id of ["M110", "M111", "M061"]) {
    const source = entry(id, "PH", null, [137630, 0]);
    const model = operatingPlatformSummary(date, { [id]: [source] }, { metricIds: [id] })[0];
    expect(model.result).toMatchObject({ status: "no_values", label: "分母为0", calculation: {
      numerator: { value: 137630 }, denominator: { value: 0 }, result: "分母为0"
    } });
    expect(model.metric.aggregationLabel).toContain("覆盖1/1平台");
    expect(model.metric.definitionLabel).not.toContain("计算输入异常或缺失");
    expect(source.point).toMatchObject({ sourceStatus: "READY", state: "zero_denominator", value: null });
  }
});

test("人均合计保留各平台零分母记录的真实分子，不借其他指标人数", () => {
  const source = entry("M110", "PH", null, [137630, 0]);
  const model = operatingPlatformSummary(date, { M110: [source, entry("M110", "B", .5, [2, 4])] }, { metricIds: ["M110"] })[0];
  expect(model.result).toMatchObject({ status: "available", value: { raw: 137632 / 4, unit: "次/人" }, calculation: {
    numerator: { value: 137632 }, denominator: { value: 4 }
  } });
  expect(model.metric.aggregationLabel).toContain("覆盖2/2平台");
});

test("零分母准入仍拒绝错误分母和留存分子超出注册批次", () => {
  expect(summary("M020", [entry("M020", "PH", null, [1, 0])]).result).toMatchObject({ label: "计算输入异常或缺失" });
  for (const values of [[1, 2], [-1, 0], [NaN, 0], [1, NaN]]) {
    const model = operatingPlatformSummary(date, { M110: [entry("M110", "PH", null, values)] }, { metricIds: ["M110"] })[0];
    expect(model.result).toMatchObject({ label: "计算输入异常或缺失" });
  }
  for (const sourceStatus of ["PROCESSING", "SOURCE_INCOMPLETE", "NOT_MATURE", "FAILED"] as const) {
    const source = entry("M110", "PH", null, [137630, 0]);
    source.point!.sourceStatus = sourceStatus;
    const model = operatingPlatformSummary(date, { M110: [source] }, { metricIds: ["M110"] })[0];
    expect(model.result).not.toMatchObject({ label: "分母为0" });
    expect(model.metric.aggregationLabel).toContain("覆盖0/1平台");
  }
});

test("旧合法无sourceStatus结果可以合计", () => {
  const legacy = entry("M016", "A", 10);
  delete legacy.point!.sourceStatus;
  expect(available("M016", [legacy]).value.raw).toBe(10);
});

test("缺失平台显示部分合计和覆盖，不用缺失补0", () => {
  const missing: AggregateSummaryEntry = { pid: "B", name: "平台B", metric: null, point: null };
  const model = summary("M016", [entry("M016", "A", 8), missing]);
  expect(model.result).toMatchObject({ status: "available", completeness: "partial", value: { raw: 8 } });
  expect(model.metric.aggregationLabel).toContain("部分平台合计");
  expect(model.metric.aggregationLabel).toContain("覆盖1/2平台");
  expect(model.result.watermarkLabel).toContain("1个平台未计入");
  expect(model.metric.definitionLabel).toContain("平台B（B）：字段未返回");
});

test("无可用平台保留加载和失败原因", () => {
  const loading: AggregateSummaryEntry = { pid: "A", name: "A", metric: null, point: null, unavailable: { status: "loading", contextLabel: date, retryable: false, label: "读取中" } };
  expect(summary("M016", [loading]).result).toMatchObject({ status: "loading", message: "1个平台均无可用结果；各平台状态保留在下方明细。" });
  const failed = { ...loading, unavailable: { status: "failed" as const, contextLabel: date, retryable: true, label: "读取失败", message: "请求超时" } };
  expect(summary("M016", [loading, { ...failed, pid: "B" }]).result).toMatchObject({ status: "failed", retryable: true });
  const failedResult = summary("M016", [failed]).result;
  expect(failedResult.status !== "available" && failedResult.message).toContain("请求超时");
});

test("零分母不能绕过失败来源或未就绪状态", () => {
  const failed = entry("M020", "A", null, [0, 0], { unavailable: { status: "failed", contextLabel: date, label: "读取失败", retryable: true } });
  expect(summary("M020", [failed]).result.status).toBe("failed");
  const incomplete = entry("M020", "A", null, [0, 0]);
  incomplete.point!.sourceStatus = "SOURCE_INCOMPLETE";
  expect(summary("M020", [incomplete]).result).toMatchObject({ status: "no_values", label: "来源不完整" });
});

for (const [status, expected] of [["PROCESSING", "not_produced"], ["NOT_MATURE", "immature"], ["SOURCE_INCOMPLETE", "no_values"], ["FAILED", "failed"]] as const) {
  test(`${status}及诊断输入不进入正式合计`, () => {
    const source = entry("M020", "A", .5, [1, 2]);
    source.point!.sourceStatus = status;
    expect(summary("M020", [source]).result.status).toBe(expected);
    const mixed = available("M020", [source, entry("M020", "B", .9, [90, 100])]);
    expect(mixed.value.raw).toBe(.9);
    expect(mixed.completeness).toBe("partial");
    expect(mixed.calculation?.numerator.value).toBe(90);
    expect(mixed.calculation?.denominator.value).toBe(100);
  });
}

test("单位、公式、输入定义及权威版本冲突不混算", () => {
  for (const change of [(metric: DailyReadingMetric) => { metric.unit = "USD"; }, (metric: DailyReadingMetric) => { metric.formula = "其他旧源公式"; },
    (metric: DailyReadingMetric) => { metric.inputs[0].key = "other"; }, (metric: DailyReadingMetric) => { metric.inputs[0].unit = "次"; },
    (metric: DailyReadingMetric) => { metric.authorityVersion = "other"; }]) {
    const a = entry("M058", "A", 2), b = entry("M058", "B", 3);
    change(b.metric!);
    expect(summary("M058", [a, b]).result).toMatchObject({ status: "no_values", label: "汇总口径不一致" });
  }
});

test("未知单位保留而不套用演示USD或换算", () => {
  const a = entry("M058", "A", 5), b = entry("M058", "B", 6);
  a.metric!.unit = b.metric!.unit = "币种未确认";
  expect(available("M058", [a, b]).value).toEqual({ raw: 11, display: "11", unit: "币种未确认" });
});

test("同PID只合计一次，矛盾重复PID保持不可用", () => {
  const a = entry("M016", "A", 8);
  const model = summary("M016", [a, structuredClone(a)]);
  expect(model.result).toMatchObject({ status: "available", value: { raw: 8 } });
  expect(model.metric.aggregationLabel).toContain("覆盖1/1平台");
  expect(summary("M016", [a, entry("M016", "A", 9)]).result).toMatchObject({ status: "no_values", label: "重复PID结果不一致" });
});

test("跨指标记录不进入汇总，M020不能复用独立新增人数", () => {
  expect(summary("M016", [entry("M008", "A", 8)]).result.status).toBe("no_values");
  const retention = entry("M020", "A", .5, [1, 2]);
  retention.metric!.referenceMetricId = "M008";
  expect(summary("M020", [retention]).result.status).toBe("no_values");
});

test("输入缺失、非法人数及错误日期不能倒推或混用", () => {
  for (const values of [[null, 2], [1, null], [-1, 2], [3, 2], [1.5, 2], [1, 0], [NaN, 2]]) {
    const source = entry("M020", "A", .5, [1, 2]);
    source.point!.inputs.forEach((input, index) => { input.value = values[index]; });
    expect(summary("M020", [source]).result.status).toBe("no_values");
  }
  const wrongDate = entry("M016", "A", 8); wrongDate.point!.date = "2026-10-11";
  expect(summary("M016", [wrongDate]).result).toMatchObject({ status: "no_values", label: "数据日不一致" });
});

test("M020按本指标注册批次输入，不读取其他指标数据", () => {
  const result = operatingPlatformSummary(date, { M020: [entry("M020", "A", .5, [1, 2]), entry("M020", "B", .9, [90, 100])], M008: [entry("M008", "A", 800), entry("M008", "B", 900)] });
  expect(result.find(model => model.metric.id === "M020")!.result).toMatchObject({ status: "available", value: { raw: 91 / 102 }, calculation: { denominator: { value: 102 } } });
});

test("源部分与刷新失败维持现有状态，完整性未知不标正式完整", () => {
  const source = entry("M016", "A", 8, [8], { completeness: "partial", refresh: { status: "failed", source: "page", message: "刷新超时", retryable: true } });
  expect(available("M016", [source])).toMatchObject({ completeness: "partial", refresh: { status: "failed", message: "刷新超时" } });
  expect(available("M016", [entry("M016", "A", 8)])).toMatchObject({ completeness: "unknown" });
  expect(available("M016", [entry("M016", "A", 8, [8], { completeness: "complete" })])).toMatchObject({ completeness: "complete" });
});
