import { describe, expect, test } from "bun:test";
import {
  createMetricWatermarkSourceRegistry,
  metricWatermarkSourceRegistry
} from "./metric-watermark-source-registry";

describe("metric watermark source registry", () => {
  test("生产登记在没有已确认来源时保持为空", () => {
    expect(metricWatermarkSourceRegistry.list()).toEqual([]);
    expect(metricWatermarkSourceRegistry.has({
      metricId: "M016",
      sourceKind: "upstream_explicit",
      sourceApiId: "/api/admin/statistics/pDaySum"
    })).toBe(false);
  });

  test("测试登记同时绑定指标、来源类型和接口", () => {
    const registry = createMetricWatermarkSourceRegistry([{
      metricId: "M016",
      sourceKind: "upstream_completion_api",
      sourceApiId: "/api/test/metric-completion/M016"
    }]);
    expect(registry.list()).toEqual([{
      metricId: "M016",
      sourceKind: "upstream_completion_api",
      sourceApiId: "/api/test/metric-completion/M016"
    }]);
    for (const registration of [
      { metricId: "M016", sourceKind: "upstream_completion_api" as const, sourceApiId: "/api/test/metric-completion/M016" },
      { metricId: "M999", sourceKind: "upstream_completion_api" as const, sourceApiId: "/api/test/metric-completion/M016" },
      { metricId: "M016", sourceKind: "upstream_explicit" as const, sourceApiId: "/api/test/metric-completion/M016" },
      { metricId: "M016", sourceKind: "upstream_completion_api" as const, sourceApiId: "/api/admin/statistics/unregisteredCompletion" },
      { metricId: "M016", sourceKind: "upstream_explicit" as const, sourceApiId: "/api/admin/statistics/pDaySum" }
    ]) {
      expect(registry.has(registration)).toBe(registration.metricId === "M016"
        && registration.sourceKind === "upstream_completion_api"
        && registration.sourceApiId === "/api/test/metric-completion/M016");
    }
  });

  test("拒绝重复三元组，避免同一来源出现多个权威登记", () => {
    const registration = {
      metricId: "M016",
      sourceKind: "upstream_completion_api" as const,
      sourceApiId: "/api/test/metric-completion/M016"
    };
    expect(() => createMetricWatermarkSourceRegistry([registration, registration])).toThrow("可信数据水位来源登记存在重复项");
  });
});
