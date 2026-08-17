import { describe, expect, test } from "bun:test";
import type { DashboardCardConfig } from "../types";
import {
  DEFAULT_FILTERS,
  executeCardQuery,
  getMetricAggregate,
  resolveComparisonDateRange,
  resolveDashboardDateRange,
  type DashboardFilters
} from "./mockEngine";

const compareFilters: DashboardFilters = {
  ...DEFAULT_FILTERS,
  mode: "compare",
  platforms: ["Pornhub", "TikTok"]
};

describe("配置驱动 Mock 查询引擎", () => {
  test("自定义日期按开始和结束自然日透传", () => {
    expect(resolveDashboardDateRange({ ...DEFAULT_FILTERS, dateRange: "自定义", customStart: "2026-07-03", customEnd: "2026-07-12" })).toEqual(["2026-07-03", "2026-07-12"]);
  });

  test("未指定对比周期时自动生成等长前置周期", () => {
    expect(resolveComparisonDateRange({ ...DEFAULT_FILTERS, dateRange: "自定义", customStart: "2026-07-08", customEnd: "2026-07-14" })).toEqual(["2026-07-01", "2026-07-07"]);
  });

  test("自然月允许31天与上一个30天自然月对比", () => {
    expect(resolveComparisonDateRange({ ...DEFAULT_FILTERS, dateRange: "自定义", customStart: "2026-07-01", customEnd: "2026-07-31", comparisonMode: "calendarMonth" })).toEqual(["2026-06-01", "2026-06-30"]);
  });

  test("等长周期为7月31天生成紧邻的31天", () => {
    expect(resolveComparisonDateRange({ ...DEFAULT_FILTERS, dateRange: "自定义", customStart: "2026-07-01", customEnd: "2026-07-31", comparisonMode: "equalLength" })).toEqual(["2026-05-31", "2026-06-30"]);
  });

  test("同期进度按上月1日至相同日序生成", () => {
    expect(resolveComparisonDateRange({ ...DEFAULT_FILTERS, dateRange: "自定义", customStart: "2026-07-01", customEnd: "2026-07-20", comparisonMode: "sameProgress" })).toEqual(["2026-06-01", "2026-06-20"]);
  });

  test("比例指标按分子分母加权，而不是简单平均平台百分比", () => {
    const weighted = getMetricAggregate("payRate", compareFilters);
    const pornhub = getMetricAggregate("payRate", { ...compareFilters, mode: "single", platforms: ["Pornhub"] });
    const tiktok = getMetricAggregate("payRate", { ...compareFilters, mode: "single", platforms: ["TikTok"] });

    expect(weighted.value).toBeGreaterThan(Math.min(pornhub.value, tiktok.value));
    expect(weighted.value).toBeLessThan(Math.max(pornhub.value, tiktok.value));
    expect(weighted.formatted).toEndWith("%");
  });

  test("切换平台后趋势数据发生变化", () => {
    const card: DashboardCardConfig = {
      id: "trend-test",
      title: "平台趋势",
      type: "line",
      model: "business_overview",
      metrics: ["dau", "revenue"],
      dimensions: ["date"],
      size: "lg"
    };
    const pornhub = executeCardQuery(card, { ...DEFAULT_FILTERS, mode: "single", platforms: ["Pornhub"] });
    const tiktok = executeCardQuery(card, { ...DEFAULT_FILTERS, mode: "single", platforms: ["TikTok"] });

    expect(pornhub.series[0].data).not.toEqual(tiktok.series[0].data);
    expect(pornhub.categories.length).toBe(7);
  });

  test("漏斗步骤由卡片配置决定，并且人数单调递减", () => {
    const card: DashboardCardConfig = {
      id: "funnel-test",
      title: "内容消费漏斗",
      type: "funnel",
      model: "content_position",
      metrics: ["videoCtr", "playRate", "completeRate", "payRate"],
      dimensions: ["platform"],
      size: "full",
      funnelSteps: ["active_user", "video_click", "video_play", "video_play_end"]
    };
    const result = executeCardQuery(card, compareFilters);

    expect(result.funnel?.map((step) => step.eventId)).toEqual(card.funnelSteps);
    expect(result.funnel?.every((step, index, rows) => index === 0 || step.value <= rows[index - 1].value)).toBe(true);
    expect(result.funnel?.at(-1)?.conversion).toBeGreaterThan(0);
    expect(result.funnel?.at(-1)?.conversion).toBeLessThan(50);
  });

  test("视频统计表只返回现有内容接口支持的粒度字段", () => {
    const card: DashboardCardConfig = {
      id: "table-test",
      title: "内容位置明细",
      type: "table",
      model: "content_position",
      metrics: ["playRate", "completeRate", "revenue"],
      dimensions: ["category", "content"],
      size: "full"
    };
    const result = executeCardQuery(card, { ...DEFAULT_FILTERS, mode: "single", platforms: ["Pornhub"] });

    expect(result.table.length).toBeGreaterThan(0);
    expect(result.table[0]).toHaveProperty("视频");
    expect(result.table[0]).toHaveProperty("分类");
    expect(result.table[0]).toHaveProperty("观看次数");
    expect(result.table[0]).not.toHaveProperty("页面");
    expect(result.table[0]).not.toHaveProperty("位置");
  });
});
