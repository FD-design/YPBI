import type { DailyDashboardQuery } from "../../../contracts/daily-dashboard";
import type { DateRangeValue } from "../../components/ui/date-range-model";
import { liveExportMetadata, livePeriodStatus, livePointStateLabel, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { availablePeriodStatistics } from "../features/dashboards/live-period-statistics";
import { acquisitionDates, acquisitionRows, type AcquisitionRow } from "./acquisition-preview-model";
import type { AcquisitionDetailKey } from "./acquisition-view-state";
import type { WorkbookSheet } from "./preview-workbook";
import { acquisitionGroupModel, type AcquisitionGroupModel } from "./live-acquisition-groups";

const TYPE_GROUPS = [{ name: "自然新增", id: "M008.nature" }, { name: "内部导量", id: "M008.internal" }] as const;
const UNCONNECTED_LABELS = { channel: "来源渠道", target: "下载目标", settlement: "渠道结算（扣后）" } as const;

function matchesScope(result: DailyDashboardQuery, query: DailyDashboardQuery) {
  return result.boardId === query.boardId && result.pid === query.pid
    && result.dateRange[0] <= query.dateRange[0] && result.dateRange[1] >= query.dateRange[1];
}

function typePeriod(live: LiveDashboardReading, id: string, before = false) {
  const query = before ? live.comparison?.query : live.query;
  const resource = before ? live.comparison?.state : live.state;
  const result = resource?.status === "success" ? resource.data : null;
  const data = query && query.pid === live.query.pid && query.boardId === live.query.boardId
    && result && matchesScope(result.data.query, query) ? result.data : null;
  const matchingSeries = data?.series.filter(item => item.metric.id === id) ?? [];
  const series = matchingSeries.length === 1 ? matchingSeries[0] : undefined;
  const dates = query ? acquisitionDates({ start: query.dateRange[0], end: query.dateRange[1] }) : [];
  const points = dates.map(date => {
    const matches = series?.points.filter(item => item.date === date) ?? [];
    const point = matches.length === 1 ? matches[0] : undefined;
    const readable = point?.state === "available" && (!point.sourceStatus || point.sourceStatus === "READY")
      && point.value !== null && Number.isFinite(point.value) && point.value >= 0;
    const status = resource?.status === "failure" ? "读取失败" : resource?.status === "loading" ? "读取中"
      : matchingSeries.length > 1 || matches.length > 1 ? "数据异常"
        : point ? !readable && point.state === "available" && (!point.sourceStatus || point.sourceStatus === "READY")
          ? "数据异常" : livePointStateLabel(point) : "当日未返回";
    return { date, value: readable ? point.value : null, status };
  });
  const statistics = query && result && series ? availablePeriodStatistics(series, result, query) : null;
  const sums = statistics?.values.filter(item => item.kind === "period_sum") ?? [];
  const complete = points.length > 0 && points.every(point => point.value !== null);
  const periodValue = complete && statistics?.dayCount === dates.length && sums.length === 1
    && Number.isFinite(sums[0].value) && sums[0].value >= 0 ? sums[0].value : null;
  const value = points.length === 1 ? points[0].value : periodValue;
  const state = value !== null ? "待验数"
    : [...new Set(points.filter(point => point.value === null).map(point => point.status))].join("、")
      || (points.length > 1 ? "区间合计未返回" : "本期未返回");
  return { points, value, state, dateRange: query?.dateRange ?? null, fetchedAt: data?.fetchedAt ?? null };
}

/** Live dimension results only use projections carried by the current BI contract. */
export function acquisitionDetailSource(dimension: AcquisitionDetailKey, range: DateRangeValue, live: LiveDashboardReading | null): {
  origin: "demo" | "pending" | null; unavailableReason?: string; rows: AcquisitionRow[]; groups?: AcquisitionGroupModel;
} {
  if (!live) return { origin: "demo", rows: acquisitionRows(dimension, range) };
  if (dimension === "channel" || dimension === "target") {
    const groups = acquisitionGroupModel(live, dimension === "channel" ? "channel" : "downloadPlatform");
    return { origin: groups.unavailableReason ? null : "pending", unavailableReason: groups.unavailableReason, groups,
      rows: groups.rows.map(row => ({ name: row.name,
        values: Object.fromEntries(groups.ids.map(id => [id, row.current[id].summary.value])),
        baseline: Object.fromEntries(groups.ids.map(id => [id, row.previous?.[id].summary.value ?? null])),
        state: [...new Set(groups.ids.map(id => row.current[id].summary.state))].join("、") })) };
  }
  if (dimension !== "type") return {
    origin: null,
    unavailableReason: `${UNCONNECTED_LABELS[dimension]}维度待接入：BI 尚未接入该维度的真实分组结果。`,
    rows: []
  };
  const rows = TYPE_GROUPS.map(group => {
    const current = typePeriod(live, group.id), baseline = typePeriod(live, group.id, true);
    return {
      name: group.name, values: { M008: current.value }, baseline: { M008: baseline.value }, state: current.state
    };
  });
  return { origin: "pending", rows };
}

export function acquisitionTypeWorkbook(live: LiveDashboardReading): WorkbookSheet[] {
  const periods = [{ label: "当前", before: false }, ...(live.comparison ? [{ label: "对比", before: true }] : [])];
  return [
    { name: "数据说明", rows: liveExportMetadata(live) },
    { name: "获客类型", rows: [["周期", "日期", "平台", "获客类型", "新增人数", "状态", "查询时间", "刷新状态"],
      ...periods.flatMap(period => TYPE_GROUPS.flatMap(group => {
        const reading = typePeriod(live, group.id, period.before);
        return reading.points.map(point => [period.label, point.date, live.query.pid, group.name, point.value, point.status, reading.fetchedAt, livePeriodStatus(live, period.before)]);
      }))]
    },
    { name: "周期汇总", rows: [["周期", "开始日期", "结束日期", "平台", "获客类型", "新增人数合计", "状态", "查询时间", "刷新状态"],
      ...periods.flatMap(period => TYPE_GROUPS.flatMap(group => {
        const reading = typePeriod(live, group.id, period.before);
        return reading.dateRange && reading.points.length > 1
          ? [[period.label, ...reading.dateRange, live.query.pid, group.name, reading.value, reading.state, reading.fetchedAt, livePeriodStatus(live, period.before)]] : [];
      }))]
    }
  ];
}
