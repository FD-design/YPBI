import { changeValueHtml } from "./ui/change-presentation.ts";

type TooltipValue = number | null | undefined;

export type TrustedChartTooltipHtml = Readonly<{ html: string }>;

const trustedChartTooltipHtml = new WeakSet<object>();

function trustChartTooltipHtml(html: string): TrustedChartTooltipHtml {
  const content = Object.freeze({ html });
  trustedChartTooltipHtml.add(content);
  return content;
}

export function readTrustedChartTooltipHtml(value: unknown) {
  if (typeof value !== "object" || value === null || !trustedChartTooltipHtml.has(value)) return null;
  return (value as TrustedChartTooltipHtml).html;
}

export function escapeChartTooltipText(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeChartTooltipColor(value: unknown) {
  const color = String(value ?? "");
  return /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(color) ? color : "#4f7cff";
}

function formatAxisTooltipValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "--";
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : escapeChartTooltipText(value);
}

export function axisSeriesTooltip(params: any[], options: { order?: string; valueFormatter?: (value: unknown) => unknown } = {}) {
  const items = options.order === "seriesAsc" ? [...params].sort((a, b) => a.seriesIndex - b.seriesIndex) : [...params].sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
  const title = escapeChartTooltipText(items[0]?.axisValueLabel ?? items[0]?.name ?? "数据详情");
  const visibleItems = items.slice(0, 8);
  const rows = visibleItems.map(item => {
    const name = escapeChartTooltipText(item.seriesName ?? "未命名系列");
    const value = options.valueFormatter ? escapeChartTooltipText(options.valueFormatter(item.value)) : formatAxisTooltipValue(item.value);
    return `<div style="display:grid;grid-template-columns:10px minmax(92px,1fr) auto;gap:7px;align-items:center;min-width:0"><i style="width:7px;height:7px;border-radius:50%;background:${safeChartTooltipColor(item.color)};display:block"></i><span style="overflow:hidden;text-overflow:ellipsis" title="${name}">${name}</span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;
  }).join("");
  const remainder = items.length > visibleItems.length ? `<small style="display:block;margin-top:7px;color:var(--color-text-on-emphasis-muted)">其余 ${items.length - visibleItems.length} 项请在图例或同口径表中查看</small>` : "";
  return `<div style="min-width:220px;max-width:360px"><strong style="display:block;margin-bottom:8px">${title}</strong><div style="display:grid;gap:6px">${rows}</div>${remainder}</div>`;
}

type GroupedTooltipRow = {
  label: string;
  value: string;
  color: unknown;
  share?: number | null;
  state?: string | null;
};

type GroupedTooltipPeriod = {
  date: string;
  overall?: { value: string; state?: string | null };
  groups: GroupedTooltipRow[];
};

function visibleTooltipState(state: string | null | undefined, value: string) {
  const normalized = String(state ?? "").trim();
  if (!normalized || /^(?:完整|可用|available|complete)$/i.test(normalized) || value.includes(normalized)) return "";
  return normalized;
}

function groupedTooltipRow(row: GroupedTooltipRow, comparison = false) {
  const label = escapeChartTooltipText(row.label);
  const value = String(row.value ?? "");
  const state = visibleTooltipState(row.state, value);
  const share = typeof row.share === "number" && Number.isFinite(row.share) ? `占总体 ${(row.share * 100).toFixed(2)}%` : "";
  const detail = [share, state].filter(Boolean).join(" · ");
  return `<div class="grouped-trend-tooltip__row${comparison ? " is-comparison" : ""}"><i class="grouped-trend-tooltip__dot" style="background:${safeChartTooltipColor(row.color)}"></i><span class="grouped-trend-tooltip__name" title="${label}">${label}</span><b class="grouped-trend-tooltip__value">${escapeChartTooltipText(value)}</b><span class="grouped-trend-tooltip__meta">${escapeChartTooltipText(detail)}</span></div>`;
}

function groupedTooltipOverall(overall: GroupedTooltipPeriod["overall"], comparison = false) {
  if (!overall) return "";
  const value = String(overall.value ?? "");
  const state = visibleTooltipState(overall.state, value);
  return `<div class="grouped-trend-tooltip__overall${comparison ? " is-comparison" : ""}"><span>总体</span><b>${escapeChartTooltipText(value)}</b>${state ? `<small>${escapeChartTooltipText(state)}</small>` : ""}</div>`;
}

export function groupedTrendTooltip(input: GroupedTooltipPeriod & { comparison?: GroupedTooltipPeriod }) {
  const currentRows = input.groups.map(row => groupedTooltipRow(row)).join("");
  const comparison = input.comparison ? `<section class="grouped-trend-tooltip__comparison"><div class="grouped-trend-tooltip__period"><span>对比期</span><time>${escapeChartTooltipText(input.comparison.date)}</time></div>${groupedTooltipOverall(input.comparison.overall, true)}<div class="grouped-trend-tooltip__rows">${input.comparison.groups.map(row => groupedTooltipRow(row, true)).join("")}</div></section>` : "";
  return trustChartTooltipHtml(`<div class="grouped-trend-tooltip"><header class="grouped-trend-tooltip__header"><time>${escapeChartTooltipText(input.date)}</time>${groupedTooltipOverall(input.overall)}</header><div class="grouped-trend-tooltip__rows">${currentRows}</div>${comparison}</div>`);
}

type ComparisonTooltipInput = {
  currentDate: string;
  currentValue: TooltipValue;
  comparisonDate: string;
  comparisonValue: TooltipValue;
  unit: string;
  differenceUnit?: string;
};

type MultiPidTooltipInput = {
  date: string;
  platform: string;
  pid: string;
  value: TooltipValue;
  unit: string;
  rank: number | null;
  rankedCount: number;
};

type FunnelTooltipInput = {
  dateRange: string;
  stageName: string;
  stageValue: number;
  adjacentRate?: number;
  loss?: number;
  overallRate?: number;
  medianHours?: string;
};

type CohortTooltipInput = {
  cohort: string;
  observationDay: string;
  cohortBase: number;
  retained: number | null;
  retentionRate: number | null;
};

export function formatTooltipValue(value: TooltipValue, unit = "") {
  const numeric = Number(value);
  if (value === null || value === undefined || !Number.isFinite(numeric)) return "缺失";
  return `${numeric.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

export function formatSignedTooltipValue(value: number, unit = "") {
  return `${value > 0 ? "+" : ""}${formatTooltipValue(value, unit)}`;
}

function lines(...content: Array<string | false | null | undefined>) {
  return content.filter((line): line is string => Boolean(line)).join("<br/>");
}

export function singleSeriesTooltip(date: string, value: TooltipValue, unit: string) {
  if (value === null || value === undefined) {
    return lines(date, "缺失", "折线在此处断开");
  }
  return lines(date, formatTooltipValue(value, unit));
}

export function comparisonTooltip(input: ComparisonTooltipInput) {
  const currentMissing = input.currentValue === null || input.currentValue === undefined;
  const comparisonMissing = input.comparisonValue === null || input.comparisonValue === undefined;
  const current = `当前期 ${input.currentDate} · ${currentMissing ? "—" : formatTooltipValue(input.currentValue, input.unit)}`;
  const comparison = `对比期 ${input.comparisonDate} · ${comparisonMissing ? "—" : formatTooltipValue(input.comparisonValue, input.unit)}`;

  if (currentMissing || comparisonMissing) {
    const missingPeriod = currentMissing && comparisonMissing ? "两期" : currentMissing ? "当前期" : "对比期";
    return lines(current, comparison, `${missingPeriod}缺失，无法比较`);
  }

  return lines(
    current,
    comparison,
    `较对比期 ${changeValueHtml(Number(input.currentValue) - Number(input.comparisonValue), formatSignedTooltipValue(Number(input.currentValue) - Number(input.comparisonValue), input.differenceUnit ?? input.unit))}`
  );
}

export function focusedSeriesTooltip(date: string, seriesName: string, value: TooltipValue, unit: string) {
  if (value === null || value === undefined) {
    return lines(date, seriesName, "缺失", "折线在此处断开");
  }
  return lines(date, seriesName, formatTooltipValue(value, unit));
}

export function multiPidTooltip(input: MultiPidTooltipInput) {
  const valueMissing = input.value === null || input.value === undefined;
  return lines(
    input.date,
    input.platform,
    `PID：${input.pid}`,
    `值：${valueMissing ? "—" : formatTooltipValue(input.value, input.unit)}`,
    `当日排名：${input.rank ?? "—"} / ${input.rankedCount}`,
    valueMissing && "该日缺失，折线断开"
  );
}

export function categoryTooltip(date: string, category: string, value: TooltipValue, unit: string) {
  return lines(date, category, formatTooltipValue(value, unit));
}

export function stackedTooltip(
  date: string,
  category: string,
  items: Array<{ name: string; value: TooltipValue }>,
  unit: string
) {
  const rows = items.map((item) => `${item.name}：${formatTooltipValue(item.value, unit)}`);
  const total = items.reduce((sum, item) => sum + (typeof item.value === "number" ? item.value : 0), 0);
  return lines(date, `来源 ${category}`, ...rows, `合计：${formatTooltipValue(total, unit)}`);
}

export function structureTooltip(dimension: string, name: string, value: TooltipValue, unit: string, percent: number) {
  return lines(`${dimension} ${name}`, formatTooltipValue(value, unit), `占整体 ${percent.toFixed(2)}%`);
}

export function funnelTooltip(input: FunnelTooltipInput) {
  const base = [input.dateRange, input.stageName, `到达用户 ${formatTooltipValue(input.stageValue, "人")}`];
  if (input.adjacentRate === undefined) return lines(...base);
  return lines(
    ...base,
    `较上一步 ${input.adjacentRate.toFixed(2)}%`,
    input.loss === undefined ? null : `相邻流失 ${formatTooltipValue(input.loss, "人")}`,
    input.overallRate === undefined ? null : `总体转化 ${input.overallRate.toFixed(2)}%`,
    input.medianHours ? `相邻耗时中位数 ${input.medianHours}` : null
  );
}

export function cohortTooltip(input: CohortTooltipInput) {
  const base = [
    `用户分组：${input.cohort}`,
    `观察日：${input.observationDay}`,
    `起始用户数：${formatTooltipValue(input.cohortBase, "人")}`
  ];
  if (input.retained === null || input.retentionRate === null) return lines(...base, "未成熟");
  return lines(
    ...base,
    `留存人数：${formatTooltipValue(input.retained, "人")}`,
    `留存率：${input.retentionRate}%`
  );
}

export function latencyTooltip(date: string, bucket: string, samples: TooltipValue) {
  return lines(date, `首帧耗时 ${bucket}`, `样本数 ${formatTooltipValue(samples, "次")}`);
}
