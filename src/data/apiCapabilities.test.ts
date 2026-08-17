import { describe, expect, test } from "bun:test";
import {
  getApiCapability,
  getSupportedFunnelEvents,
  normalizeCardCapability,
  normalizeDashboardTemplate,
  validateCardCapability
} from "./apiCapabilities";
import type { DashboardCardConfig } from "../types";

describe("API 驱动的受控分析能力", () => {
  test("搜索分析开放排行数据可派生的贡献图，但不开放漏斗", () => {
    const capability = getApiCapability("search_demand");

    expect(capability.apiPaths).toContain("/api/admin/statistics/hotSearchWords/getMany");
    expect(capability.allowedCharts).toEqual(["bar", "treemap", "waterfall", "table"]);
    expect(getSupportedFunnelEvents("search_demand")).toEqual([]);
  });

  test("平台日期数据开放热力图、瀑布图和贡献矩形图", () => {
    const capability = getApiCapability("platform_compare");
    expect(capability.allowedCharts).toEqual(expect.arrayContaining(["heatmap", "waterfall", "treemap"]));
  });

  test("已有事件汇总漏斗同时开放汇总桑基图", () => {
    expect(getApiCapability("content_position").allowedCharts).toContain("sankey");
    expect(getApiCapability("payment_conversion").allowedCharts).toContain("sankey");
  });

  test("内容分析不暴露现有视频接口无法拆分的页面和坑位维度", () => {
    const capability = getApiCapability("content_position");

    expect(capability.allowedDimensions).toContain("content");
    expect(capability.allowedDimensions).toContain("category");
    expect(capability.allowedDimensions).not.toContain("page");
    expect(capability.allowedDimensions).not.toContain("position");
    expect(capability.allowedDimensions).not.toContain("positionRank");
  });

  test("支付漏斗只允许已有埋点汇总字段，并拒绝越界配置", () => {
    expect(getSupportedFunnelEvents("payment_conversion")).toEqual([
      "vip_click",
      "pre_pay",
      "success_pay"
    ]);

    const card: DashboardCardConfig = {
      id: "unsupported-funnel",
      title: "越界支付漏斗",
      type: "funnel",
      model: "payment_conversion",
      metrics: ["payRate"],
      dimensions: ["paymentChannel"],
      size: "lg",
      funnelSteps: ["vip_click", "payment_order_create", "success_pay"]
    };

    const result = validateCardCapability(card);
    expect(result.valid).toBe(false);
    expect(result.issues.join(" ")).toContain("payment_order_create");
    expect(result.issues.join(" ")).toContain("支付通道");
  });

  test("旧搜索漏斗会在读取时归一化为热词排行卡片", () => {
    const normalized = normalizeCardCapability({
      id: "legacy-search",
      title: "旧搜索漏斗",
      type: "funnel",
      model: "search_demand",
      metrics: ["searchNoResultRate", "playRate"],
      dimensions: ["date", "keyword", "paymentChannel"],
      size: "full",
      funnelSteps: ["search_submit", "payment_success"]
    });

    expect(normalized?.type).toBe("bar");
    expect(normalized?.metrics).toEqual(["searchCount"]);
    expect(normalized?.dimensions).toEqual(["keyword"]);
    expect(normalized?.funnelSteps).toEqual([]);
    expect(validateCardCapability(normalized!)).toEqual({ valid: true, issues: [] });
  });

  test("模板归一化会移除未知模型卡片并清理越界筛选器", () => {
    const normalized = normalizeDashboardTemplate({
      id: "legacy-template",
      name: "旧模板",
      scenario: "缓存数据",
      model: "business_overview",
      filters: ["platform", "paymentChannel"],
      cards: [
        {
          id: "valid",
          title: "经营趋势",
          type: "line",
          model: "business_overview",
          metrics: ["dau"],
          dimensions: ["date"],
          size: "lg"
        },
        {
          id: "invalid",
          title: "未知模型",
          type: "line",
          model: "removed_model",
          metrics: ["dau"],
          dimensions: ["date"],
          size: "lg"
        }
      ]
    } as never);

    expect(normalized?.cards).toHaveLength(1);
    expect(normalized?.filters).toEqual(["platform"]);
  });

  test("卡片归一化保留独立多平台范围并限制最多八个平台", () => {
    const normalized = normalizeCardCapability({
      id: "platform-scope", title: "多平台趋势", type: "line", model: "business_overview",
      metrics: ["dau"], dimensions: ["date", "platform"], size: "lg", platformMode: "compare",
      platforms: ["Pornhub", "TikTok", "小红书", "色虎", "PH·Prem", "调教师", "快播", "黄片网盘", "性欲社"]
    });
    expect(normalized?.platformMode).toBe("compare");
    expect(normalized?.platforms).toHaveLength(8);
  });
});
