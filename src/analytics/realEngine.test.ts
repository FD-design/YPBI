import { describe, expect, test } from "bun:test";
import type { DashboardCardConfig } from "../types";
import { buildAnalyticsRequest, buildDrillInsights, parseAnalyticsResponse, transformRealResult } from "./realEngine";
import type { DashboardFilters } from "./mockEngine";

const filters: DashboardFilters = { mode: "all", platforms: ["Pornhub"], dateRange: "近7日" };
const compareFilters: DashboardFilters = { mode: "compare", platforms: ["Pornhub", "TikTok"], dateRange: "近7日" };
const response = (rows: Array<Record<string, string | number | null>>, summary: Record<string, number | null> = {}) => ({
  data: { rows, summary },
  meta: { fetchedAt: "2026-07-21T00:00:00.000Z", partial: false, failedPlatforms: [], warnings: [] }
});

describe("transformRealResult", () => {
  test("接口空响应转换为稳定的中文错误", async () => {
    await expect(parseAnalyticsResponse(new Response("", { status: 502 }))).rejects.toThrow("数据服务暂时不可用，请稍后重试");
  });

  test("查询请求保留内容和关键词等真实维度", () => {
    const contentCard: DashboardCardConfig = { id: "content-tree", title: "内容贡献", type: "treemap", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["category", "content"], size: "lg" };
    expect(buildAnalyticsRequest(contentCard, filters)).toMatchObject({ analysisType: "ranking", dimensionIds: ["category", "content"] });
    const sankeyCard: DashboardCardConfig = { ...contentCard, id: "flow", type: "sankey", funnelSteps: ["active_user", "video_play"] };
    expect(buildAnalyticsRequest(sankeyCard, filters)).toMatchObject({ analysisType: "funnel", metricIds: [], eventIds: ["active_user", "video_play"] });
  });
  test("趋势日期按时间正序展示", () => {
    const card: DashboardCardConfig = { id: "trend", title: "趋势", type: "line", model: "business_overview", metrics: ["dau"], dimensions: ["date"], size: "lg" };
    const result = transformRealResult(card, response([
      { date: "2026-07-21", dau: 120 },
      { date: "2026-07-20", dau: 100 }
    ]), filters);
    expect(result.categories).toEqual(["2026-07-20", "2026-07-21"]);
    expect(result.series[0].data).toEqual([100, 120]);
  });
  test("24小时曲线使用时分作为横轴并保留平台分线", () => {
    const card: DashboardCardConfig = { id: "realtime", title: "24小时登录用户曲线", type: "line", model: "usage_depth", metrics: ["dau"], dimensions: ["date", "platform"], size: "md" };
    const result = transformRealResult(card, response([
      { date: "2026-07-27 00:05", platform: "Pornhub", dau: 12 },
      { date: "2026-07-27 00:00", platform: "Pornhub", dau: 10 }
    ]), { ...filters, mode: "single", platforms: ["Pornhub"] });
    expect(result.categories).toEqual(["00:00", "00:05"]);
    expect(result.series[0].data).toEqual([10, 12]);
  });

  test("散点图由平台行生成规模、效率和气泡大小", () => {
    const card: DashboardCardConfig = { id: "scatter", title: "规模效率", type: "scatter", model: "platform_compare", metrics: ["dau", "payRate"], dimensions: ["platform"], size: "md" };
    const result = transformRealResult(card, response([
      { platform: "Pornhub", dau: 100, payRate: 0.03 },
      { platform: "TikTok", dau: 200, payRate: 0.02 }
    ]), compareFilters);
    expect(result.scatter).toEqual([
      { name: "Pornhub", value: [100, 3, 100], extra: "日均DAU 100 · 付费率 3%" },
      { name: "TikTok", value: [200, 2, 200], extra: "日均DAU 200 · 付费率 2%" }
    ]);
  });

  test("排行按首个指标降序", () => {
    const card: DashboardCardConfig = { id: "rank", title: "排行", type: "bar", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "md" };
    const result = transformRealResult(card, response([
      { platform: "A", dau: 100 },
      { platform: "B", dau: 300 },
      { platform: "C", dau: 200 }
    ]), { ...compareFilters, platforms: ["A", "B", "C"] });
    expect(result.categories).toEqual(["B", "C", "A"]);
    expect(result.series[0].data).toEqual([300, 200, 100]);
  });

  test("搜索模型按平台维度聚合时使用 platform 而不是 keyword", () => {
    const card: DashboardCardConfig = { id: "search-platform", title: "平台搜索", type: "bar", model: "search_demand", metrics: ["searchCount"], dimensions: ["platform"], size: "md" };
    const result = transformRealResult(card, response([{ platform: "Pornhub", keyword: "剧情", searchCount: 30 }, { platform: "Pornhub", keyword: "短剧", searchCount: 20 }, { platform: "TikTok", keyword: "剧情", searchCount: 10 }]), compareFilters);
    expect(result.categories).toEqual(["Pornhub", "TikTok"]);
    expect(result.series[0].data).toEqual([50, 10]);
  });

  test("独立事件量倒挂时不展示伪漏斗转化率", () => {
    const card: DashboardCardConfig = { id: "payment-funnel", title: "支付漏斗", type: "funnel", model: "payment_conversion", metrics: ["payRate"], dimensions: ["platform"], size: "full" };
    const result = transformRealResult(card, response([{ eventId: "vip_click", name: "会员入口点击", value: 100, conversion: 1, stepConversion: 1, dropoff: 0 }, { eventId: "pre_pay", name: "发起支付", value: 120, conversion: 1.2, stepConversion: 1.2, dropoff: -20 }]), filters);
    expect(result.table[1].步骤转化率).toBe("—");
    expect(result.insights[0]).toContain("不满足漏斗单调关系");
  });

  test("热力图按日期和平台生成真实二维矩阵", () => {
    const card: DashboardCardConfig = { id: "heatmap", title: "平台日期热力图", type: "heatmap", model: "platform_compare", metrics: ["dau"], dimensions: ["date", "platform"], size: "full" };
    const result = transformRealResult(card, response([
      { date: "2026-07-20", platform: "Pornhub", dau: 100 },
      { date: "2026-07-20", platform: "TikTok", dau: 80 },
      { date: "2026-07-21", platform: "Pornhub", dau: 120 }
    ]), compareFilters);
    expect(result.heatmapX).toEqual(["2026-07-20", "2026-07-21"]);
    expect(result.heatmapY).toEqual(["Pornhub", "TikTok"]);
    expect(result.heatmap).toEqual([[0, 0, 100], [1, 0, 120], [0, 1, 80], [1, 1, 0]]);
  });

  test("瀑布图按平台汇总首个指标贡献", () => {
    const card: DashboardCardConfig = { id: "waterfall", title: "平台贡献", type: "waterfall", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "lg" };
    const result = transformRealResult(card, response([
      { platform: "Pornhub", dau: 100 },
      { platform: "Pornhub", dau: 50 },
      { platform: "TikTok", dau: 80 }
    ]), compareFilters);
    expect(result.waterfall).toEqual([{ name: "Pornhub", value: 150 }, { name: "TikTok", value: 80 }]);
  });

  test("全部平台模式补齐未返回平台并按零展示", () => {
    const card: DashboardCardConfig = { id: "all-platforms", title: "全部平台", type: "bar", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "full" };
    const source = response([{ platform: "Pornhub", dau: 100, payRate: 0.03 }], { dau: 100 });
    const result = transformRealResult(card, source, filters);
    expect(result.categories).toHaveLength(20);
    expect(result.categories).toContain("91淫妻");
    expect(result.series[0].data[result.categories.indexOf("91淫妻")]).toBe(0);
    expect(result.insights.join(" ")).toContain("19 个平台暂无记录");
    expect(result.insights.join(" ")).toContain("不代表真实业务值为 0");
    const scatter = transformRealResult({ ...card, type: "scatter", metrics: ["dau", "payRate"] }, source, filters);
    const heatmap = transformRealResult({ ...card, type: "heatmap", dimensions: ["date", "platform"] }, response([{ date: "2026-07-21", platform: "Pornhub", dau: 100 }]), filters);
    const trend = transformRealResult({ ...card, type: "line", dimensions: ["date", "platform"] }, response([{ date: "2026-07-21", platform: "Pornhub", dau: 100 }]), filters);
    const cohort = transformRealResult({ ...card, type: "cohort", model: "retention_quality", metrics: ["retentionD1"], dimensions: ["date", "platform"] }, response([{ date: "2026-07-21", platform: "Pornhub", newUsers: 100, retainedUsers: 30, retentionD1: 0.3 }], { retentionD1: 0.3 }), filters);
    const waterfall = transformRealResult({ ...card, type: "waterfall" }, source, filters);
    const treemap = transformRealResult({ ...card, type: "treemap" }, source, filters);
    expect(scatter.scatter).toHaveLength(20);
    expect(heatmap.heatmapY).toHaveLength(20);
    expect(trend.series).toHaveLength(20);
    expect(cohort.cohortY).toHaveLength(20);
    expect(waterfall.waterfall).toHaveLength(20);
    expect(treemap.treemap).toHaveLength(20);
  });

  test("普通图表不把接口技术告警展示为业务变化", () => {
    const card: DashboardCardConfig = { id: "rank", title: "平台排行", type: "bar", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "full" };
    const result = transformRealResult(card, {
      ...response([{ platform: "Pornhub", dau: 300 }, { platform: "TikTok", dau: 100 }]),
      meta: { fetchedAt: "2026-07-21T00:00:00.000Z", partial: false, failedPlatforms: [], warnings: ["收入未使用 diamondChargeAmt 代替总收入"] }
    }, compareFilters);
    expect(result.insights[0]).toContain("Pornhub");
    expect(result.insights.join(" ")).not.toContain("diamondChargeAmt");
  });

  test("贡献矩形图按分类和内容聚合真实指标", () => {
    const card: DashboardCardConfig = { id: "treemap", title: "内容贡献", type: "treemap", model: "content_position", metrics: ["videoWatchCount"], dimensions: ["category", "content"], size: "lg" };
    const result = transformRealResult(card, response([
      { category: "剧情", content: "视频A", videoWatchCount: 100 },
      { category: "剧情", content: "视频B", videoWatchCount: 80 },
      { category: "短片", content: "视频C", videoWatchCount: 50 }
    ]), filters);
    expect(result.treemap).toEqual([
      { name: "剧情", value: 180, children: [{ name: "视频A", value: 100 }, { name: "视频B", value: 80 }] },
      { name: "短片", value: 50, children: [{ name: "视频C", value: 50 }] }
    ]);
  });

  test("汇总桑基图由相邻漏斗步骤构造且声明不是用户路径", () => {
    const card: DashboardCardConfig = { id: "sankey", title: "支付汇总流量", type: "sankey", model: "payment_conversion", metrics: ["payRate"], dimensions: ["platform"], size: "full", funnelSteps: ["vip_click", "pre_pay", "success_pay"] };
    const result = transformRealResult(card, response([
      { eventId: "vip_click", name: "VIP点击", value: 100 },
      { eventId: "pre_pay", name: "拉起支付", value: 60 },
      { eventId: "success_pay", name: "支付成功", value: 30 }
    ], {}), filters);
    expect(result.sankey).toEqual({
      nodes: [{ name: "VIP点击" }, { name: "拉起支付" }, { name: "支付成功" }],
      links: [{ source: "VIP点击", target: "拉起支付", value: 60 }, { source: "拉起支付", target: "支付成功", value: 30 }]
    });
    expect(result.insights.join(" ")).toContain("非用户级路径");
  });

  test("诊断卡输出真实平台差异而不是技术警告", () => {
    const card: DashboardCardConfig = { id: "diagnosis", title: "诊断", type: "diagnosis", model: "business_overview", metrics: ["dau", "payRate", "viewRate"], dimensions: ["platform"], size: "full" };
    const result = transformRealResult(card, response([
      { platform: "Pornhub", dau: 300, payRate: 0.01, viewRate: 0.9 },
      { platform: "TikTok", dau: 100, payRate: 0.03, viewRate: 0.7 }
    ], { dau: 400, payRate: 0.015, viewRate: 0.85 }), filters);
    expect(result.insights).toHaveLength(3);
    expect(result.insights[0]).toContain("Pornhub");
    expect(result.insights[1]).toContain("TikTok");
    expect(result.insights.join(" ")).not.toContain("diamondChargeAmt");
  });

  test("诊断卡忽略接口未返回的指标，避免把缺失值判断为最低", () => {
    const card: DashboardCardConfig = { id: "diagnosis", title: "诊断", type: "diagnosis", model: "business_overview", metrics: ["dau", "payRate", "viewRate"], dimensions: ["platform"], size: "full" };
    const result = transformRealResult(card, response([
      { platform: "Pornhub", dau: 300, payRate: 0.01, viewRate: 0.9 },
      { platform: "TikTok", dau: 100, payRate: null, viewRate: null }
    ]), filters);
    expect(result.insights[0]).toContain("Pornhub");
    expect(result.insights[1]).toContain("Pornhub");
    expect(result.insights[2]).toContain("Pornhub");
    expect(result.insights.join(" ")).not.toContain("TikTok 观影率最低");
  });

  test("下钻将节点值转换成真实比较结论，不展示接口技术警告", () => {
    const card: DashboardCardConfig = { id: "rank", title: "平台排行", type: "bar", model: "platform_compare", metrics: ["dau"], dimensions: ["platform"], size: "md" };
    const result = transformRealResult(card, {
      ...response([
        { platform: "Pornhub", dau: 300 },
        { platform: "TikTok", dau: 100 }
      ]),
      meta: { fetchedAt: "2026-07-21T00:00:00.000Z", partial: false, failedPlatforms: [], warnings: ["接口技术警告"] }
    }, filters);
    const insights = buildDrillInsights(card, result, "Pornhub");
    expect(insights[0]).toBe("Pornhub 当前日均DAU为 300。");
    expect(insights[1]).toBe("高于当前图表节点均值 50.0%。");
    expect(insights.join(" ")).not.toContain("接口技术警告");
  });
});
