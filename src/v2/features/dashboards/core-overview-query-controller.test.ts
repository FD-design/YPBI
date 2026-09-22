import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_OVERVIEW_CARD_SPECS,
  coreOverviewQuerySchema,
  coreOverviewQuerySuccessSchema,
  type CoreOverviewQuery,
  type CoreOverviewQuerySuccess
} from "../../../../contracts/core-overview.ts";
import { coreOverviewCardKey } from "./core-overview-page-model.ts";
import {
  CoreOverviewQueryController,
  CoreOverviewQueryControllerError,
  coreOverviewQueryKey,
  coreOverviewRequestFailure,
  type CoreOverviewQueryGateway
} from "./core-overview-query-controller.ts";

const QUERY = coreOverviewQuerySchema.parse({
  scope: { kind: "pids", pids: ["PH"] },
  period: { mode: "explicit", currentRange: ["2026-09-01", "2026-09-03"], comparisonRange: null },
  metricIds: ["M016", "M008"]
});

const OTHER_QUERY = coreOverviewQuerySchema.parse({
  scope: { kind: "pids", pids: ["FBI"] },
  period: { mode: "explicit", currentRange: ["2026-09-02", "2026-09-04"], comparisonRange: null },
  metricIds: ["M016", "M008"]
});

function responseFor(
  query: CoreOverviewQuery,
  queryId: string,
  m016Status: "not_ready" | "failed" | "no_records" = "not_ready"
): CoreOverviewQuerySuccess {
  const currentRange = query.period.mode === "explicit" ? query.period.currentRange : ["2026-09-01", "2026-09-07"] as const;
  const comparisonRange = query.period.mode === "explicit" ? query.period.comparisonRange : query.period.comparison === "none"
    ? null
    : ["2026-08-25", "2026-08-31"] as const;
  const scopes = query.scope.kind === "official_overall"
    ? [{ kind: "official_overall" as const }]
    : query.scope.pids.map((pid) => ({ kind: "pid" as const, pid }));
  return coreOverviewQuerySuccessSchema.parse({
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope: query.scope,
      requestedMetricIds: query.metricIds,
      period: {
        mode: query.period.mode,
        grain: "day",
        timeZone: "Asia/Shanghai",
        currentRange: [currentRange[0], currentRange[1]],
        comparisonRange: comparisonRange ? [comparisonRange[0], comparisonRange[1]] : null,
        commonCompleteThrough: currentRange[1]
      },
      scopeResults: scopes.map((scope) => ({
        scope,
        cards: CORE_OVERVIEW_CARD_SPECS.filter((spec) => query.metricIds.includes(spec.metricId)).map((spec) => {
          if (spec.metricId === "M016" && m016Status !== "no_records") {
            return {
              ...spec,
              result: m016Status === "failed"
                ? { status: "failed" as const, errorCode: "TEST_TEMPORARY_FAILURE", message: `结果 ${queryId}`, retryable: true }
                : { status: "not_ready" as const, reasonCode: "TEST_NOT_READY", message: `结果 ${queryId}`, retryable: false }
            };
          }
          return {
            ...spec,
            result: {
              status: "no_records" as const,
              message: `结果 ${queryId}`,
              retryable: false,
              provenance: {
                authorityVersion: "v-test",
                mappingVersion: "mapping-test",
                validationStatus: "passed" as const,
                sourceIds: ["service:core-overview-controller-test"],
                fetchedAt: "2026-09-09T00:10:00+08:00",
                watermark: {
                  type: "complete_through_business_date" as const,
                  completeThrough: currentRange[1],
                  timeZone: "Asia/Shanghai" as const,
                  scope,
                  evidence: [{
                    sourceId: "service:core-overview-controller-test",
                    sourceKind: "upstream_completion_api" as const,
                    observedAt: new Date(`${currentRange[1]}T16:01:00Z`).toISOString()
                  }]
                }
              }
            }
          };
        })
      }))
    },
    meta: {
      queryId,
      fetchedAt: "2026-09-09T00:10:00+08:00",
      partial: true,
      warnings: []
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("查询键使用严格合同归一默认值和指标顺序", () => {
  const first = coreOverviewQueryKey({ scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M016", "M008"] });
  const second = coreOverviewQueryKey({ scope: { kind: "pids", pids: ["PH"] }, metricIds: ["M008", "M016"] });
  assert.equal(first, second);
  assert.throws(
    () => coreOverviewQueryKey({ scope: { kind: "pids", pids: [] } }),
    (error: unknown) => error instanceof CoreOverviewQueryControllerError && error.code === "INVALID_CORE_OVERVIEW_QUERY"
  );
});

test("同条件连续整板查询只接受最新响应，且确实取消较早请求", async () => {
  const pending: Array<ReturnType<typeof deferred<CoreOverviewQuerySuccess>>> = [];
  const signals: AbortSignal[] = [];
  const gateway: CoreOverviewQueryGateway = (request, signal) => {
    const item = deferred<CoreOverviewQuerySuccess>();
    pending.push(item);
    signals.push(signal);
    return item.promise;
  };
  const controller = new CoreOverviewQueryController(gateway);
  const first = controller.load(QUERY);
  const second = controller.refresh();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);

  pending[1].resolve(responseFor(QUERY, "newest"));
  await second;
  pending[0].resolve(responseFor(QUERY, "stale"));
  await first;

  const state = controller.getState();
  assert.equal(state?.status, "success");
  assert.equal(state?.status === "success" ? state.response.meta.queryId : null, "newest");
});

test("切换查询条件后，旧条件的晚到失败不能污染新结果", async () => {
  const pending: Array<ReturnType<typeof deferred<CoreOverviewQuerySuccess>>> = [];
  const signals: AbortSignal[] = [];
  const gateway: CoreOverviewQueryGateway = (_request, signal) => {
    const item = deferred<CoreOverviewQuerySuccess>();
    pending.push(item);
    signals.push(signal);
    return item.promise;
  };
  const controller = new CoreOverviewQueryController(gateway);
  const previous = controller.load(QUERY);
  const current = controller.load(OTHER_QUERY);
  assert.equal(signals[0].aborted, true);

  pending[1].resolve(responseFor(OTHER_QUERY, "other-query"));
  await current;
  pending[0].reject({
    name: "V2RequestError",
    message: "旧查询稍后失败",
    kind: "error",
    code: "STALE_UPSTREAM_FAILURE",
    status: 502
  });
  await previous;

  const state = controller.getState();
  assert.equal(state?.requestKey, coreOverviewQueryKey(OTHER_QUERY));
  assert.equal(state?.status === "success" ? state.response.meta.queryId : null, "other-query");
});

test("同一卡片连续重试只接受最新尝试", async () => {
  const cardRequests: Array<{ request: CoreOverviewQuery; deferred: ReturnType<typeof deferred<CoreOverviewQuerySuccess>> }> = [];
  let first = true;
  const gateway: CoreOverviewQueryGateway = async (input, signal) => {
    const request = coreOverviewQuerySchema.parse(input);
    if (first) {
      first = false;
      return responseFor(request, "initial", "failed");
    }
    const item = deferred<CoreOverviewQuerySuccess>();
    cardRequests.push({ request, deferred: item });
    signal.addEventListener("abort", () => undefined, { once: true });
    return item.promise;
  };
  const controller = new CoreOverviewQueryController(gateway);
  await controller.load(QUERY);
  const locator = { scope: { kind: "pid" as const, pid: "PH" }, metricId: "M016" as const };
  const stale = controller.retryCard(locator);
  const newest = controller.retryCard(locator);
  cardRequests[1].deferred.resolve(responseFor(cardRequests[1].request, "newest-card", "no_records"));
  await newest;
  cardRequests[0].deferred.resolve(responseFor(cardRequests[0].request, "stale-card", "no_records"));
  await stale;

  const state = controller.getState();
  assert.equal(state?.status, "success");
  const override = state?.status === "success" ? state.cardOverrides[coreOverviewCardKey(locator)] : null;
  assert.equal(override?.result.status === "no_records" ? override.result.message : null, "结果 newest-card");
});

test("单卡失败子查询使用请求失败路径，不把无可信水位的 failed 卡包装成成功响应", async () => {
  let callCount = 0;
  const gateway: CoreOverviewQueryGateway = async (input) => {
    const request = coreOverviewQuerySchema.parse(input);
    callCount += 1;
    if (callCount === 1) return responseFor(request, "initial", "failed");
    throw {
      name: "V2RequestError",
      message: "核心经营总览结果不满足公共契约，查询已停止",
      kind: "error",
      code: "CORE_OVERVIEW_SOURCE_CONFLICT",
      status: 502
    };
  };
  const controller = new CoreOverviewQueryController(gateway);
  const locator = { scope: { kind: "pid" as const, pid: "PH" }, metricId: "M016" as const };
  await controller.load(QUERY);
  await controller.retryCard(locator);

  const state = controller.getState();
  const attempt = state?.status === "success" ? state.cardAttempts[coreOverviewCardKey(locator)] : null;
  assert.equal(attempt?.status, "failed");
  assert.equal(attempt?.status === "failed" ? attempt.failure.code : null, "CORE_OVERVIEW_SOURCE_CONFLICT");
  assert.equal(attempt?.status === "failed" ? attempt.failure.retryable : null, true);
  assert.equal(state?.status === "success" ? state.cardOverrides[coreOverviewCardKey(locator)] : null, undefined);
});

test("失败归一化保留身份语义，并只对可恢复的临时故障开放重试", () => {
  const unavailable = coreOverviewRequestFailure({
    name: "V2RequestError",
    message: "身份服务不可用",
    kind: "identity_unavailable",
    code: "IDENTITY_PROVIDER_UNAVAILABLE",
    status: 503,
    requestId: "req-identity"
  });
  assert.deepEqual(unavailable, {
    kind: "identity_unavailable",
    code: "IDENTITY_PROVIDER_UNAVAILABLE",
    message: "身份服务不可用",
    requestId: "req-identity",
    retryable: true
  });

  assert.equal(coreOverviewRequestFailure({
    name: "V2RequestError",
    message: "需要重新登录",
    kind: "unauthenticated",
    code: "AUTHENTICATION_REQUIRED",
    status: 401
  }).retryable, false);
  assert.equal(coreOverviewRequestFailure({
    name: "V2RequestError",
    message: "无权查看",
    kind: "forbidden",
    code: "PID_ACCESS_DENIED",
    status: 403
  }).retryable, false);

  assert.equal(coreOverviewRequestFailure({
    name: "V2RequestError",
    message: "暂未准入",
    kind: "error",
    code: "METRIC_NOT_READY",
    status: 422
  }).retryable, false);
  assert.equal(coreOverviewRequestFailure({
    name: "V2RequestError",
    message: "上游超时",
    kind: "error",
    code: "V2_UPSTREAM_TIMEOUT",
    status: 504
  }).retryable, true);
  assert.equal(coreOverviewRequestFailure(new TypeError("Failed to fetch")).retryable, true);
  assert.equal(coreOverviewRequestFailure(new DOMException("aborted", "AbortError")).retryable, true);
  assert.equal(coreOverviewRequestFailure(new Error("内部细节不得回显")).message, "核心经营总览暂时无法加载");
});

test("失败加载进入明确状态，只有 signal 确认取消时才忽略 AbortError", async () => {
  let attempt = 0;
  const gateway: CoreOverviewQueryGateway = async () => {
    attempt += 1;
    if (attempt === 1) {
      throw {
        name: "V2RequestError",
        message: "当前指标尚未准入",
        kind: "error",
        code: "METRIC_NOT_READY",
        status: 422
      };
    }
    throw new DOMException("aborted", "AbortError");
  };
  const controller = new CoreOverviewQueryController(gateway);
  await controller.load(QUERY);
  const failed = controller.getState();
  assert.equal(failed?.status, "failure");
  assert.equal(failed?.status === "failure" ? failed.failure.retryable : null, false);

  await controller.refresh();
  const aborted = controller.getState();
  assert.equal(aborted?.status, "failure");
  assert.equal(aborted?.status === "failure" ? aborted.failure.code : null, "REQUEST_ABORTED_UNEXPECTEDLY");
  assert.equal(aborted?.status === "failure" ? aborted.failure.retryable : null, true);
});

test("未准入或其他不可重试卡片不能绕过 UI 发起单卡请求", async () => {
  const gateway: CoreOverviewQueryGateway = async (input) => responseFor(coreOverviewQuerySchema.parse(input), "not-ready");
  const controller = new CoreOverviewQueryController(gateway);
  await controller.load(QUERY);
  await assert.rejects(
    controller.retryCard({ scope: { kind: "pid", pid: "PH" }, metricId: "M016" }),
    (error: unknown) => error instanceof CoreOverviewQueryControllerError && error.code === "CORE_OVERVIEW_CARD_NOT_RETRYABLE"
  );
});

test("整板刷新期间拒绝单卡重试，避免两个更新通道相互覆盖", async () => {
  const pendingRefresh = deferred<CoreOverviewQuerySuccess>();
  let callCount = 0;
  const gateway: CoreOverviewQueryGateway = async (input) => {
    const request = coreOverviewQuerySchema.parse(input);
    callCount += 1;
    if (callCount === 1) return responseFor(request, "initial", "failed");
    return pendingRefresh.promise;
  };
  const controller = new CoreOverviewQueryController(gateway);
  const locator = { scope: { kind: "pid" as const, pid: "PH" }, metricId: "M016" as const };
  await controller.load(QUERY);

  const refreshing = controller.refresh();
  await assert.rejects(
    controller.retryCard(locator),
    (error: unknown) => error instanceof CoreOverviewQueryControllerError && error.code === "CORE_OVERVIEW_CARD_NOT_RETRYABLE"
  );
  assert.equal(callCount, 2);

  pendingRefresh.resolve(responseFor(QUERY, "full-refresh", "failed"));
  await refreshing;
  const state = controller.getState();
  assert.equal(state?.status === "success" ? state.response.meta.queryId : null, "full-refresh");
});

test("整板刷新会取消已经进行中的单卡重试，并以整板结果为准", async () => {
  const card = deferred<CoreOverviewQuerySuccess>();
  const full = deferred<CoreOverviewQuerySuccess>();
  const signals: AbortSignal[] = [];
  let callCount = 0;
  const gateway: CoreOverviewQueryGateway = async (input, signal) => {
    const request = coreOverviewQuerySchema.parse(input);
    signals.push(signal);
    callCount += 1;
    if (callCount === 1) return responseFor(request, "initial", "failed");
    if (callCount === 2) return card.promise;
    return full.promise;
  };
  const controller = new CoreOverviewQueryController(gateway);
  const locator = { scope: { kind: "pid" as const, pid: "PH" }, metricId: "M016" as const };
  await controller.load(QUERY);

  const cardRetry = controller.retryCard(locator);
  const fullRefresh = controller.refresh();
  assert.equal(signals[1].aborted, true);
  const refreshing = controller.getState();
  assert.equal(refreshing?.status === "success" ? refreshing.refresh : null, "refreshing");
  assert.deepEqual(refreshing?.status === "success" ? refreshing.cardAttempts : null, {});

  full.resolve(responseFor(QUERY, "full-wins", "failed"));
  await fullRefresh;
  card.resolve(responseFor(coreOverviewQuerySchema.parse({
    scope: { kind: "pids", pids: ["PH"] },
    period: { mode: "explicit", currentRange: ["2026-09-01", "2026-09-03"], comparisonRange: null },
    metricIds: ["M016"]
  }), "late-card", "no_records"));
  await cardRetry;

  const state = controller.getState();
  assert.equal(state?.status === "success" ? state.response.meta.queryId : null, "full-wins");
  assert.deepEqual(state?.status === "success" ? state.cardOverrides : null, {});
});
