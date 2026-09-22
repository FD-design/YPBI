import { corePeriodMetric } from "./core-period-preview";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { formatDetailValue } from "./operating-detail-presentation";
import { operatingBreakdownModel } from "./operating-breakdown-preview";
import type { DetailEvidence } from "./operating-live-model";
import { DETAIL_COLUMNS, OPERATING_SUMMARY_IDS, summaryColumn, breakdownColumn, operatingPendingReason, type DetailColumn } from "./operating-detail-columns";
export { DETAIL_COLUMNS, detailColumnKey, type DetailColumn } from "./operating-detail-columns";

export interface DetailValue {
  current: number | null;
  previousDay: number | null;
  previousWeek: number | null;
  state?: "immature" | "unsupported" | "no_record" | "not_comparable";
  evidence?: Record<"current" | "previousDay" | "previousWeek", DetailEvidence>;
}

export interface DetailRow {
  pid: string;
  name: string;
  state: "完整" | "部分";
  productMode: string | null;
  promotionStatus: string | null;
  values: DetailValue[];
}

const FIXTURE_IDS = ["M016", "M008", "M026", "M102", "M059", "M058", "M081", "M036", "M020", "M061", "M090"];

const SNAPSHOT_DATE = "2026-09-08";
function shiftDate(date: string, days: number) { const value = new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
export function retentionTargetDate(column: DetailColumn, date: string) { return column.periodDays ? shiftDate(date, column.periodDays) : null; }
function immature(column: DetailColumn, date: string) { const target = retentionTargetDate(column, date); return target !== null && target > SNAPSHOT_DATE; }

/** Isolated DEV snapshots; no production adapter or inferred client-platform split. */
export function operatingDetailRows(date: string): DetailRow[] {
  return DETAIL_ROWS.map(row => {
    const read = (column: DetailColumn, day: string): number | null => {
      if (column.slice || !FIXTURE_IDS.includes(column.metric.id)) return null;
      if (["M081", "M061"].includes(column.metric.id)) {
        const numerator = read(summaryColumn(column.metric.id === "M081" ? "M026" : "M059"), day);
        const denominator = read(summaryColumn("M016"), day);
        return numerator === null || !denominator ? null : numerator / denominator;
      }
      const index = FIXTURE_IDS.indexOf(column.metric.id);
      const base = row.values[index].current;
      if (base === null || immature(column, day)) return null;
      if (day === SNAPSHOT_DATE) return base;
      const reference = row.values[index];
      if (day === shiftDate(SNAPSHOT_DATE, -1)) return reference.previousDay;
      if (day === shiftDate(SNAPSHOT_DATE, -7)) return reference.previousWeek;
      // The multiplier moves only synthetic daily snapshots and preserves units and bounds.
      const distance = (Date.parse(day) - Date.parse(SNAPSHOT_DATE)) / 86_400_000;
      const factor = 1 + Math.sin(distance * .61 + index) * .025;
      return column.kind === "ratio" ? Math.min(1, Math.max(0, base * factor)) : column.kind === "count" ? Math.round(base * factor) : Math.round(base * factor * 100) / 100;
    };
    return { ...row, state: "部分", values: DETAIL_COLUMNS.map(column => ({ current: read(column, date), previousDay: read(column, shiftDate(date, -1)), previousWeek: read(column, shiftDate(date, -7)),
      state: immature(column, date) ? "immature" : column.pendingReason ? "unsupported" : read(column, date) === null ? "no_record" : undefined })) };
  });
}

export function selectOperatingRows(rows: DetailRow[], platform: string) { return platform === "all" ? rows : rows.filter(row => row.pid === platform); }
export function operatingValueLabel(value: DetailValue, column: DetailColumn) {
  if (value.evidence && value.evidence.current.state !== "available") return value.evidence.current.label;
  return value.state === "unsupported" ? "待接口支持" : value.state === "immature" ? "未成熟" : value.state === "not_comparable" ? "无可比数据" : formatDetailValue(value.current, column.kind, false, column.unit);
}

export function operatingDetailBreakdown(model: DashboardMetricCardModel, rows: DetailRow[], platform: string, date: string) {
  const row = rows.find(item => item.pid === platform);
  const result = operatingBreakdownModel(model, `数据日 ${date} · ${platform === "all" ? "全部平台 · 独立大盘 · 演示数据" : row?.name ?? "未知平台"}`, slice => {
    const column = breakdownColumn(model.metric.id, slice);
    const columnIndex = column ? DETAIL_COLUMNS.indexOf(column) : -1;
    const value = row?.values[columnIndex];
    if (model.metric.id === "M020" && model.result.status === "immature") return { status: "immature", label: "未成熟", reason: "该注册日用户的次日观察尚未结束。" };
    if (value && value.current !== null && column) return { status: "available", raw: value.current, display: column.kind === "ratio" ? (value.current * 100).toFixed(2) : value.current.toLocaleString("en-US", { maximumFractionDigits: 2 }), origin: value.evidence ? "pending" : "demo", sample: value.evidence?.current.inputs.map(input => `${input.name} ${input.value ?? "—"} ${input.unit}`).join(" / ") };
    if (value?.evidence) return { status: "no_record", label: value.evidence.current.label, reason: "真实查询状态；不使用演示数据补齐。" };
    if (value?.state === "no_record") return { status: "no_record", label: "无记录", reason: "当前日期和业务平台没有该维度的结果。" };
    return { status: "unsupported", label: "待接口支持", reason: operatingPendingReason(model.metric.id, slice) };
  });
  const liveSlice = row?.values.find((value, index) => DETAIL_COLUMNS[index].metric.id === model.metric.id && value.evidence);
  return { ...result, unit: liveSlice ? liveSlice.evidence?.current.unit ?? "" : model.result.status === "available" ? model.result.value.unit ?? result.unit : result.unit };
}

export function operatingSummaryModels(rows: DetailRow[], platform: string, date: string): DashboardMetricCardModel[] {
  const models = OPERATING_SUMMARY_IDS.map<DashboardMetricCardModel>(id => {
    const column = summaryColumn(id);
    const base: DashboardMetricCardModel = column.pendingReason ? { metric: { id, name: column.metric.name, definitionLabel: column.metric.definition, aggregationLabel: date },
      result: { status: "unsupported", label: "待接口支持", contextLabel: date, retryable: false, message: "当前范围尚无已验证结果。" } } : corePeriodMetric(id, { start: date, end: date }, false);
    const columnIndex = DETAIL_COLUMNS.findIndex(column => column.metric.id === id && !column.slice);
    const row = rows.find(item => item.pid === platform);
    const metric = { ...base.metric, aggregationLabel: `${date} · ${platform === "all" ? "大盘独立结果" : row?.name ?? "未知平台"}${id === "M020" ? " · 注册日" : ""}` };
    if (platform === "all") return { ...base, metric, result: base.result.status === "immature" ? { ...base.result, label: "未成熟" } : base.result };
    const value = row?.values[columnIndex];
    if (!value || value.current === null) return { metric, result: { status: value?.state === "immature" ? "immature" : value?.state === "unsupported" ? "unsupported" : "no_records", label: value?.state === "immature" ? "未成熟" : value?.state === "unsupported" ? "待接口支持" : "无记录", contextLabel: date, retryable: false, message: value?.state === "immature" ? "该注册日用户的次日观察尚未结束。" : "当前范围尚无已验证结果。" } };
    return { metric, result: { status: "available", completeness: "complete", refresh: { status: "idle" }, value: {
      raw: value.current,
      display: column.kind === "ratio" ? (value.current * 100).toFixed(2) : value.current.toLocaleString("en-US", { maximumFractionDigits: column.kind === "currency" ? 2 : 0 }),
      unit: column.unit
    }, comparison: null, trendKind: "line", trend: { current: [], comparison: null }, validationLabel: "演示数据", watermarkLabel: `数据日 ${date}` } };
  });
  if (platform === "all") {
    const active = models.find(model => model.metric.id === "M016")!.result;
    const payers = models.find(model => model.metric.id === "M059")!.result;
    const rate = models.find(model => model.metric.id === "M061")!;
    // This DEV rate uses the same independent-overall snapshot, never a sum of PID rows.
    if (active.status === "available" && payers.status === "available" && active.value.raw > 0) {
      const raw = payers.value.raw / active.value.raw;
      rate.result = { ...payers, value: { raw, display: (raw * 100).toFixed(2), unit: "%" },
        comparison: null, trend: { current: [], comparison: null } };
    } else {
      rate.result = { status: "unsupported", label: "无可比数据", contextLabel: date, retryable: false, message: "同一大盘快照的付费人数或有效活跃人数尚未就绪。" };
    }
  }
  return models;
}

export function operatingDetailExportRows(rows: DetailRow[], date: string) {
  const numeric = (value: number | null, column: DetailColumn) => value === null ? null : value * (column.kind === "ratio" ? 100 : 1);
  const retention = DETAIL_COLUMNS.filter(c=>c.periodDays && !c.slice);
  return [["数据日", "业务平台", "PID", "模式", "模式｜数据状态", "推广状态", "推广状态｜数据状态", ...DETAIL_COLUMNS.flatMap(column => [`${column.metric.name}（${column.unit}）`, `${column.metric.name}｜数据状态`, `${column.metric.name}｜昨日（${column.unit}）`, `${column.metric.name}｜上周同日（${column.unit}）`]), "MAU｜自然月", "MAU｜数据截至日", ...retention.map(c=>`${c.metric.name}｜目标日`)],
    ...rows.map(row => [date, row.name, row.pid, row.productMode, row.productMode === null ? "待接口支持" : "完整", row.promotionStatus, row.promotionStatus === null ? "待接口支持" : "完整", ...row.values.flatMap((value, i) => [numeric(value.current, DETAIL_COLUMNS[i]), value.state ? operatingValueLabel(value, DETAIL_COLUMNS[i]) : "完整", numeric(value.previousDay, DETAIL_COLUMNS[i]), numeric(value.previousWeek, DETAIL_COLUMNS[i])]), date.slice(0,7), null, ...retention.map(c=>retentionTargetDate(c,date))])];
}

// Synthetic daily platform snapshots; aggregate metrics remain an independent query fixture.
const PLATFORM_FIXTURES = [
  { pid: "PH", name: "Pornhub", current: [90000, 2700, 70740, 140000, 912, 24300, .786, .6142, .3478, .010133, .9216], previousDay: [88000, 2800, 68464, 138000, 900, 23900, .778, .608, .3418, .010227, .9188], previousWeek: [86000, 2600, 65876, 132000, 870, 23200, .766, .6205, .3396, .010116, .925] },
  { pid: "TT", name: "TikTok", current: [60000, 1900, 46800, 100000, 655, 17800, .78, .5981, .3392, .010917, .9137], previousDay: [60500, 1950, 47190, 99000, 660, 17900, .78, .602, .335, .010909, .917], previousWeek: [59000, 1850, 44840, 98000, 640, 17100, .76, .593, .3425, .010847, .909] },
  { pid: "XH", name: "XHamster", current: [45000, 1450, 35280, 78000, 434, 12400, .784, null, .3188, .009644, .8962], previousDay: [44400, 1400, 34632, 76000, 429, 12100, .78, null, .321, .009662, .901], previousWeek: [43800, 1390, 33726, 75000, 421, 11900, .77, null, .315, .009612, .889] },
  { pid: "XN", name: "XNXX", current: [30000, 980, 23250, 55000, 293, 7112.34, .775, .6014, .3506, .009767, .932], previousDay: [29400, 960, 22344, 54000, 290, 7040, .76, .596, .346, .009864, .929], previousWeek: [29100, 940, 22407, 52000, 282, 6930, .77, .608, .355, .009691, .936] }
];
export const DETAIL_ROWS: DetailRow[] = PLATFORM_FIXTURES.map(row => ({
  pid: row.pid, name: row.name, state: row.current.some(value => value === null) ? "部分" : "完整", productMode: null, promotionStatus: null,
  values: row.current.map((current, i) => ({ current, previousDay: row.previousDay[i], previousWeek: row.previousWeek[i] }))
}));
