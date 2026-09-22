import assert from "node:assert/strict";
import test from "node:test";
import {
  coreOverviewQuerySchema,
  type CoreOverviewCard
} from "../../../contracts/core-overview.ts";
import {
  CoreOverviewPeriodResolutionError,
  commonCoreOverviewCompleteThrough,
  resolveCoreOverviewPeriodFromTrustedWatermarks,
  trustedWatermarkFromCoreOverviewResult,
  type CoreOverviewTrustedWatermark
} from "./core-overview-period.ts";

function watermark(
  completeThrough: string,
  scope: CoreOverviewTrustedWatermark["scope"] = { kind: "pid", pid: "PH" }
): CoreOverviewTrustedWatermark {
  return {
    type: "complete_through_business_date",
    completeThrough,
    timeZone: "Asia/Shanghai",
    scope,
    evidence: [{
      sourceId: "/api/test/metric-completion/M016",
      sourceKind: "upstream_completion_api",
      observedAt: `${completeThrough}T23:59:59+08:00`
    }]
  };
}

test("零可信水位明确失败，绝不从当前时间或请求结束日猜测", () => {
  assert.throws(
    () => commonCoreOverviewCompleteThrough([]),
    (error: unknown) => error instanceof CoreOverviewPeriodResolutionError
      && error.code === "NO_TRUSTED_WATERMARK"
  );

  const query = coreOverviewQuerySchema.parse({ scope: { kind: "pids", pids: ["PH"] } });
  assert.throws(
    () => resolveCoreOverviewPeriodFromTrustedWatermarks(query.period, []),
    (error: unknown) => error instanceof CoreOverviewPeriodResolutionError
      && error.code === "NO_TRUSTED_WATERMARK"
  );
});

test("共同完整日取全部已验证指标与范围水位的最小值", () => {
  const watermarks = [
    watermark("2026-09-08", { kind: "pid", pid: "PH" }),
    watermark("2026-09-06", { kind: "pid", pid: "TT" }),
    watermark("2026-09-07", { kind: "official_overall" })
  ];
  assert.equal(commonCoreOverviewCompleteThrough(watermarks), "2026-09-06");
});

test("无记录等数据状态仍保留可信水位，未准入状态才没有 provenance", () => {
  const trusted = watermark("2026-09-06");
  const noRecords = {
    status: "no_records",
    message: "范围内没有记录",
    retryable: false,
    provenance: {
      authorityVersion: "v0.23-draft",
      mappingVersion: "m016-test-passed",
      validationStatus: "passed",
      sourceIds: ["/api/test/metric-completion/M016"],
      fetchedAt: "2026-09-07T00:05:00+08:00",
      watermark: trusted
    }
  } satisfies CoreOverviewCard["result"];
  const notReady = {
    status: "not_ready",
    reasonCode: "validation_not_passed",
    message: "尚未验数",
    retryable: false
  } satisfies CoreOverviewCard["result"];

  assert.equal(trustedWatermarkFromCoreOverviewResult(noRecords), trusted);
  assert.equal(trustedWatermarkFromCoreOverviewResult(notReady), null);
  assert.equal(commonCoreOverviewCompleteThrough([
    trustedWatermarkFromCoreOverviewResult(noRecords)!
  ]), "2026-09-06");
});

test("latest_complete 从共同水位解析最近七天与上一等长周期", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: { mode: "latest_complete", days: 7, comparison: "previous_equal" }
  });
  assert.deepEqual(resolveCoreOverviewPeriodFromTrustedWatermarks(
    query.period,
    [watermark("2026-09-07")]
  ), {
    mode: "latest_complete",
    grain: "day",
    timeZone: "Asia/Shanghai",
    currentRange: ["2026-09-01", "2026-09-07"],
    comparisonRange: ["2026-08-25", "2026-08-31"],
    commonCompleteThrough: "2026-09-07"
  });
});

test("latest_complete 可以明确关闭对比且正确跨月", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: { mode: "latest_complete", days: 3, comparison: "none" }
  });
  assert.deepEqual(resolveCoreOverviewPeriodFromTrustedWatermarks(
    query.period,
    [watermark("2026-03-01")]
  ), {
    mode: "latest_complete",
    grain: "day",
    timeZone: "Asia/Shanghai",
    currentRange: ["2026-02-27", "2026-03-01"],
    comparisonRange: null,
    commonCompleteThrough: "2026-03-01"
  });
});

test("explicit 保留非等长双周期并回显真实共同水位", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: {
      mode: "explicit",
      currentRange: ["2026-09-01", "2026-09-03"],
      comparisonRange: ["2026-08-01", "2026-08-07"]
    }
  });
  const resolved = resolveCoreOverviewPeriodFromTrustedWatermarks(
    query.period,
    [watermark("2026-09-06"), watermark("2026-09-05", { kind: "pid", pid: "TT" })]
  );
  assert.deepEqual(resolved, {
    mode: "explicit",
    grain: "day",
    timeZone: "Asia/Shanghai",
    currentRange: ["2026-09-01", "2026-09-03"],
    comparisonRange: ["2026-08-01", "2026-08-07"],
    commonCompleteThrough: "2026-09-05"
  });
});

test("explicit 当前期或对比期越过共同水位时分别失败", () => {
  const currentTooLate = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: {
      mode: "explicit",
      currentRange: ["2026-09-01", "2026-09-06"],
      comparisonRange: null
    }
  });
  assert.throws(
    () => resolveCoreOverviewPeriodFromTrustedWatermarks(
      currentTooLate.period,
      [watermark("2026-09-05")]
    ),
    (error: unknown) => error instanceof CoreOverviewPeriodResolutionError
      && error.code === "CURRENT_RANGE_NOT_COMPLETE"
      && error.details?.requestedEnd === "2026-09-06"
  );

  const comparisonTooLate = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: {
      mode: "explicit",
      currentRange: ["2026-08-01", "2026-08-03"],
      comparisonRange: ["2026-09-01", "2026-09-06"]
    }
  });
  assert.throws(
    () => resolveCoreOverviewPeriodFromTrustedWatermarks(
      comparisonTooLate.period,
      [watermark("2026-09-05")]
    ),
    (error: unknown) => error instanceof CoreOverviewPeriodResolutionError
      && error.code === "COMPARISON_RANGE_NOT_COMPLETE"
      && error.details?.requestedEnd === "2026-09-06"
  );
});

test("解析不会修改调用方的请求和水位对象", () => {
  const query = coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: {
      mode: "explicit",
      currentRange: ["2026-09-01", "2026-09-03"],
      comparisonRange: null
    }
  });
  const watermarks = [watermark("2026-09-05")];
  const beforePeriod = structuredClone(query.period);
  const beforeWatermarks = structuredClone(watermarks);
  resolveCoreOverviewPeriodFromTrustedWatermarks(query.period, watermarks);
  assert.deepEqual(query.period, beforePeriod);
  assert.deepEqual(watermarks, beforeWatermarks);
});
