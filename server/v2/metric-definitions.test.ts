import { describe, expect, test } from "bun:test";
import {
  deriveMetricAnalysisState,
  v2MetricDefinitionsDataSchema,
  v2MetricDefinitionsSuccessSchema
} from "../../contracts/bi-v2";
import {
  v2MetricDefinitions,
  v2MetricDefinitionsResponse,
  verifyMetricDefinitionsContentHash
} from "./metric-definitions";
import { projectLegacyV2MetricCatalog } from "./catalog";

describe("V2 metric definitions catalog", () => {
  test("发布快照通过严格契约与内容校验", () => {
    expect(() => v2MetricDefinitionsDataSchema.parse(v2MetricDefinitions)).not.toThrow();
    expect(() => v2MetricDefinitionsSuccessSchema.parse(v2MetricDefinitionsResponse)).not.toThrow();
    expect(verifyMetricDefinitionsContentHash(v2MetricDefinitions)).toBe(true);
    expect(v2MetricDefinitions.snapshot.counts).toEqual({ standard: 98, periodDerived: 3, total: 101 });
  });

  test("analysis 只由映射和验数状态派生", () => {
    const metric = v2MetricDefinitions.items.find((item) => item.id === "M016");
    expect(metric).toBeDefined();
    if (!metric) return;
    expect(deriveMetricAnalysisState({
      authorityVersion: metric.authority.version,
      ypbiMapping: metric.ypbiMapping,
      validation: metric.validation
    })).toEqual(metric.analysis);

    const forged = structuredClone(v2MetricDefinitions);
    const forgedMetric = forged.items.find((item) => item.id === "M016");
    if (!forgedMetric) throw new Error("M016 missing from test snapshot");
    forgedMetric.analysis = { status: "available", reasonCodes: [] };
    expect(v2MetricDefinitionsDataSchema.safeParse(forged).success).toBe(false);
  });

  test("待补能力与未配置映射不会被包装成可分析", () => {
    const unsupported = v2MetricDefinitions.items.find((item) => item.id === "M106");
    expect(unsupported).toMatchObject({
      authority: { sourceBuildStatus: { code: "capability_missing", label: "待补能力" } },
      ypbiMapping: { status: "not_configured" },
      validation: { status: "not_started" },
      analysis: { status: "unavailable", reasonCodes: ["mapping_not_configured"] }
    });
  });

  test("M016 映射未配置、停用或过期时旧兼容目录为空但服务可启动", () => {
    const current = v2MetricDefinitions.items.find((item) => item.id === "M016");
    expect(current).toBeDefined();
    if (!current) return;

    const notConfigured = structuredClone(current);
    notConfigured.ypbiMapping = {
      status: "not_configured",
      mappingVersion: null,
      authorityVersion: null,
      sourceApiIds: [],
      capabilities: { grains: [], platformModes: [], dimensions: [], filters: [], comparisons: [] }
    };
    notConfigured.analysis = { status: "unavailable", reasonCodes: ["mapping_not_configured"] };

    const disabled = structuredClone(current);
    disabled.ypbiMapping.status = "disabled";
    disabled.analysis = { status: "unavailable", reasonCodes: ["mapping_disabled"] };

    const stale = structuredClone(current);
    stale.ypbiMapping.status = "stale";
    stale.analysis = { status: "unavailable", reasonCodes: ["mapping_stale"] };

    expect(projectLegacyV2MetricCatalog([notConfigured])).toEqual([]);
    expect(projectLegacyV2MetricCatalog([disabled])).toEqual([]);
    expect(projectLegacyV2MetricCatalog([stale])).toEqual([]);
  });
});
