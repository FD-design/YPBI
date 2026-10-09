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
    expect(v2MetricDefinitions.snapshot.counts).toEqual({ standard: 97, periodDerived: 3, total: 100 });
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

  test("需平台加工与未配置映射不会被包装成可分析", () => {
    const unsupported = v2MetricDefinitions.items.find((item) => item.id === "M106");
    expect(unsupported).toMatchObject({
      authority: { sourceBuildStatus: { code: "platform_processing_required", label: "需平台加工" } },
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

  test("旧兼容目录的普通说明采用业务定义并解析同义引用，准入元数据不变", () => {
    const current = structuredClone(v2MetricDefinitions.items.find(item => item.id === "M016")!);
    current.ypbiMapping.status = "configured";
    current.ypbiMapping.mappingVersion = "m016-pday-sum-v1";
    current.ypbiMapping.authorityVersion = current.authority.version;
    current.authority.definition = "现有技术实现的历史描述。";
    current.authority.recommendedDefinition = "业务日内至少成功登录一次的去重用户数。";
    const before = structuredClone(current);
    const projected = projectLegacyV2MetricCatalog([current]);
    expect(projected).toHaveLength(1);
    expect(projected[0].definition).toBe(current.authority.recommendedDefinition);
    expect(current).toEqual(before);
    for (const recommendedDefinition of [null, "", "与现有定义一致"]) {
      const fallback = projectLegacyV2MetricCatalog([{ ...current, authority: { ...current.authority, recommendedDefinition } }]);
      expect(fallback[0]).toEqual({ ...projected[0], definition: current.authority.definition });
    }
  });
});
