import { expect, test } from "bun:test";
import { metricRows } from "./topic-preview-export";
import { paymentBusinessAggregate } from "./payment-observations";
import { paymentOrderReferenceSheet, paymentOrderSheets } from "./PaymentOrderAnalysis";
import { PAYMENT_BUSINESS_METRICS, paymentBusinessMetricModel, paymentBusinessMetricModels, paymentLinkMetricModel, paymentOrderMetricModels, paymentOrderObservation, paymentOrderWays } from "./payment-order-reading";
import { DailyDashboardService } from "../../../server/v2/daily-dashboard.service";
import type { LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { extendedDailyMetricModel } from "./extended-board-model";

const range = { start: "2026-09-02", end: "2026-09-08" };

test("真实支付比较基准导出标明原始比值，金额与人均单位及空值保持", () => {
  const observations = [["M061", 5 / 6, "%"], ["M064", 1, "%"], ["M058", 162.02, "元"], ["M087", 162.02 / 6, "元/人"], ["M114", null, "%"]] as const;
  const references = observations.flatMap(([metricId, value, unit]) => ["2026-09-07", "2026-09-01"].map((date, index) => ({
    metricId, label: index === 0 ? "较前一天" : "较上周同日", date, value, unit, display: "", state: value === null ? "no_value" as const : "available" as const,
    inputs: [{ key: "numerator", value: value === null ? null : 5 }], fetchedAt: "2026-10-09T12:00:00Z", reason: value === null ? "字段未返回" : "已返回"
  })));
  const sheet = paymentOrderReferenceSheet(references, new Map([["M061", "活跃用户付费率"]]));
  expect(sheet.rows).toHaveLength(11);
  references.forEach((reference, index) => {
    const row = sheet.rows[index + 1];
    expect(row[3]).toBe(reference.date); expect(row[4]).toBe(reference.value);
    expect(row[5]).toBe(reference.unit === "%" ? "原始比值" : reference.unit);
    expect(row[7]).toBe(reference.reason);
  });
  expect(sheet.rows[1][1]).toBe("活跃用户付费率");
});

test("正式支付链路卡只读取真实状态，成功、观察中、来源不完整、失败和零业务均不回退演示值", async () => {
  const rows = [
    { metricCode: "M084", businessDate: range.end, dimensions: { pid: "PH" }, value: 2, numerator: 2, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "payment-chain-v1" },
    { metricCode: "M086", businessDate: range.end, dimensions: { pid: "PH" }, value: 1, numerator: 1, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "payment-chain-v1" },
    { metricCode: "M090", businessDate: range.end, dimensions: { pid: "PH" }, value: .5, numerator: 1, denominator: 2, unit: "ratio", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "payment-chain-v1" }
  ];
  const data = await new DailyDashboardService({ get: async path => path === "/api/admin/bi/v1/metrics"
    ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: "2026-09-08T23:59:59+08:00", rows } }
    : { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] }
  }).execute({ boardId: "5.11", pid: "PH", dateRange: [range.end, range.end] });
  const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id),
    state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "测试",
    controls: { dirty: false } } as LiveDashboardReading;
  const model = (id: string) => paymentLinkMetricModel(extendedDailyMetricModel(id, range, false), live);

  expect(model("M084").result).toMatchObject({ status: "available", value: { raw: 2 } });
  expect(model("M086").result).toMatchObject({ status: "available", value: { raw: 1 } });
  expect(model("M090").result).toMatchObject({ status: "available", value: { raw: .5 } });
  expect(model("M070").result).toMatchObject({ status: "not_ready", label: "该指标尚未接入真实接口" });

  const paymentSubmit = data.data.series.find(series => series.metric.id === "M084")!.points[0];
  paymentSubmit.state = "no_value"; paymentSubmit.value = null; paymentSubmit.sourceStatus = "PROCESSING";
  expect(model("M084").result).toMatchObject({ status: "no_values", label: "计算中" });
  paymentSubmit.sourceStatus = "SOURCE_INCOMPLETE";
  expect(model("M084").result).toMatchObject({ status: "no_values", label: "数据接入中" });
  paymentSubmit.state = "source_failure"; paymentSubmit.sourceStatus = "FAILED";
  expect(model("M084").result).toMatchObject({ status: "failed", label: "数据异常" });

  const credited = data.data.series.find(series => series.metric.id === "M086")!.points[0];
  credited.state = "immature"; credited.value = null; credited.sourceStatus = "NOT_MATURE";
  expect(model("M086").result).toMatchObject({ status: "no_values", label: "待成熟" });

  const conversion = data.data.series.find(series => series.metric.id === "M090")!.points[0];
  conversion.state = "zero_denominator"; conversion.value = null; conversion.sourceStatus = "READY";
  conversion.inputs = conversion.inputs.map(input => ({ ...input, value: 0 }));
  expect(model("M090").result).toMatchObject({ status: "no_values", label: "分母为0" });
});

for (const dimensionField of ["paymentMethod", "payment_method"] as const) {
  for (const boardId of ["5.2", "5.11"]) {
    for (const sourceValues of ["formal", "legacy"] as const) {
      test(`${boardId}的${dimensionField}返回${sourceValues}值时支付专题读取各方式独立结果`, async () => {
        const metricCodes = ["M112", "M113", "M060", "M114"] as const;
        const groups = [
          { method: "all", formal: "", counts: [41, 23, 17] },
          { method: "alipay", formal: "ali_pay", counts: [2, 1, 1] },
          { method: "wechat", formal: "wx_pay", counts: [5, 3, 2] },
          { method: "usdt", formal: "usdt_pay", counts: [11, 6, 7] },
          { method: "unknown", formal: "unknown", counts: [101, 70, 89] }
        ] as const;
        const rows = groups.flatMap(({ method, formal, counts: [requests, users, successes] }) => {
          const values = [requests, users, successes, successes / requests];
          return metricCodes.map((metricCode, index) => ({
            metricCode, businessDate: range.end,
            dimensions: { pid: "PH", ...(method === "all" ? {} : { [dimensionField]: sourceValues === "formal" ? formal : method }) },
            value: values[index], numerator: metricCode === "M114" ? successes : values[index],
            denominator: metricCode === "M114" ? requests : 0, unit: metricCode === "M114" ? "ratio" : "count",
            dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "rule-v1"
          }));
        });
        const data = await new DailyDashboardService({ get: async path => path === "/api/admin/bi/v1/metrics"
          ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: null, rows } }
          : { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] }
        }, () => new Date("2026-10-10T00:00:00Z")).execute({ boardId, pid: "PH", dateRange: [range.end, range.end] });
        const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id),
          state: { status: "success", data, refreshing: false, refreshError: null },
          platformName: "测试", controls: { dirty: false } } as LiveDashboardReading;
        for (const [method, requests, users, successes] of [["all", 41, 23, 17], ["alipay", 2, 1, 1], ["wechat", 5, 3, 2], ["usdt", 11, 6, 7], ["unknown", 101, 70, 89]] as const) {
          const values = [requests, users, successes, successes / requests];
          metricCodes.forEach((code, index) => {
            expect(paymentOrderObservation(live, code, method)).toMatchObject({ value: values[index] });
          });
          expect(paymentOrderObservation(live, "M114", method)).toMatchObject({
            basis: { numerator: { value: successes }, denominator: { value: requests } }
          });
        }
      });
    }
  }
}

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
  expect(paymentOrderWays(live).map(item => item.id)).toEqual(["all", "alipay", "wechat", "usdt", "unknown"]);
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

test("未知支付方式独立登记与取值，不由总体扣除已知方式，不与 USDT 绑定", async () => {
  const data = await new DailyDashboardService({ get: async path => path === "/api/admin/bi/v1/metrics"
    ? { code: 200, msg: { metricVersion: "bi-v1", generatedAt: "2026-09-09T10:00:00+08:00", watermark: null, rows: [
      { metricCode: "M113", businessDate: range.end, dimensions: { pid: "PH" }, value: 99, numerator: 99, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "test-v1" },
      { metricCode: "M113", businessDate: range.end, dimensions: { pid: "PH", paymentMethod: "unknown" }, value: 0, numerator: 0, denominator: 0, unit: "count", dataStatus: "READY", metricVersion: "bi-v1", ruleVersion: "test-v1" }
    ] } }
    : { msg: { pageData: [], totalData: [], totalCount: 0 }, data: [] }
  }).execute({ boardId: "5.11", pid: "PH", dateRange: [range.end, range.end] });
  const live = { query: data.data.query, metricIds: data.data.series.map(series => series.metric.id), state: { status: "success", data, refreshing: false, refreshError: null }, platformName: "测试", controls: { dirty: false } } as LiveDashboardReading;
  expect(paymentOrderWays({ ...live, metricIds: ["M113", "M113.unknown"] }).map(item => item.id)).toEqual(["all", "alipay", "wechat", "unknown"]);
  expect(paymentOrderObservation(live, "M113", "unknown")).toMatchObject({ value: 0 });
  expect(paymentOrderObservation(live, "M112", "unknown")).toMatchObject({ value: null });
  expect(paymentOrderObservation(live, "M058", "unknown")).toMatchObject({ value: null, state: "该范围待接入" });
  const users = data.data.series.find(series => series.metric.id === "M113.unknown")!;
  users.points[0] = { ...users.points[0], state: "no_value", value: null, sourceStatus: "SOURCE_INCOMPLETE" };
  expect(paymentOrderObservation(live, "M113", "unknown")).toMatchObject({ value: null });
  const failed = { ...live, state: { status: "failure", message: "来源失败" } } as LiveDashboardReading;
  expect(paymentOrderObservation(failed, "M113", "unknown")).toMatchObject({ value: null, state: "读取失败" });
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
