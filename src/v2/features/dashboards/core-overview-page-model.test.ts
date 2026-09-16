import assert from "node:assert/strict";
import test from "node:test";
import {
  CORE_OVERVIEW_CARD_SPECS,
  CORE_OVERVIEW_METRIC_IDS,
  coreOverviewQuerySuccessSchema,
  type CoreOverviewCard,
  type CoreOverviewMetricId,
  type CoreOverviewQuerySuccess
} from "../../../../contracts/core-overview.ts";
import {
  CoreOverviewPageModelError,
  CoreOverviewRequestCoordinator,
  beginCoreOverviewCardRetry,
  beginCoreOverviewQuery,
  canRetryCoreOverviewCard,
  coreOverviewCardRetryRequest,
  coreOverviewScopePageModels,
  rejectCoreOverviewCardRetry,
  rejectCoreOverviewQuery,
  resolveCoreOverviewCardRetry,
  resolveCoreOverviewQuery,
  type CoreOverviewMetricDefinitions
} from "./core-overview-page-model.ts";

const CURRENT_RANGE = ["2026-09-06", "2026-09-07"] as const;
const COMPARISON_RANGE = ["2026-08-01", "2026-08-03"] as const;
const CURRENT_DATES = ["2026-09-06", "2026-09-07"];
const COMPARISON_DATES = ["2026-08-01", "2026-08-02", "2026-08-03"];
const SCOPE = { kind: "official_overall" as const };

const DEFINITIONS: CoreOverviewMetricDefinitions = Object.fromEntries(CORE_OVERVIEW_METRIC_IDS.map((id) => [id, {
  id,
  name: {
    M016: "日活跃用户数",
    M008: "新增用户数",
    M026: "观影用户数",
    M102: "观影总时长",
    M059: "付费用户数",
    M058: "总充值金额",
    M081: "观影率",
    M036: "有效观影率",
    M020: "注册用户 D1 留存率"
  }[id],
  definition: `${id} 的指标中心权威定义`
}])) as CoreOverviewMetricDefinitions;

function provenance() {
  return {
    authorityVersion: "v-test",
    mappingVersion: "mapping-test",
    validationStatus: "passed" as const,
    sourceIds: ["service:core-overview-test"],
    fetchedAt: "2026-09-08T00:05:00+08:00",
    watermark: {
      type: "complete_through_business_date" as const,
      completeThrough: "2026-09-07",
      timeZone: "Asia/Shanghai" as const,
      scope: SCOPE,
      evidence: [{
        sourceId: "service:core-overview-test",
        sourceKind: "upstream_explicit" as const,
        observedAt: "2026-09-08T00:01:00+08:00"
      }]
    }
  };
}

function spec(metricId: CoreOverviewMetricId) {
  return CORE_OVERVIEW_CARD_SPECS.find((item) => item.metricId === metricId)!;
}

function unavailableCard(metricId: CoreOverviewMetricId, status: "not_ready" | "unsupported" | "failed"): CoreOverviewCard {
  return {
    ...spec(metricId),
    result: status === "failed"
      ? { status, errorCode: "UPSTREAM_FAILED", message: "当前卡片查询失败", retryable: true }
      : { status, reasonCode: status === "not_ready" ? "validation_not_passed" : "scope_not_supported", message: "当前能力尚未正式开放", retryable: false }
  };
}

function dataUnavailableCard(metricId: CoreOverviewMetricId, status: "no_records" | "no_values" | "not_produced" | "immature"): CoreOverviewCard {
  return {
    ...spec(metricId),
    result: { status, message: `数据状态：${status}`, retryable: status !== "immature", provenance: provenance() }
  };
}

function availableCard(metricId: "M016" | "M036" | "M081", options?: { partial?: boolean; value?: number }): CoreOverviewCard {
  const cardSpec = spec(metricId);
  const ratio = cardSpec.valueKind === "ratio";
  const currentValue = options?.value ?? (ratio ? 0.5 : 0);
  const baselineValue = ratio ? 0.4 : 100;
  const difference = currentValue - baselineValue;
  return {
    ...cardSpec,
    result: {
      status: "available",
      completeness: options?.partial ? "partial" : "complete",
      current: {
        actualRange: options?.partial ? [CURRENT_RANGE[0], CURRENT_RANGE[0]] : [...CURRENT_RANGE],
        includedBusinessDates: options?.partial ? [CURRENT_DATES[0]] : [...CURRENT_DATES],
        value: { raw: currentValue, unit: ratio ? "比例" : "人", currencyCode: null }
      },
      comparison: {
        status: "available",
        kind: ratio ? "percentage_point" : "relative_change",
        actualRange: [...COMPARISON_RANGE],
        includedBusinessDates: [...COMPARISON_DATES],
        baselineValue: { raw: baselineValue, unit: ratio ? "比例" : "人", currencyCode: null },
        absoluteDifference: difference,
        changeValue: ratio ? difference * 100 : difference / baselineValue,
        direction: difference > 0 ? "up" : difference < 0 ? "down" : "flat"
      },
      trend: {
        current: CURRENT_DATES.map((businessDate, offset) => options?.partial && offset === 1
          ? { offset, state: "no_value" as const, businessDate }
          : { offset, state: "available" as const, businessDate, value: currentValue }),
        comparison: COMPARISON_DATES.map((businessDate, offset) => ({ offset, state: "available" as const, businessDate, value: baselineValue }))
      },
      provenance: provenance()
    }
  };
}

function response(cards?: CoreOverviewCard[], metricIds: CoreOverviewMetricId[] = [...CORE_OVERVIEW_METRIC_IDS]): CoreOverviewQuerySuccess {
  const values = cards ?? [
    availableCard("M016"),
    dataUnavailableCard("M008", "no_records"),
    dataUnavailableCard("M026", "no_values"),
    dataUnavailableCard("M102", "not_produced"),
    dataUnavailableCard("M059", "immature"),
    unavailableCard("M058", "unsupported"),
    unavailableCard("M081", "failed"),
    availableCard("M036", { partial: true }),
    unavailableCard("M020", "not_ready")
  ];
  return coreOverviewQuerySuccessSchema.parse({
    success: true,
    data: {
      dashboard: { id: "core-overview", contractVersion: "core-overview/v1" },
      requestedScope: SCOPE,
      requestedMetricIds: metricIds,
      period: {
        mode: "explicit",
        grain: "day",
        timeZone: "Asia/Shanghai",
        currentRange: [...CURRENT_RANGE],
        comparisonRange: [...COMPARISON_RANGE],
        commonCompleteThrough: "2026-09-07"
      },
      scopeResults: [{ scope: SCOPE, cards: values }]
    },
    meta: {
      queryId: `query-${metricIds.join("-")}`,
      fetchedAt: "2026-09-08T00:05:00+08:00",
      partial: values.some((card) => card.result.status !== "available" || (card.result.status === "available" && card.result.completeness === "partial")),
      warnings: []
    }
  });
}

const FAILURE = { kind: "error" as const, code: "NETWORK_ERROR", message: "网络暂时不可用" };

function loadedState(payload: CoreOverviewQuerySuccess = response(), requestKey = "query-key", requestId = "initial-request") {
  const loading = beginCoreOverviewQuery(null, requestKey, requestId);
  return resolveCoreOverviewQuery(loading, requestKey, requestId, payload);
}

test("严格合同响应映射为固定顺序卡片，并保留真实 0 与两条非等长趋势", () => {
  const payload = response();
  const parsedPayload = coreOverviewQuerySuccessSchema.safeParse(payload);
  assert.equal(parsedPayload.success, true, parsedPayload.success ? undefined : JSON.stringify(parsedPayload.error.issues));
  const state = loadedState(payload);
  const cards = coreOverviewScopePageModels(state, DEFINITIONS)[0].cards;

  assert.deepEqual(cards.map((card) => card.metric.id), CORE_OVERVIEW_METRIC_IDS);
  assert.equal(cards[0].result.status, "available");
  if (cards[0].result.status !== "available") throw new Error("fixture must be available");
  assert.equal(cards[0].result.value.raw, 0);
  assert.equal(cards[0].result.value.display, "0");
  assert.equal(cards[0].result.trend.current.length, 2);
  assert.equal(cards[0].result.trend.comparison?.length, 3);
  assert.equal(cards[0].result.trend.comparison?.[2].actualDate, "2026-08-03");
  assert.equal(cards[0].result.trend.current.every((point) => point.counterpart === null && point.differenceDisplay === null), true);
  assert.equal(cards[0].result.trend.comparison?.every((point) => point.counterpart === null && point.differenceDisplay === null), true);
  assert.equal(cards[7].result.status, "available");
  if (cards[7].result.status === "available") {
    assert.equal(cards[7].result.value.display, "50.0");
    assert.equal(cards[7].result.trend.current[1].actualDate, "2026-09-07");
    assert.equal(cards[7].result.trend.current[1].state, "no_value");
    assert.equal(cards[7].result.trend.current[1].value, null);
  }
});

test("数据与准入状态逐项保留，不把无记录、无值或未成熟补成 0", () => {
  const state = loadedState();
  const cards = coreOverviewScopePageModels(state, DEFINITIONS)[0].cards;
  assert.deepEqual(cards.map((card) => card.result.status), [
    "available", "no_records", "no_values", "not_produced", "immature", "unsupported", "failed", "available", "not_ready"
  ]);
  assert.equal(cards[1].result.status === "no_records" ? cards[1].result.watermarkLabel : null, "数据完整至 2026-09-07");
  assert.equal(cards[6].result.status === "failed" ? cards[6].result.retryable : null, true);
  assert.equal(cards[8].result.status === "not_ready" ? cards[8].result.retryable : null, false);
});

test("基准为零的不可计算变化率保持中性，绝对差仍在详情保留", () => {
  const card = availableCard("M016", { value: 20 });
  if (card.result.status !== "available" || card.result.comparison?.status !== "available") throw new Error("available fixture required");
  card.result.comparison.baselineValue.raw = 0;
  card.result.comparison.absoluteDifference = 20;
  card.result.comparison.changeValue = null;
  card.result.comparison.direction = "up";
  const model = coreOverviewScopePageModels(loadedState(response([card], ["M016"])), DEFINITIONS)[0].cards[0];
  if (model.result.status !== "available" || model.result.comparison?.status !== "available") throw new Error("available model required");
  assert.equal(model.result.comparison.direction, null);
  assert.equal(model.result.comparison.display, "基准值为 0，无法计算变化率");
  assert.match(model.result.comparison.detail, /相差 \+20 人/);
});

test("缺少指标中心权威定义时失败关闭", () => {
  const state = loadedState();
  const { M016: _missing, ...withoutM016 } = DEFINITIONS;
  assert.throws(
    () => coreOverviewScopePageModels(state, withoutM016),
    (error: unknown) => error instanceof CoreOverviewPageModelError && error.code === "CORE_OVERVIEW_METRIC_DEFINITION_MISSING"
  );
});

test("整板刷新失败保留上次成功值，权限失败则不继续显示旧结果", () => {
  const initial = loadedState();
  const refreshing = beginCoreOverviewQuery(initial, "query-key", "refresh-1");
  const refreshingCard = coreOverviewScopePageModels(refreshing, DEFINITIONS)[0].cards[0];
  const failedCard = coreOverviewScopePageModels(refreshing, DEFINITIONS)[0].cards[6];
  assert.equal(refreshingCard.result.status === "available" ? refreshingCard.result.refresh.status : null, "refreshing");
  assert.equal(failedCard.result.status === "failed" ? failedCard.result.retryable : null, false);
  assert.equal(canRetryCoreOverviewCard(refreshing, { scope: SCOPE, metricId: "M081" }), false);
  assert.throws(
    () => beginCoreOverviewCardRetry(refreshing, { scope: SCOPE, metricId: "M081" }, "card-during-full-refresh"),
    (error: unknown) => error instanceof CoreOverviewPageModelError && error.code === "CORE_OVERVIEW_FULL_REFRESH_ACTIVE"
  );

  const stale = rejectCoreOverviewQuery(refreshing, "query-key", "refresh-1", FAILURE);
  const staleCard = coreOverviewScopePageModels(stale, DEFINITIONS)[0].cards[0];
  assert.equal(stale.status, "success");
  assert.equal(staleCard.result.status === "available" ? staleCard.result.refresh.status : null, "failed");
  assert.equal(staleCard.result.status === "available" && staleCard.result.refresh.status === "failed" ? staleCard.result.refresh.source : null, "page");
  assert.equal(staleCard.result.status === "available" ? staleCard.result.value.raw : null, 0);

  const checkingAccess = beginCoreOverviewQuery(stale, "query-key", "refresh-2");
  const forbidden = rejectCoreOverviewQuery(checkingAccess, "query-key", "refresh-2", { kind: "forbidden", code: "PID_ACCESS_DENIED", message: "无权查看" });
  assert.equal(forbidden.status, "failure");
});

test("同条件连续刷新时旧请求的成功或失败都不能覆盖新请求", () => {
  const initial = loadedState();
  const first = beginCoreOverviewQuery(initial, "query-key", "refresh-old");
  const second = beginCoreOverviewQuery(first, "query-key", "refresh-new");
  assert.equal(resolveCoreOverviewQuery(second, "query-key", "refresh-old", response()), second);
  assert.equal(rejectCoreOverviewQuery(second, "query-key", "refresh-old", FAILURE), second);

  const completed = resolveCoreOverviewQuery(second, "query-key", "refresh-new", response());
  assert.equal(completed.status, "success");
  if (completed.status === "success") assert.equal(completed.activeRequestId, null);
});

test("单卡子集重试只改变目标卡，且固定使用原查询实际周期", () => {
  const initial = loadedState();
  const locator = { scope: SCOPE, metricId: "M081" as const };
  const retrying = beginCoreOverviewCardRetry(initial, locator, "card-retry-1");
  const retryingCards = coreOverviewScopePageModels(retrying, DEFINITIONS)[0].cards;
  assert.equal(retryingCards[0].result.status, "available");
  assert.equal(retryingCards[6].result.status, "loading");
  assert.deepEqual(coreOverviewCardRetryRequest(retrying, locator, "card-retry-1"), {
    scope: SCOPE,
    period: { mode: "explicit", currentRange: [...CURRENT_RANGE], comparisonRange: [...COMPARISON_RANGE] },
    metricIds: ["M081"]
  });

  const retryFailed = rejectCoreOverviewCardRetry(retrying, locator, "card-retry-1", FAILURE);
  const failedCards = coreOverviewScopePageModels(retryFailed, DEFINITIONS)[0].cards;
  assert.equal(failedCards[6].result.status, "failed");
  assert.equal(failedCards[6].result.status === "failed" ? failedCards[6].result.retryable : null, true);
  assert.equal(failedCards[0].result.status, "available");

  const retryResponse = response([availableCard("M081", { value: 0.6 })], ["M081"]);
  assert.equal(coreOverviewQuerySuccessSchema.safeParse(retryResponse).success, true);
  const resolved = resolveCoreOverviewCardRetry(retrying, locator, "card-retry-1", retryResponse);
  const resolvedCards = coreOverviewScopePageModels(resolved, DEFINITIONS)[0].cards;
  assert.equal(resolvedCards[6].result.status, "available");
  if (resolvedCards[6].result.status === "available") assert.equal(resolvedCards[6].result.value.display, "60.0");
  assert.equal(resolvedCards[0].result.status, "available");
});

test("同一卡片连续重试时旧响应不能覆盖新尝试", () => {
  const locator = { scope: SCOPE, metricId: "M081" as const };
  const first = beginCoreOverviewCardRetry(loadedState(), locator, "retry-old");
  const second = beginCoreOverviewCardRetry(first, locator, "retry-new");
  const retryResponse = response([availableCard("M081", { value: 0.6 })], ["M081"]);
  assert.equal(resolveCoreOverviewCardRetry(second, locator, "retry-old", retryResponse), second);
  assert.equal(rejectCoreOverviewCardRetry(second, locator, "retry-old", FAILURE), second);
  assert.throws(
    () => coreOverviewCardRetryRequest(second, locator, "retry-old"),
    (error: unknown) => error instanceof CoreOverviewPageModelError && error.code === "CORE_OVERVIEW_CARD_RETRY_NOT_ACTIVE"
  );
  const resolved = resolveCoreOverviewCardRetry(second, locator, "retry-new", retryResponse);
  assert.notEqual(resolved, second);
});

test("已有值的单卡刷新失败保留旧值，并保留单卡重试来源与原因", () => {
  const locator = { scope: SCOPE, metricId: "M016" as const };
  const retrying = beginCoreOverviewCardRetry(loadedState(), locator, "m016-retry");
  const failed = rejectCoreOverviewCardRetry(retrying, locator, "m016-retry", FAILURE);
  const card = coreOverviewScopePageModels(failed, DEFINITIONS)[0].cards[0];
  assert.equal(card.result.status, "available");
  if (card.result.status !== "available" || card.result.refresh.status !== "failed") throw new Error("fixture must be stale available");
  assert.equal(card.result.refresh.source, "card");
  assert.equal(card.result.refresh.retryable, true);
  assert.equal(card.result.refresh.message, FAILURE.message);
  assert.equal(card.result.value.raw, 0);
});

test("查询协调器取消旧整板请求、同卡旧请求及页面离开后的所有请求", () => {
  const coordinator = new CoreOverviewRequestCoordinator();
  const firstFull = coordinator.beginFullRequest();
  const secondFull = coordinator.beginFullRequest();
  assert.equal(firstFull.aborted, true);
  assert.equal(secondFull.aborted, false);
  coordinator.completeFullRequest(firstFull);

  const locator = { scope: SCOPE, metricId: "M016" as const };
  const firstCard = coordinator.beginCardRequest(locator);
  const secondCard = coordinator.beginCardRequest(locator);
  assert.equal(firstCard.aborted, true);
  assert.equal(secondCard.aborted, false);
  coordinator.completeCardRequest(locator, firstCard);
  coordinator.cancelAll();
  assert.equal(secondFull.aborted, true);
  assert.equal(secondCard.aborted, true);
});
