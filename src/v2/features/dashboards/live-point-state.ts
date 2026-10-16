import type { DailyPoint, DailyReadingMetric } from "../../../../contracts/daily-dashboard";
import { dashboardNoRecordLabels } from "./dashboard-metric-card-model";
import { diagnosticRatioInputs, DIAGNOSTIC_INPUTS_LABEL } from "./diagnostic-inputs";

export const liveStateLabel = { available: "已返回", no_record: dashboardNoRecordLabels.day, no_value: "字段未返回", invalid_value: "数据异常", zero_denominator: "分母为0", immature: "待成熟", source_failure: "读取失败" };

/** Source processing and transport failures describe different recovery paths. */
export const livePointStateLabel = (point: DailyPoint, metric?: DailyReadingMetric) => metric && diagnosticRatioInputs(metric, point) ? DIAGNOSTIC_INPUTS_LABEL
  : point.sourceStatus === "PROCESSING" ? "计算中"
    : point.sourceStatus === "NOT_MATURE" ? "待成熟"
      : point.sourceStatus === "SOURCE_INCOMPLETE" ? "来源不完整"
        : point.sourceStatus === "FAILED" ? "加工失败"
          : liveStateLabel[point.state];
