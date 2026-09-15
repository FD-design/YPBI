import {
  CORE_OVERVIEW_TIME_ZONE,
  type CoreOverviewCard,
  type CoreOverviewQuery,
  type CoreOverviewQuerySuccess
} from "../../../contracts/core-overview.ts";

type CoreOverviewResultWithProvenance = Extract<CoreOverviewCard["result"], { provenance: unknown }>;

/**
 * 已经通过公共契约与来源登记校验的核心总览可信水位。
 * 可用结果及 no_records / no_values / not_produced / immature 都能携带它；
 * 数据为空与数据完整日未知是两个独立事实。
 */
export type CoreOverviewTrustedWatermark = CoreOverviewResultWithProvenance["provenance"]["watermark"];
export type CoreOverviewResolvedPeriod = CoreOverviewQuerySuccess["data"]["period"];

export class CoreOverviewPeriodResolutionError extends Error {
  readonly code:
    | "NO_TRUSTED_WATERMARK"
    | "CURRENT_RANGE_NOT_COMPLETE"
    | "COMPARISON_RANGE_NOT_COMPLETE";
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    code:
      | "NO_TRUSTED_WATERMARK"
      | "CURRENT_RANGE_NOT_COMPLETE"
      | "COMPARISON_RANGE_NOT_COMPLETE",
    message: string,
    details?: Readonly<Record<string, string>>
  ) {
    super(message);
    this.name = "CoreOverviewPeriodResolutionError";
    this.code = code;
    this.details = details;
  }
}

function shiftBusinessDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function trustedWatermarkFromCoreOverviewResult(
  result: CoreOverviewCard["result"]
): CoreOverviewTrustedWatermark | null {
  return "provenance" in result ? result.provenance.watermark : null;
}

export function commonCoreOverviewCompleteThrough(
  trustedWatermarks: readonly CoreOverviewTrustedWatermark[]
) {
  if (trustedWatermarks.length === 0) {
    throw new CoreOverviewPeriodResolutionError(
      "NO_TRUSTED_WATERMARK",
      "所选核心指标尚无可用于解析查询周期的可信数据水位"
    );
  }
  return trustedWatermarks.reduce(
    (earliest, watermark) => watermark.completeThrough < earliest
      ? watermark.completeThrough
      : earliest,
    trustedWatermarks[0].completeThrough
  );
}

/**
 * 从已经通过验证的指标×范围水位中解析整板唯一周期。
 * 调用方必须只传入本次准备返回 provenance 的卡片水位；缺失水位的卡片
 * 应先降为 not_ready。数组为空时本函数必定失败，绝不从当前时间、请求
 * 结束日或最大返回日期推断共同完整日。
 */
export function resolveCoreOverviewPeriodFromTrustedWatermarks(
  requestedPeriod: CoreOverviewQuery["period"],
  trustedWatermarks: readonly CoreOverviewTrustedWatermark[]
): CoreOverviewResolvedPeriod {
  const commonCompleteThrough = commonCoreOverviewCompleteThrough(trustedWatermarks);

  if (requestedPeriod.mode === "latest_complete") {
    const currentRange: [string, string] = [
      shiftBusinessDate(commonCompleteThrough, 1 - requestedPeriod.days),
      commonCompleteThrough
    ];
    const comparisonRange: [string, string] | null = requestedPeriod.comparison === "previous_equal"
      ? [
          shiftBusinessDate(currentRange[0], -requestedPeriod.days),
          shiftBusinessDate(currentRange[0], -1)
        ]
      : null;
    return {
      mode: "latest_complete",
      grain: "day",
      timeZone: CORE_OVERVIEW_TIME_ZONE,
      currentRange,
      comparisonRange,
      commonCompleteThrough
    };
  }

  if (requestedPeriod.currentRange[1] > commonCompleteThrough) {
    throw new CoreOverviewPeriodResolutionError(
      "CURRENT_RANGE_NOT_COMPLETE",
      `当前周期结束日晚于共同可信水位 ${commonCompleteThrough}`,
      { requestedEnd: requestedPeriod.currentRange[1], commonCompleteThrough }
    );
  }
  if (
    requestedPeriod.comparisonRange
    && requestedPeriod.comparisonRange[1] > commonCompleteThrough
  ) {
    throw new CoreOverviewPeriodResolutionError(
      "COMPARISON_RANGE_NOT_COMPLETE",
      `对比周期结束日晚于共同可信水位 ${commonCompleteThrough}`,
      { requestedEnd: requestedPeriod.comparisonRange[1], commonCompleteThrough }
    );
  }

  return {
    mode: "explicit",
    grain: "day",
    timeZone: CORE_OVERVIEW_TIME_ZONE,
    currentRange: [requestedPeriod.currentRange[0], requestedPeriod.currentRange[1]],
    comparisonRange: requestedPeriod.comparisonRange
      ? [requestedPeriod.comparisonRange[0], requestedPeriod.comparisonRange[1]]
      : null,
    commonCompleteThrough
  };
}
