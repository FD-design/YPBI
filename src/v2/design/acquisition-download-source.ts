import type { GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { liveExportMetadata, livePeriodStatus, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { acquisitionDates } from "./acquisition-preview-model";
import type { WorkbookSheet } from "./preview-workbook";

export const DOWNLOAD_TARGET_UNAVAILABLE = "下载目标维度待接入：当前仅提供总体下载点击次数，目标分组及占比待接入。";

export function acquisitionDownloadPeriod(live: LiveDashboardReading, before = false) {
  const period = before ? live.comparison : live;
  const result = period?.state.status === "success" ? period.state.data : null;
  const actual = result?.data.query, query = period?.query;
  const matches = actual && query && query.pid === live.query.pid && query.boardId === live.query.boardId
    && actual.pid === query.pid && actual.boardId === query.boardId
    && actual.dateRange[0] <= query.dateRange[0] && actual.dateRange[1] >= query.dateRange[1];
  const series = matches ? result.data.series.find(item => item.metric.id === "M003") : undefined;
  return (query ? acquisitionDates({ start: query.dateRange[0], end: query.dateRange[1] }) : []).map(date => {
    const candidates = series?.points.filter(item => item.date === date) ?? [];
    const point = candidates.length === 1 ? candidates[0] : undefined;
    const readable = point?.state === "available" && (!point.sourceStatus || point.sourceStatus === "READY")
      && point.value !== null && Number.isFinite(point.value) && point.value >= 0;
    const state = period?.state.status === "loading" ? "读取中" : period?.state.status === "failure" ? "读取失败"
      : candidates.length > 1 ? "数据异常" : point ? !readable && point.state === "available" && (!point.sourceStatus || point.sourceStatus === "READY") ? "数据异常" : livePointStateLabel(point) : "当日未返回";
    return { date, value: readable ? point.value : null, state, freshness: livePeriodStatus(live, before),
      fetchedAt: matches ? result.data.fetchedAt : "",
      inputs: point?.inputs.map(input => ({
        name: series?.metric.inputs.find(item => item.key === input.key)?.name ?? input.key,
        unit: series?.metric.inputs.find(item => item.key === input.key)?.unit ?? "",
        value: readable ? input.value : null
      })) ?? [] };
  });
}

/** M003 supplies the overall daily count only; target groups never inherit it. */
export function acquisitionDownloadPoints(live: LiveDashboardReading, mode: string): GroupedTrendPoint[] {
  const previous = acquisitionDownloadPeriod(live, true);
  return acquisitionDownloadPeriod(live).map((point, index) => {
    const before = previous[index];
    const state = mode === "count" ? `${point.state} · ${point.freshness}` : DOWNLOAD_TARGET_UNAVAILABLE;
    return { date: point.date, overall: mode === "count" ? point.value : null, values: {},
      states: { __overall: state + (before ? `；对比 ${before.date} · ${before.state} · ${before.freshness}` : "") },
      ...(before ? { comparison: { date: before.date, overall: mode === "count" ? before.value : null, values: {} } } : {}) };
  });
}

export function acquisitionDownloadWorkbook(live: LiveDashboardReading): WorkbookSheet[] {
  return [
    { name: "数据说明", rows: [...liveExportMetadata(live), ["下载目标", DOWNLOAD_TARGET_UNAVAILABLE], ["导出范围", "总体下载点击次数的逐日结果、实际输入及状态；目标分组与占比未接入"]] },
    { name: "总体下载点击", rows: [["周期", "日期", "平台", "指标", "点击次数", "计算输入", "状态", "查询时间", "刷新状态"],
      ...[{ label: "当前期", before: false }, ...(live.comparison ? [{ label: "对比期", before: true }] : [])].flatMap(period =>
        acquisitionDownloadPeriod(live, period.before).map(point => [period.label, point.date, live.query.pid, "下载点击次数", point.value,
          point.inputs.map(input => `${input.name}：${input.value ?? "—"} ${input.unit}`).join("；"), point.state, point.fetchedAt, point.freshness]))] }
  ];
}
