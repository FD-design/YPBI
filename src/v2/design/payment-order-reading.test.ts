import { expect, test } from "bun:test";
import { metricRows } from "./topic-preview-export";
import { paymentBusinessAggregate } from "./payment-observations";
import { paymentOrderSheets } from "./PaymentOrderAnalysis";
import { PAYMENT_BUSINESS_METRICS, paymentBusinessMetricModel, paymentBusinessMetricModels } from "./payment-order-reading";

const range = { start: "2026-09-02", end: "2026-09-08" };

test("支付日报摘要读取同一支付方式的所选日值和精确 D−1、D−7", () => {
  const model = paymentBusinessMetricModel("M114", range, "alipay", true);
  if (model.result.status !== "available") throw new Error("missing payment fixture");
  const selected = paymentBusinessAggregate({ start: range.end, end: range.end }, "alipay");
  expect(model.result.value.raw).toBe(selected.values.M114);
  expect(model.result.reading?.primaryLabel).toBe("所选日 2026-09-08");
  expect(model.result.reading?.comparisons.map(item => item.label)).toEqual(["较前一天", "较上周同日"]);
  expect(model.result.reading?.comparisons.map(item => item.status === "available" ? item.rows?.[1].date : null)).toEqual(["2026-09-07", "2026-09-01"]);
  expect(model.result.calculation?.numerator.value).toBe(selected.inputs.successes);
  expect(model.result.calculation?.denominator.value).toBe(selected.inputs.requests);
  expect(model.result.trend.current).toHaveLength(7);
  expect(model.result.trend.comparison).toHaveLength(7);
  expect(model.result.trend.comparison?.[0].differenceDisplay).toBe(model.result.trend.current[0].differenceDisplay);
});

test("九项摘要关闭比较不残留变化，并按总体、支付宝、微信各自同源", () => {
  for (const way of ["all", "alipay", "wechat"]) {
    const models = paymentBusinessMetricModels(range, way, false);
    const selected = paymentBusinessAggregate({ start: range.end, end: range.end }, way);
    expect(models).toHaveLength(PAYMENT_BUSINESS_METRICS.length);
    for (const model of models) {
      if (model.result.status !== "available") throw new Error("missing payment fixture");
      expect(model.result.value.raw).toBe(selected.values[model.metric.id]);
      expect(model.result.reading?.comparisons).toEqual([]);
      expect(model.result.trend.comparison).toBeNull();
      expect(model.metric.aggregationLabel).toContain(way === "all" ? "总体" : way === "alipay" ? "支付宝" : "微信");
      if (model.result.calculation) expect(model.result.calculation.scope).toContain(way === "all" ? "总体" : way === "alipay" ? "支付宝" : "微信");
    }
  }
});

test("单项与整块导出保留真实参考日期和同源计算输入", () => {
  const model = paymentBusinessMetricModel("M061", range, "wechat", true);
  const rows = metricRows([model], () => "%");
  expect(rows.find(row => row[1] === "较前一天")?.[5]).toBe("2026-09-07");
  expect(rows.find(row => row[1] === "较上周同日")?.[5]).toBe("2026-09-01");
  expect(rows.filter(row => row[1] === "趋势")).toHaveLength(7);
  expect(rows[0]).toContain("活跃用户数（分母）");
  expect(rows.at(-1)?.[rows[0].indexOf("活跃用户数（分母）")]).toBe(587);

  const reference = paymentOrderSheets(range, false, true).find(sheet => sheet.name === "04_日值比较基准");
  expect(reference?.rows[0]).toEqual(["比较项", "实际日期", "支付方式", "指标", "值", "单位"]);
  expect(reference?.rows.some(row => row[0] === "较前一天" && row[1] === "2026-09-07" && row[2] === "微信" && row[3] === "活跃用户付费率")).toBe(true);
  expect(reference?.rows.some(row => row[0] === "较上周同日" && row[1] === "2026-09-01" && row[2] === "支付宝" && row[3] === "充值成功率")).toBe(true);
  expect(paymentOrderSheets(range, false, false).some(sheet => sheet.name === "04_日值比较基准")).toBe(false);
});
