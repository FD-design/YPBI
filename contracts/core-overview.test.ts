import assert from "node:assert/strict";
import test from "node:test";
import { CORE_OVERVIEW_CARD_SPECS, CORE_OVERVIEW_METRIC_IDS, coreOverviewQuerySchema, coreOverviewQuerySuccessSchema, coreOverviewResponseMatchesQuery } from "./core-overview.ts";
import type { CoreOverviewMetricId, CoreOverviewQuery, CoreOverviewQuerySuccess } from "./core-overview";

const CURRENT_RANGE = ["2026-09-01", "2026-09-07"] as const;
const COMPARISON_RANGE = ["2026-08-25", "2026-08-31"] as const;
const CURRENT_DATES = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"];
const COMPARISON_DATES = ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"];

function unavailableCard(metricId: CoreOverviewMetricId) {
  const spec = CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === metricId)!;
  return {
    ...spec,
    result: {
      status: "not_ready" as const,
      reasonCode: "validation_not_passed",
      message: "当前映射或验数尚未完成",
      retryable: false
    }
  };
}

function provenance(
  scope: CoreOverviewQuerySuccess["data"]["scopeResults"][number]["scope"],
  completeThrough = "2026-09-07"
) {
  return {
    authorityVersion: "v-test",
    mappingVersion: "mapping-test",
    validationStatus: "passed" as const,
    sourceIds: ["service:core-overview-contract-test"],
    fetchedAt: "2026-09-09T00:05:00+08:00",
    watermark: {
      type: "complete_through_business_date" as const,
      completeThrough,
      timeZone: "Asia/Shanghai" as const,
      scope,
      evidence: [{
        sourceId: "service:core-overview-contract-test",
        sourceKind: "upstream_completion_api" as const,
        observedAt: new Date(`${completeThrough}T16:01:00Z`).toISOString()
      }]
    }
  };
}

function trustedNoRecordsCard(
  metricId: CoreOverviewMetricId,
  scope: CoreOverviewQuerySuccess["data"]["scopeResults"][number]["scope"],
  completeThrough = "2026-09-07"
) {
  const spec = CORE_OVERVIEW_CARD_SPECS.find((candidate) => candidate.metricId === metricId)!;
  return {
    ...spec,
    result: {
      status: "no_records" as const,
      message: "可信水位内没有业务记录",
      retryable: false,
      provenance: provenance(scope, completeThrough)
    }
  };
}

function allNotReadyResponse(query: CoreOverviewQuery): CoreOverviewQuerySuccess {
  const requestedScope = query.scope.kind === "official_overall"
    ? query.scope
    : { kind: "pids" as const, pids: [...query.scope.pids] };
  const scopes = requestedScope.kind === "official_overall"
    ? [{ kind: "official_overall" as const }]
    : requestedScope.pids.map((pid) => ({ kind: "pid" as const, pid }));
  return {
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope,
      requestedMetricIds: [...query.metricIds],
      period: {
        mode: "latest_complete",
        grain: "day",
        timeZone: "Asia/Shanghai",
        currentRange: [...CURRENT_RANGE],
        comparisonRange: [...COMPARISON_RANGE],
        commonCompleteThrough: "2026-09-07"
      },
      scopeResults: scopes.map((scope) => ({
        scope,
        cards: query.metricIds.map(unavailableCard)
      }))
    },
    meta: {
      queryId: "core-query-test",
      fetchedAt: "2026-09-09T00:05:00+08:00",
      partial: true,
      warnings: ["当前仅验证严格契约，不返回未准入业务值"]
    }
  };
}

function trustedPartialResponse(query: CoreOverviewQuery): CoreOverviewQuerySuccess {
  const response = allNotReadyResponse(query);
  response.data.scopeResults.forEach((scopeResult) => {
    scopeResult.cards[0] = trustedNoRecordsCard(
      response.data.requestedMetricIds[0],
      scopeResult.scope
    );
  });
  response.meta.warnings = ["测试响应由可信无记录卡片提供共同水位"];
  return response;
}

function availableZeroResponse(): CoreOverviewQuerySuccess {
  const parsed = coreOverviewQuerySchema.parse({
    scope: { kind: "official_overall" },
    metricIds: ["M016"]
  });
  const response = trustedPartialResponse(parsed);
  response.data.scopeResults[0].cards[0] = {
    ...CORE_OVERVIEW_CARD_SPECS[0],
    result: {
      status: "available",
      completeness: "complete",
      current: {
        actualRange: [...CURRENT_RANGE],
        includedBusinessDates: [...CURRENT_DATES],
        value: { raw: 0, unit: "人", currencyCode: null }
      },
      comparison: {
        status: "available",
        kind: "relative_change",
        actualRange: [...COMPARISON_RANGE],
        includedBusinessDates: [...COMPARISON_DATES],
        baselineValue: { raw: 100, unit: "人", currencyCode: null },
        absoluteDifference: -100,
        changeValue: -1,
        direction: "down"
      },
      trend: {
        current: CURRENT_DATES.map((businessDate, index) => ({
          offset: index,
          state: "available" as const,
          businessDate,
          value: 0
        })),
        comparison: COMPARISON_DATES.map((businessDate, index) => ({
          offset: index,
          state: "available" as const,
          businessDate,
          value: 100
        }))
      },
      provenance: {
        authorityVersion: "v0.23-draft",
        mappingVersion: "m016-test-passed",
        validationStatus: "passed",
        sourceIds: ["/api/admin/statistics/pDaySum"],
        fetchedAt: "2026-09-08T00:05:00+08:00",
        watermark: {
          type: "complete_through_business_date",
          completeThrough: "2026-09-07",
          timeZone: "Asia/Shanghai",
          scope: { kind: "official_overall" },
          evidence: [{
            sourceId: "/api/admin/statistics/pDaySum",
            sourceKind: "upstream_explicit",
            observedAt: "2026-09-08T00:01:00+08:00"
          }]
        }
      }
    }
  };
  response.meta.partial = false;
  response.meta.warnings = [];
  return response;
}

test("核心经营总览请求只接受固定 9 项并将子集归一为固定顺序", () => {
  const parsed = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["TT", "PH"] },
    metricIds: ["M020", "M016", "M058"]
  });
  assert.deepEqual(parsed.metricIds, ["M016", "M058", "M020"]);
  assert.equal(parsed.period.mode, "latest_complete");
  assert.deepEqual(parsed.scope, { kind: "pids", pids: ["TT", "PH"] });

  for (const invalid of [
    { scope: { kind: "pids", pids: ["PH", "PH"] } },
    { scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M016", "M016"] },
    { scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M999"] },
    { scope: { kind: "official_overall" }, filters: { channel: "x" } },
    { scope: { kind: "official_overall" }, period: { mode: "explicit", currentRange: ["2026-09-02", "2026-09-01"], comparisonRange: null } }
  ]) {
    assert.equal(coreOverviewQuerySchema.safeParse(invalid).success, false);
  }
});

test("多 PID 必须逐 PID 返回全部所选卡片，不能压成一份合计", () => {
  const query = coreOverviewQuerySchema.parse({ scope: { kind: "pids", pids: ["PH", "TT"] } });
  const response = trustedPartialResponse(query);
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(response).success, true);
  assert.equal(coreOverviewResponseMatchesQuery(response, query), true);

  const collapsed = structuredClone(response);
  collapsed.data.scopeResults.splice(1, 1);
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(collapsed).success, false);
});

test("成功响应至少需要一张可信水位卡片，且共同水位严格取全部卡片最小值", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "official_overall" },
    metricIds: ["M016", "M008"]
  });
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(allNotReadyResponse(query)).success, false);

  const response = trustedPartialResponse(query);
  response.data.scopeResults[0].cards[1] = trustedNoRecordsCard(
    "M008",
    { kind: "official_overall" },
    "2026-09-08"
  );
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(response).success, true);

  response.data.period.commonCompleteThrough = "2026-09-08";
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(response).success, false);
});

test("真实 0 是可用结果，且仍需合法周期、对比、来源与可信水位", () => {
  const response = availableZeroResponse();
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(response).success, true);

  const negative = structuredClone(response);
  const result = negative.data.scopeResults[0].cards[0].result;
  if (result.status === "available") result.current.value.raw = -1;
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(negative).success, false);

  const badDifference = structuredClone(response);
  const badResult = badDifference.data.scopeResults[0].cards[0].result;
  if (badResult.status === "available" && badResult.comparison?.status === "available") {
    badResult.comparison.absoluteDifference = 0;
  }
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(badDifference).success, false);

  const missingEvidence = structuredClone(response);
  const evidenceResult = missingEvidence.data.scopeResults[0].cards[0].result;
  if ("provenance" in evidenceResult) evidenceResult.provenance.sourceIds = ["/api/admin/statistics/other"];
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(missingEvidence).success, false);
});

test("当前期与非等长自定义对比使用两条独立完整时间序列", () => {
  const response = availableZeroResponse();
  response.data.period = {
    mode: "explicit",
    grain: "day",
    timeZone: "Asia/Shanghai",
    currentRange: ["2026-09-06", "2026-09-07"],
    comparisonRange: ["2026-08-01", "2026-08-03"],
    commonCompleteThrough: "2026-09-07"
  };
  const result = response.data.scopeResults[0].cards[0].result;
  if (result.status !== "available" || result.comparison?.status !== "available") throw new Error("fixture must be available");
  result.current.actualRange = ["2026-09-06", "2026-09-07"];
  result.current.includedBusinessDates = ["2026-09-06", "2026-09-07"];
  result.trend.current = ["2026-09-06", "2026-09-07"].map((businessDate, offset) => ({
    offset,
    state: "available" as const,
    businessDate,
    value: 0
  }));
  result.comparison.actualRange = ["2026-08-01", "2026-08-03"];
  result.comparison.includedBusinessDates = ["2026-08-01", "2026-08-02", "2026-08-03"];
  result.trend.comparison = ["2026-08-01", "2026-08-02", "2026-08-03"].map((businessDate, offset) => ({
    offset,
    state: "available" as const,
    businessDate,
    value: 100
  }));
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(response).success, true);

  const outOfRange = structuredClone(response);
  const outOfRangeResult = outOfRange.data.scopeResults[0].cards[0].result;
  if (outOfRangeResult.status !== "available") throw new Error("fixture must be available");
  outOfRangeResult.trend.current[0].businessDate = "2026-09-05";
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(outOfRange).success, false);
});

test("默认最近 7 个共同完整业务日必须回显上一等长周期", () => {
  const query = coreOverviewQuerySchema.parse({ scope: { kind: "official_overall" }, metricIds: [...CORE_OVERVIEW_METRIC_IDS] });
  const response = trustedPartialResponse(query);
  assert.equal(coreOverviewResponseMatchesQuery(response, query), true);

  response.data.period.comparisonRange = ["2026-08-24", "2026-08-30"];
  assert.equal(coreOverviewResponseMatchesQuery(response, query), false);
});
