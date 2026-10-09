import type { GroupedTrendPoint } from "../features/dashboards/GroupedTrend";
import { liveExportMetadata, livePeriodStatus, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { acquisitionDates } from "./acquisition-preview-model";
import type { WorkbookSheet } from "./preview-workbook";
import { CHART_PALETTE } from "../../theme/tokens";
import { ACQUISITION_GROUP_LIMIT, acquisitionGroupModel, acquisitionGroupWorkbook } from "./live-acquisition-groups";

export const DOWNLOAD_TARGET_UNAVAILABLE = "下载目标维度待接入：当前仅提供总体下载点击次数，目标分组及占比待接入。";
// Chart-local IDs cannot collide with GroupedTrend's reserved overall ID.
const downloadGroupId = (key: string) => JSON.stringify(["downloadPlatform", key]);

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

/** Overall counts and target groups retain their independent server results. */
export function acquisitionDownloadPoints(live: LiveDashboardReading, mode: string, model = acquisitionGroupModel(live, "downloadPlatform")): GroupedTrendPoint[] {
  const previous = acquisitionDownloadPeriod(live, true);
  return acquisitionDownloadPeriod(live).map((point, index) => {
    const before = previous[index];
    const state = mode === "count" ? `${point.state} · ${point.freshness}` : model.unavailableReason ? DOWNLOAD_TARGET_UNAVAILABLE : `占比待接入：${ACQUISITION_GROUP_LIMIT}`;
    return { date: point.date, overall: mode === "count" ? point.value : null,
      values: Object.fromEntries(model.rows.map(row => [downloadGroupId(row.key), mode === "count" ? row.current.M003.points[index]?.value ?? null : null])),
      states: { __overall: state + (before ? `；对比 ${before.date} · ${before.state} · ${before.freshness}` : ""),
        ...Object.fromEntries(model.rows.map(row => { const current = row.current.M003.points[index], previous = row.previous?.M003.points[index]; return [downloadGroupId(row.key), mode === "count" ? `${current?.state ?? "当日未返回"} · ${current?.freshness ?? ""}${previous ? `；对比 ${previous.date} · ${previous.state} · ${previous.freshness}` : ""}` : `占比待接入：${ACQUISITION_GROUP_LIMIT}`]; })) },
      ...(before ? { comparison: { date: before.date, overall: mode === "count" ? before.value : null,
        values: Object.fromEntries(model.rows.map(row => [downloadGroupId(row.key), mode === "count" ? row.previous?.M003.points[index]?.value ?? null : null])) } } : {}) };
  });
}

export function acquisitionDownloadModel(live: LiveDashboardReading, mode: string) {
  const model = acquisitionGroupModel(live, "downloadPlatform");
  const groups = model.rows.map((row, index) => ({ id: downloadGroupId(row.key), label: row.name, color: CHART_PALETTE[index % CHART_PALETTE.length] }));
  return { groups, readings: model.rows, available: false, total: null,
    notice: model.unavailableReason ? model.unavailableReason.includes("维度待接入") ? DOWNLOAD_TARGET_UNAVAILABLE : model.unavailableReason
      : `${model.current.status === "已返回" ? "" : `${model.current.status}。`}${ACQUISITION_GROUP_LIMIT}`,
    items: groups.map((group, index) => { const row = model.rows[index]; return { ...group, value: row.current.M003.summary.value,
      ...(row.previous ? { comparison: row.previous.M003.summary.value } : {}) }; }), points: acquisitionDownloadPoints(live, mode, model) };
}

export function acquisitionDownloadWorkbook(live: LiveDashboardReading): WorkbookSheet[] {
  const model = acquisitionGroupModel(live, "downloadPlatform"), grouped = Boolean(model.current.extension || model.previous?.extension);
  return [
    { name: "数据说明", rows: [...liveExportMetadata(live), ["下载目标", grouped ? ACQUISITION_GROUP_LIMIT : DOWNLOAD_TARGET_UNAVAILABLE], ["导出范围", grouped ? "总体逐日结果及已返回下载目标的汇总、逐日输入和两期状态" : "总体下载点击次数的逐日结果、实际输入及状态；目标分组与占比未接入"], ["当前分组状态", model.current.status], ...(model.previous ? [["对比分组状态", model.previous.status]] : [])] },
    { name: "总体下载点击", rows: [["周期", "日期", "平台", "指标", "点击次数", "计算输入", "状态", "查询时间", "刷新状态"],
      ...[{ label: "当前期", before: false }, ...(live.comparison ? [{ label: "对比期", before: true }] : [])].flatMap(period =>
        acquisitionDownloadPeriod(live, period.before).map(point => [period.label, point.date, live.query.pid, "下载点击次数", point.value,
          point.inputs.map(input => `${input.name}：${input.value ?? "—"} ${input.unit}`).join("；"), point.state, point.fetchedAt, point.freshness]))] },
    ...(grouped ? acquisitionGroupWorkbook(live, "downloadPlatform").slice(1) : [])
  ];
}
