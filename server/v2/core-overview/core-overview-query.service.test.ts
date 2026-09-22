import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  coreOverviewQuerySchema,
  coreOverviewQuerySuccessSchema,
  type CoreOverviewMetricId
} from "../../../contracts/core-overview.ts";
import type { MetricDefinitionItem } from "../../../contracts/bi-v2.ts";
import {
  CoreOverviewQueryService,
  type CoreOverviewMetricProvider
} from "./core-overview-query.service.ts";
import { CoreOverviewPeriodResolutionError } from "./core-overview-period.ts";

const snapshot = JSON.parse(readFileSync(
  new URL("../generated/metric-definitions.json", import.meta.url),
  "utf8"
)) as { items: MetricDefinitionItem[] };

function admittedM016() {
  const source = snapshot.items.find((item) => item.id === "M016");
  if (!source) throw new Error("测试快照缺少 M016");
  const metric = structuredClone(source);
  metric.ypbiMapping.status = "configured";
  metric.ypbiMapping.authorityVersion = metric.authority.version;
  metric.validation = {
    status: "passed",
    mappingVersion: metric.ypbiMapping.mappingVersion,
    authorityVersion: metric.authority.version,
    validatedAt: "2026-09-08T00:05:00+08:00",
    evidenceId: "server/v2/validation/evidence/M016/test.evidence.json"
  };
  metric.analysis = { status: "available", reasonCodes: [] };
  return metric;
}

test("标准执行器在当前九项均未准入时不推断日期并明确拒绝", async () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    metricIds: ["M016"]
  });
  const resolveCurrent = (metricId: CoreOverviewMetricId) => snapshot.items.find((item) => item.id === metricId);
  await assert.rejects(
    () => new CoreOverviewQueryService(resolveCurrent).execute(query, { signal: new AbortController().signal }),
    (error: unknown) => error instanceof CoreOverviewPeriodResolutionError
      && error.code === "NO_TRUSTED_WATERMARK"
  );
});

test("只有当前映射已验数且 provider 返回可信水位时才生成正式响应", async () => {
  const definition = admittedM016();
  const watermark = {
    type: "complete_through_business_date" as const,
    completeThrough: "2026-09-07",
    timeZone: "Asia/Shanghai" as const,
    scope: { kind: "pid" as const, pid: "PH" },
    evidence: [{
      sourceId: "/api/test/metric-completion/M016",
      sourceKind: "upstream_completion_api" as const,
      observedAt: "2026-09-08T00:00:00+08:00"
    }]
  };
  const provider: CoreOverviewMetricProvider = {
    resolveWatermark: async () => watermark,
    query: async () => ({
      status: "no_records",
      message: "范围内没有记录",
      retryable: false,
      provenance: {
        authorityVersion: definition.authority.version,
        mappingVersion: definition.ypbiMapping.mappingVersion!,
        validationStatus: "passed",
        sourceIds: ["/api/test/metric-completion/M016"],
        fetchedAt: "2026-09-08T00:05:00+08:00",
        watermark
      }
    })
  };
  const providers = new Map<CoreOverviewMetricId, CoreOverviewMetricProvider>([["M016", provider]]);
  const service = new CoreOverviewQueryService(
    (metricId) => metricId === "M016" ? definition : undefined,
    providers,
    () => new Date("2026-09-08T00:10:00+08:00")
  );
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: { mode: "explicit", currentRange: ["2026-09-01", "2026-09-07"], comparisonRange: null },
    metricIds: ["M016"]
  });
  const result = await service.execute(query, { signal: new AbortController().signal });

  assert.equal(coreOverviewQuerySuccessSchema.safeParse(result).success, true);
  assert.equal(result.data.period.commonCompleteThrough, "2026-09-07");
  assert.equal(result.data.scopeResults[0].cards[0].result.status, "no_records");
  assert.equal(result.meta.partial, true);
});
