import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CORE_OVERVIEW_METRIC_IDS,
  coreOverviewQuerySchema,
  type CoreOverviewMetricId
} from "../../../contracts/core-overview.ts";
import {
  v2MetricDefinitionsDataSchema,
  type MetricDefinitionItem
} from "../../../contracts/bi-v2.ts";
import {
  CoreOverviewAdmissionConfigurationError,
  decideCoreOverviewMetricAdmission,
  planCoreOverviewAdmissions,
  type CoreOverviewMetricDefinitionResolver
} from "./core-overview-admission.ts";

const generatedDefinitions = v2MetricDefinitionsDataSchema.parse(JSON.parse(readFileSync(
  new URL("../generated/metric-definitions.json", import.meta.url),
  "utf8"
)));

function resolverFor(definitions: readonly MetricDefinitionItem[]): CoreOverviewMetricDefinitionResolver {
  return (metricId) => definitions.find((definition) => definition.id === metricId);
}

const generatedResolver = resolverFor(generatedDefinitions.items);

function admittedM016(overrides?: (metric: MetricDefinitionItem) => void) {
  const source = generatedDefinitions.items.find((metric) => metric.id === "M016");
  if (!source) throw new Error("测试快照缺少 M016");
  const metric = structuredClone(source);
  metric.ypbiMapping.status = "configured";
  metric.ypbiMapping.authorityVersion = metric.authority.version;
  metric.validation = {
    status: "passed",
    mappingVersion: metric.ypbiMapping.mappingVersion,
    authorityVersion: metric.authority.version,
    validatedAt: "2026-09-09T00:00:00+08:00",
    evidenceId: "server/v2/validation/evidence/M016.evidence.json"
  };
  metric.analysis = { status: "available", reasonCodes: [] };
  overrides?.(metric);
  return metric;
}

test("当前生成快照的九项首屏指标全部直接沿用权威不可用状态", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "official_overall" },
    metricIds: [...CORE_OVERVIEW_METRIC_IDS]
  });
  const plan = planCoreOverviewAdmissions(query, generatedResolver);

  assert.equal(plan.length, CORE_OVERVIEW_METRIC_IDS.length);
  assert.deepEqual(plan.map((item) => item.metricId), [...CORE_OVERVIEW_METRIC_IDS]);
  assert.ok(plan.every((item) => item.decision.status === "not_ready"));
  const m016Decision = plan.find((item) => item.metricId === "M016")?.decision;
  assert.equal(m016Decision?.status === "not_ready" ? m016Decision.reasonCode : null, "mapping_stale");
  assert.ok(plan.filter((item) => item.metricId !== "M016").every(
    (item) => item.decision.status === "not_ready"
      && item.decision.reasonCode === "mapping_not_configured"
  ));
  assert.ok(plan.every((item) => item.decision.status === "admitted" || item.decision.retryable === false));
});

test("只有权威 analysis 可用且声明日粒度与 PID 能力时才通过目录准入", () => {
  const metric = admittedM016();
  const decision = decideCoreOverviewMetricAdmission(
    "M016",
    { kind: "pids", pids: ["PH", "TT"] },
    resolverFor([metric])
  );
  assert.equal(decision.status, "admitted");
  if (decision.status === "admitted") assert.equal(decision.definition, metric);
});

test("已准入指标仍按当前映射能力区分不支持的查询范围", () => {
  const metric = admittedM016();
  const decision = decideCoreOverviewMetricAdmission(
    "M016",
    { kind: "official_overall" },
    resolverFor([metric])
  );
  assert.deepEqual(decision, {
    status: "unsupported",
    reasonCode: "official_overall_scope_unsupported",
    message: "日活跃用户数当前不支持正式大盘整体结果",
    retryable: false
  });

  const withoutDailyGrain = admittedM016((definition) => {
    definition.ypbiMapping.capabilities.grains = [];
  });
  const withoutDailyGrainDecision = decideCoreOverviewMetricAdmission(
    "M016",
    { kind: "pids", pids: ["PH"] },
    resolverFor([withoutDailyGrain])
  );
  assert.equal(
    withoutDailyGrainDecision.status === "unsupported" ? withoutDailyGrainDecision.reasonCode : null,
    "daily_grain_unsupported"
  );

  const withoutPidScope = admittedM016((definition) => {
    definition.ypbiMapping.capabilities.platformModes = ["official_overall"];
  });
  const withoutPidScopeDecision = decideCoreOverviewMetricAdmission(
    "M016",
    { kind: "pids", pids: ["PH"] },
    resolverFor([withoutPidScope])
  );
  assert.equal(
    withoutPidScopeDecision.status === "unsupported" ? withoutPidScopeDecision.reasonCode : null,
    "pid_scope_unsupported"
  );
});

test("不可用原因不在核心总览重新推导", () => {
  const source = generatedDefinitions.items.find((metric) => metric.id === "M016");
  if (!source) throw new Error("测试快照缺少 M016");
  const metric = structuredClone(source);
  metric.ypbiMapping.status = "disabled";
  metric.analysis = { status: "unavailable", reasonCodes: ["mapping_disabled"] };

  const decision = decideCoreOverviewMetricAdmission(
    "M016",
    { kind: "pids", pids: ["PH"] },
    resolverFor([metric])
  );
  assert.equal(decision.status, "not_ready");
  assert.equal(decision.reasonCode, "mapping_disabled");
});

test("固定首屏指标缺失或解析错位属于配置错误，不伪装为普通未准入", () => {
  assert.throws(
    () => decideCoreOverviewMetricAdmission("M016", { kind: "pids", pids: ["PH"] }, () => undefined),
    (error: unknown) => error instanceof CoreOverviewAdmissionConfigurationError
      && error.code === "METRIC_DEFINITION_MISSING"
  );

  const wrongDefinition = generatedDefinitions.items.find((metric) => metric.id === "M008");
  if (!wrongDefinition) throw new Error("测试快照缺少 M008");
  assert.throws(
    () => decideCoreOverviewMetricAdmission(
      "M016",
      { kind: "pids", pids: ["PH"] },
      () => wrongDefinition
    ),
    (error: unknown) => error instanceof CoreOverviewAdmissionConfigurationError
      && error.code === "METRIC_DEFINITION_ID_MISMATCH"
  );
});

test("不一致的 analysis 状态失败关闭", () => {
  const invalidUnavailable = admittedM016((definition) => {
    definition.analysis = { status: "unavailable", reasonCodes: [] };
  });
  assert.throws(
    () => decideCoreOverviewMetricAdmission(
      "M016",
      { kind: "pids", pids: ["PH"] },
      resolverFor([invalidUnavailable])
    ),
    (error: unknown) => error instanceof CoreOverviewAdmissionConfigurationError
      && error.code === "METRIC_ANALYSIS_STATE_INVALID"
  );

  const invalidAvailable = admittedM016((definition) => {
    definition.analysis = { status: "available", reasonCodes: ["validation_not_passed"] };
  });
  assert.throws(
    () => decideCoreOverviewMetricAdmission(
      "M016",
      { kind: "pids", pids: ["PH"] },
      resolverFor([invalidAvailable])
    ),
    (error: unknown) => error instanceof CoreOverviewAdmissionConfigurationError
      && error.code === "METRIC_ANALYSIS_STATE_INVALID"
  );
});

// Compile-time guard: a resolver can only be queried with the fixed core metric IDs.
const _coreMetricId: CoreOverviewMetricId = "M016";
void _coreMetricId;
