import { expect, test } from "bun:test";
import { metricRows } from "./topic-preview-export";
import { paymentBusinessAggregate } from "./payment-observations";
import { paymentOrderSheets } from "./PaymentOrderAnalysis";
import { PAYMENT_BUSINESS_METRICS, paymentBusinessMetricModel, paymentBusinessMetricModels, paymentOrderMetricModels, paymentOrderObservation, paymentOrderWays } from "./payment-order-reading";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";

const range = { start: "2026-09-02", end: "2026-09-08" };

test("USDT 范围按登记目录接入，真实四指标与未知金额状态独立", async () => {
  const values: Record<string, number> = { M113: 0, M112: 2, M060: 1, M114: .5 };
  const rows = Object.entries(values).map(([metricCode, value]) => ({
    metricCode, businessDate: range.end, dimensions: { pid: "PH", payment_method: "usdt" }, value,
    numerator: metricCode === "M114" ? 1 : value, denominator: metricCode === "M114" ? 2 : 0,
    unit: metricCode === "M114" ? "ratio" : "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "first-batch-v1"
  }));
  const data = await new DailyDashboardService({ get: async path => path === "/api/admin/bi/v1/metrics"
    ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: null, rows } }
    : { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] }
  }).execute({ boardId: "5.11", pid: "PH", dateRange: [range.end, range.end] });
  const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "测试", controls: { dirty: false } } as LiveDashboardReading;
  expect(paymentOrderWays(live).map(item => item.id)).toEqual(["all", "alipay", "wechat", "usdt"]);
  expect(paymentOrderWays(null).map(item => item.id)).toEqual(["all", "alipay", "wechat"]);
  const models = paymentOrderMetricModels(range, "usdt", false, live);
  for (const model of models) {
    const id = model.metric.id.split(".")[0];
    if (id in values) {
      expect(model.result.status).toBe("available");
      if (model.result.status === "available") expect(model.result.value.raw).toBe(values[id]);
    } else expect(model.result).toMatchObject({ status: "not_ready", label: "该范围待接入" });
  }
  expect(paymentOrderObservation(live, "M114", "usdt")).toMatchObject({ value: .5, basis: { numerator: { value: 1 }, denominator: { value: 2 } } });
  expect(paymentOrderObservation(live, "M058", "usdt")).toMatchObject({ value: null, unit: "", display: "—", state: "该范围待接入", basis: undefined });
  const exported = metricRows(models, () => "");
  expect(exported.find(row => row[0] === "充值金额")?.[3]).toBeNull();
  expect(exported.find(row => row[0] === "充值金额")?.[4]).toBe("");
  const success = data.data.series.find(series => series.metric.id === "M114.usdt")!;
  success.points[0] = { ...success.points[0], state: "no_value", value: null, sourceStatus: "PROCESSING" };
  expect(paymentOrderWays(live).some(item => item.id === "usdt")).toBe(true);
  expect(paymentOrderObservation(live, "M114", "usdt")).toMatchObject({ value: null, state: "计算中" });
  expect(paymentOrderMetricModels(range, "usdt", false, live).find(model => model.metric.id === "M114.usdt")?.result).toMatchObject({ status: "no_values", label: "计算中" });
  const failed = { ...live, state: { status: "failure", message: "来源失败" } } as LiveDashboardReading;
  expect(paymentOrderWays(failed).some(item => item.id === "usdt")).toBe(true);
  expect(paymentOrderMetricModels(range, "usdt", false, failed).find(model => model.metric.id === "M114.usdt")?.result.status).toBe("failed");
  expect(paymentOrderObservation(failed, "M114", "usdt")).toMatchObject({ value: null, state: "读取失败" });
});

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
