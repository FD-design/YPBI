import { describe, expect, test } from "bun:test";
import type { AnalyticsQuery } from "../../contracts/analytics";
import { validateAnalyticsQuery } from "./capability-validator";
import { dashboardTemplates } from "../../src/data/mockData";
import { analyticsQuerySchema, MAX_METRICS_PER_QUERY } from "../../contracts/analytics";
import { cardConfigSchema } from "../../contracts/card";

const base: AnalyticsQuery = {
  modelId: "business_overview",
  analysisType: "trend",
  metricIds: ["dau"],
  dimensionIds: ["date"],
  eventIds: [],
  platformIds: ["1"],
  platformMode: "single",
  dateRange: ["2026-07-01", "2026-07-15"],
  filters: {},
  limit: 50
};

describe("validateAnalyticsQuery", () => {
  test("接受已注册趋势", () => expect(validateAnalyticsQuery(base).valid).toBeTrue());
  test("拒绝未开放指标", () => expect(validateAnalyticsQuery({ ...base, metricIds: ["pageViews"] }).issues).toContain("指标不存在或未开放：pageViews"));
  test("支付漏斗只接受固定事件", () => {
    const valid = validateAnalyticsQuery({ ...base, modelId: "payment_conversion", analysisType: "funnel", metricIds: [], eventIds: ["vip_click", "pre_pay", "success_pay"] });
    const invalid = validateAnalyticsQuery({ ...base, modelId: "payment_conversion", analysisType: "funnel", metricIds: [], eventIds: ["vip_click", "unknown"] });
    expect(valid.valid).toBeTrue();
    expect(invalid.valid).toBeFalse();
  });
  test("拒绝模型与指标或维度错配", () => {
    expect(validateAnalyticsQuery({ ...base, modelId: "search_demand", metricIds: ["payRate"], dimensionIds: ["date"] }).issues).toEqual(expect.arrayContaining([
      "当前模型不支持指标：payRate",
      "当前模型不支持维度：date"
    ]));
  });
  test("拒绝在非漏斗模型中使用固定漏斗事件", () => {
    expect(validateAnalyticsQuery({ ...base, analysisType: "funnel", metricIds: [], eventIds: ["vip_click", "pre_pay"] }).valid).toBeFalse();
  });
  test("渠道粒度不允许计算跨接口注册转化", () => {
    const result = validateAnalyticsQuery({
      ...base,
      modelId: "acquisition_conversion",
      metricIds: ["downloadRegisterRate"],
      dimensionIds: ["channel"]
    });
    expect(result.valid).toBeFalse();
    expect(result.issues).toContain("下载→注册转化不支持渠道维度，注册数只能关联到平台和日期");
  });
  test("所有系统模板卡片都能生成后端支持的查询", () => {
    const issues = dashboardTemplates.flatMap((template) => template.cards.flatMap((card) => {
      const funnel = card.type === "funnel" || card.type === "sankey";
      const analysisType = funnel ? "funnel"
        : card.type === "kpi" ? "metric"
          : ["bar", "scatter", "treemap", "waterfall"].includes(card.type) ? "ranking"
            : card.type === "table" ? "table"
              : card.type === "cohort" ? "retention" : "trend";
      const result = validateAnalyticsQuery({
        ...base,
        modelId: card.model,
        analysisType,
        metricIds: funnel ? [] : card.metrics,
        dimensionIds: card.dimensions,
        eventIds: card.funnelSteps ?? []
      });
      return result.issues.map((issue) => `${template.name}/${card.title}: ${issue}`);
    }));
    expect(issues).toEqual([]);
  });
  test("查询和卡片协议统一支持最多16个指标", () => {
    const metricIds = Array.from({ length: MAX_METRICS_PER_QUERY }, (_, index) => `metric-${index}`);
    const query = { ...base, metricIds };
    const card = {
      schemaVersion: 1,
      name: "综合指标卡",
      modelId: "business_overview",
      analysisType: "metric",
      metricIds,
      dimensionIds: ["platform"],
      chartType: "kpi",
      sourceApiIds: ["/api/admin/statistics/pDaySum"]
    };
    expect(analyticsQuerySchema.safeParse(query).success).toBeTrue();
    expect(cardConfigSchema.safeParse(card).success).toBeTrue();
    expect(analyticsQuerySchema.safeParse({ ...query, metricIds: [...metricIds, "overflow"] }).success).toBeFalse();
    expect(cardConfigSchema.safeParse({ ...card, metricIds: [...metricIds, "overflow"] }).success).toBeFalse();
  });
});
