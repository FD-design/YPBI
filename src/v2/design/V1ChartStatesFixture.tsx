import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { RetentionChartExample, CardModeExample, GroupedTrendExample, CommerceChartExamples } from "./OperationsChartExamples";
import { corePeriodMetric } from "./core-period-preview";
import { operatingSummaryModels, operatingDetailRows } from "./operating-detail-snapshot";
import { PivotTable } from "../../components/ui/PivotTable";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { PaginatedLegend } from "../../components/ui/PaginatedLegend";
import { AlertCircle, CheckCircle2, Info, LoaderCircle, RotateCcw, Search } from "lucide-react";
import { isValidElement, useMemo, useState, type ReactNode } from "react";
import { Chart, type ChartOption } from "../../components/Chart";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { ChangeValue } from "../../components/ui/ChangeValue";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import { ChartDataTable } from "../../components/ui/ChartDataTable";
import { DashboardMetricCard } from "../features/dashboards/DashboardMetricCard";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { MetricBreakdown, type MetricBreakdownModel } from "../features/dashboards/MetricBreakdown";
import { galleryBreakdown, OPERATING_BREAKDOWNS, operatingDimensionLabel } from "./operating-breakdown-preview";
import { ComparisonDetails } from "../features/dashboards/ComparisonDetails";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import { changeDirection } from "../../components/ui/change-presentation";
import { CHART_PALETTE } from "../../theme/tokens";
import metricDefinitions from "../../../server/v2/generated/metric-definitions.json";
import { metricBusinessExplanation } from "../features/metrics/metric-presentation";
import platformCatalog from "../../../server/platforms/platform-catalog.v1.json";
import {
  categoryTooltip as compactCategoryTooltip,
  comparisonTooltip,
  formatSignedTooltipValue as formatSignedNumber,
  formatTooltipValue as formatNumber,
  funnelTooltip,
  latencyTooltip,
  multiPidTooltip,
  singleSeriesTooltip,
  stackedTooltip,
  structureTooltip
} from "../../components/chart-tooltip-content";
import "./v1-chart-states-fixture.css";

type PreviewMode = "charts" | "states";
type SnapshotCell = ReactNode;

function DifferenceValue({ value }: { value: number | null }) {
  return <ChangeValue direction={changeDirection(value)}>{value === null ? "不可比" : formatSignedNumber(value)}</ChangeValue>;
}

const DATES = ["09-02", "09-03", "09-04", "09-05", "09-06", "09-07", "09-08"];
const COMPARE_DATES = ["08-26", "08-27", "08-28", "08-29", "08-30", "08-31", "09-01"];
const CURRENT = [168420, 172860, 0, 176540, null, 183920, 194319];
const COMPARE = [160110, 166240, 169780, 171320, 175480, 178260, 181730];
const PLATFORM_NAMES = [
  "Android · 自然新增用户（应用商店自然量）",
  "iOS · 自然新增用户（App Store）",
  "Android · 内部导量新用户",
  "iOS · 内部导量新用户",
  "Android · 老用户回访",
  "iOS · 老用户回访",
  "Web · 直接访问",
  "Android · 广告渠道 A",
  "iOS · 广告渠道 B",
  "Web · 搜索引擎",
  "Android · 联盟渠道",
  "iOS · 联盟渠道"
];

const palette = CHART_PALETTE;
const METRIC_BY_ID = new Map(metricDefinitions.items.map((metric) => [metric.id, metric]));
const ACTIVE_PLATFORM_SAMPLES = platformCatalog.items.filter((platform) => platform.enabled);

function metricName(metricId: string, fallback: string) {
  return METRIC_BY_ID.get(metricId)?.name ?? fallback;
}

function metricDefinition(metricId: string) {
  const metric = METRIC_BY_ID.get(metricId);
  if (!metric) return "完整名称、定义、单位、聚合方式和版本均以指标中心为准。";
  return metricBusinessExplanation(metric, new Map(metricDefinitions.items.map((item) => [item.id, item.name]))).text;
}

const PID_SERIES = ACTIVE_PLATFORM_SAMPLES.map((platform, platformIndex) => ({
  name: platform.name,
  pid: platform.pid,
  values: DATES.map((_, dayIndex) => {
    if (platformIndex === 4 && dayIndex === 4) return null;
    if (platformIndex === 8 && dayIndex === 2) return 0;
    const baseline = 196_000 - platformIndex * 6_200;
    const direction = dayIndex * (1_400 + (platformIndex % 4) * 180);
    const variation = ((platformIndex * 7 + dayIndex * 11) % 9 - 4) * 520;
    return Math.max(0, baseline + direction + variation);
  })
}));

function actualDate(label: string) {
  return `2026-${label}`;
}

function axisComparisonTooltip(unit: string, current: Array<number | null>, comparison?: Array<number | null>) {
  return (params: any[]) => {
    const items = Array.isArray(params) ? params : [params];
    const index = Number(items[0]?.dataIndex ?? 0);
    const date = actualDate(DATES[index] ?? String(items[0]?.axisValue ?? "未知日期"));
    const currentValue = current[index];
    const compareValue = comparison?.[index];
    if (!comparison) return singleSeriesTooltip(date, currentValue, unit);
    return comparisonTooltip({
      currentDate: date,
      currentValue,
      comparisonDate: actualDate(COMPARE_DATES[index] ?? "未知日期"),
      comparisonValue: compareValue,
      unit
    });
  };
}

function categoryTooltip(unit: string, dataDate = "2026-09-08") {
  return (params: any) => {
    const item = Array.isArray(params) ? params[0] : params;
    const rawValue = Array.isArray(item?.value) ? item.value.at(-1) : item?.value;
    return compactCategoryTooltip(dataDate, item?.name || item?.axisValue || "分类", rawValue, unit);
  };
}

function commonCartesian() {
  return {
    animation: false,
    grid: { left: 46, right: 18, top: 30, bottom: 40, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "line" } },
    xAxis: { axisLine: { lineStyle: { color: "#c7cfdb" } }, axisTick: { show: false }, axisLabel: { color: "#6b7280", fontSize: 11 } },
    yAxis: { type: "value", axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: "#6b7280", fontSize: 11 }, splitLine: { lineStyle: { color: "#edf0f4" } } }
  };
}

function MetricHint({ name, definition }: { name: string; definition: string }) {
  return <FloatingHint className="v1-gallery__metric-hint" content={definition} pinOnClick>
    <button type="button" aria-label={`查看${name}说明`}><Info aria-hidden="true" /></button>
  </FloatingHint>;
}

function SnapshotExport({ caption }: { caption: string }) {
  return <PreviewExportControl name={caption} scope="当前表格的全部聚合结果及状态，不受图形、分页或临时比较显隐限制。" context="固定视觉样例" />;
}
function SnapshotTable({ caption, columns, rows, showExport = true }: { caption: string; columns: string[]; rows: SnapshotCell[][]; showExport?: boolean }) {
  const numeric = columns.map((_, index) => rows.some((row) => typeof row[index] === "number" || isValidElement(row[index]) || /^[+−-]?[\d,]+(?:\.\d+)?%?$/.test(String(row[index]))));
  return <div>{showExport && <div className="v1-gallery__table-actions"><SnapshotExport caption={caption} /></div>}<PaginatedTable label={caption} tableClassName="v1-gallery__table" columnCount={columns.length}
    head={<tr>{columns.map((column, index) => <th key={column} className={numeric[index] ? "is-number" : undefined}>{column}</th>)}</tr>}
    rows={rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className={numeric[cellIndex] ? "is-number" : undefined}>{cell}</td>)}</tr>)} />
  </div>;
}

function ChartPanel({
  id,
  kind,
  title,
  meta,
  note,
  option,
  height = 264,
  columns,
  rows,
  children
}: {
  id?: string;
  kind: string;
  title: string;
  meta: string;
  note?: string;
  option?: ChartOption;
  height?: number;
  columns: string[];
  rows: SnapshotCell[][];
  children?: ReactNode;
}) {
  const accessibleName = `${title}，固定视觉样例，${meta}`;
  return <DashboardPanel id={id} className="v1-gallery__panel" chartKind={kind} title={title} note={meta} tools={<span className="ui-status ui-status--neutral">视觉样例</span>}>
    {note && <p className="v1-gallery__panel-note"><Info aria-hidden="true" />{note}</p>}
    {children ?? (option ? <Chart option={option} theme="v13" ariaLabel={accessibleName} style={{ height }} /> : null)}
    <ChartDataTable title={`${title}同口径数据表`} exportAction={<SnapshotExport caption={`${title}同口径快照`} />}>
      <SnapshotTable caption={`${title}同口径快照`} columns={columns} rows={rows} showExport={false} />
    </ChartDataTable>
  </DashboardPanel>;
}

function CompactKpis() {
  const [detail, setDetail] = useState<{ title: string; content: ReactNode } | null>(null);
  const [breakdown, setBreakdown] = useState<MetricBreakdownModel | null>(null);
  const models = [...operatingSummaryModels(operatingDetailRows("2026-09-07"), "all", "2026-09-07"), corePeriodMetric("M102", { start: "2026-09-02", end: "2026-09-08" }, true)].map(model => {
    const id = model.metric.id;
    if (id === "M102" && model.result.status === "available") return { ...model, result: { ...model.result, value: { raw: 0, display: "0", unit: "小时" }, comparison: null, validationLabel: "数值 0 样例" } };
    return OPERATING_BREAKDOWNS[id] ? galleryBreakdown(model).metric : model;
  });
  return <section className="v1-gallery__kpi-section" data-chart-kind="kpi-compact" aria-labelledby="v1-kpi-compact-title">
    <header><div><h2 id="v1-kpi-compact-title">纯数值卡</h2><p>10 项经营摘要与数值 0 状态样例；固定视觉样例与经营明细复用同一组件及适用拆分。</p></div><span>11 项</span></header>
    <div className="v1-gallery__kpi-grid">{models.map(model => <DashboardMetricCard key={model.metric.id} model={model} variant="value"
      analysisHref={`/analysis/metrics/${model.metric.id}`}
      onOpenBreakdown={OPERATING_BREAKDOWNS[model.metric.id] ? () => setBreakdown(galleryBreakdown(model)) : undefined}
      breakdownDimensions={operatingDimensionLabel(model.metric.id)}
      onOpenAnalysis={() => setDetail({ title: model.metric.name, content: <p>{model.metric.definitionLabel}</p> })}
      onOpenDefinition={() => setDetail({ title: `${model.metric.name} · 指标说明`, content: <p>{model.metric.definitionLabel}</p> })}
      onOpenComparison={() => setDetail({ title: "周期对比", content: model.result.status === "available" && model.result.comparison ? <ComparisonDetails comparison={model.result.comparison} onEmphasis={false} /> : <p>当前样例未开启对比。</p> })}
      onOpenTrendPoint={() => undefined}
    />)}</div>
    {breakdown && <MetricBreakdown model={breakdown} onClose={() => setBreakdown(null)} />}
    {detail && <MetricReadingDialog {...detail} onClose={() => setDetail(null)} />}
  </section>;
}

function DetailedKpi() {
  const [detail, setDetail] = useState<{ title: string; content: ReactNode } | null>(null);
  const values = [164220, 168410, 170800, 176540, 180210, 186840, 194319];
  const current = DATES.map((date, index) => ({
    key: date, label: date, actualDate: actualDate(date),
    value: { raw: values[index], display: values[index].toLocaleString() + " 人", actualDate: actualDate(date) },
    counterpart: { raw: COMPARE[index], display: COMPARE[index].toLocaleString() + " 人", actualDate: actualDate(COMPARE_DATES[index]) },
    differenceDisplay: formatSignedNumber(values[index] - COMPARE[index]) + " 人", state: "available" as const, stateLabel: "视觉样例"
  }));
  const comparison = { status: "available" as const, label: "较对比期对应日", display: "↑ 6.93%", direction: "up" as const, kind: "relative_change" as const,
    rows: [{ label: "当前日", date: "2026-09-08", value: "194,319 人" }, { label: "对比日", date: "2026-09-01", value: "181,730 人" }],
    difference: { display: "+12,589 人", direction: "up" as const }, detail: "当前日与对比日的同口径结果。" };
  const model: DashboardMetricCardModel = {
    metric: { id: "M016", name: metricName("M016", "日活跃用户数"), definitionLabel: metricDefinition("M016"), aggregationLabel: "09-02 至 09-08 · 摘要为 09-08 当日值" },
    result: { status: "available", completeness: "complete", refresh: { status: "idle" }, value: { raw: 194319, display: "194,319", unit: "人" },
      trendKind: "line", validationLabel: "固定视觉样例", watermarkLabel: "数据至 09-08", comparison,
      trend: { current, comparison: current.map((point, index) => ({ ...point, key: COMPARE_DATES[index], actualDate: point.counterpart.actualDate, value: point.counterpart, counterpart: point.value })) }
    }
  };
  return <section id="v1-detailed-kpi" data-chart-kind="kpi-detailed">
    <DashboardMetricCard model={model} variant="detailed" analysisHref="/analysis/metrics/M016"
      tableExport={<SnapshotExport caption="日活跃用户数同口径快照" />}
      onOpenAnalysis={() => setDetail({ title: "来源分析", content: <p>固定视觉样例不发起正式查询。正式指标分析通过指标中心进入。</p> })}
      onOpenDefinition={() => setDetail({ title: model.metric.name, content: <p>{model.metric.definitionLabel}</p> })}
      onOpenComparison={() => setDetail({ title: "日活跃用户数对比", content: <ComparisonDetails comparison={comparison} onEmphasis={false} /> })}
      onOpenTrendPoint={(_, point) => setDetail({ title: point.actualDate, content: <p>{point.value?.display ?? "—"} · 对比 {point.counterpart?.actualDate} {point.counterpart?.display ?? "—"}</p> })}
    />
    {detail && <MetricReadingDialog {...detail} onClose={() => setDetail(null)} />}
  </section>;
}

function MultiPidTrend() {
  const firstPid = PID_SERIES[0]?.pid ?? "";
  const [query, setQuery] = useState("");
  const [focusedPid, setFocusedPid] = useState(firstPid);
  const [highlightedPids, setHighlightedPids] = useState<string[]>(firstPid ? [firstPid] : []);
  const visiblePlatforms = PID_SERIES.filter((series) => `${series.name} ${series.pid}`.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  const toggleHighlight = (pid: string) => {
    setFocusedPid(pid);
    setHighlightedPids((current) => current.includes(pid)
      ? current.length === 1 ? current : current.filter((item) => item !== pid)
      : current.length < 5 ? [...current, pid] : [...current.slice(1), pid]);
  };
  const option = useMemo<ChartOption>(() => {
    const selected = new Set(highlightedPids);
    return {
      ...commonCartesian(),
      grid: { left: 48, right: 18, top: 22, bottom: 34, containLabel: true },
      tooltip: {
        trigger: "item",
        axisPointer: { type: "line" },
        formatter: (params: any) => {
          const series = PID_SERIES.find((item) => `${item.name}（${item.pid}）` === params?.seriesName);
          const dayIndex = Number(params?.dataIndex ?? 0);
          if (!series) return "当前系列不可用";
          const value = series.values[dayIndex];
          const ranked = PID_SERIES.map((item) => ({ pid: item.pid, value: item.values[dayIndex] }))
            .filter((item): item is { pid: string; value: number } => typeof item.value === "number")
            .sort((left, right) => right.value - left.value);
          const rank = ranked.findIndex((item) => item.pid === series.pid) + 1;
          return multiPidTooltip({
            date: actualDate(DATES[dayIndex] ?? "未知日期"),
            platform: series.name,
            pid: series.pid,
            value,
            unit: "人",
            rank: rank || null,
            rankedCount: ranked.length
          });
        }
      },
      legend: { show: false },
      xAxis: { type: "category", data: DATES, boundaryGap: false },
      series: PID_SERIES.map((series) => {
        const highlightIndex = Math.max(0, highlightedPids.indexOf(series.pid));
        const isHighlighted = selected.has(series.pid);
        const isFocused = focusedPid === series.pid;
        const color = isHighlighted ? palette[highlightIndex % palette.length] : "#b8c2cf";
        return {
          name: `${series.name}（${series.pid}）`,
          type: "line",
          data: series.values,
          connectNulls: false,
          showSymbol: isFocused,
          symbol: "circle",
          symbolSize: isFocused ? 7 : 5,
          z: isFocused ? 10 : isHighlighted ? 6 : 1,
          lineStyle: { color, width: isFocused ? 2.6 : isHighlighted ? 2 : 1, opacity: isHighlighted ? 1 : .24 },
          itemStyle: { color, opacity: isHighlighted ? 1 : .35 },
          emphasis: { focus: "series", lineStyle: { color: palette[0], width: 3, opacity: 1 }, itemStyle: { color: palette[0], opacity: 1 } },
          blur: { lineStyle: { opacity: .08 }, itemStyle: { opacity: .08 } }
        };
      })
    };
  }, [focusedPid, highlightedPids]);

  return <article className="v1-gallery__panel v1-gallery__multi-pid ui-chart-surface" data-chart-kind="line-multi-pid">
    <header className="v1-gallery__panel-head">
      <div><h3>多业务 PID 趋势压力样例</h3><p>{metricName("M016", "日活跃用户数")} · 当前目录 {PID_SERIES.length} 项 · 7 个业务日 · 数量不是产品上限</p></div>
      <span className="ui-status ui-status--neutral">全量可查</span>
    </header>
    <p className="v1-gallery__panel-note"><Info aria-hidden="true" />图中始终保留全部 PID；最多突出 5 项，其余作为低强调背景线。搜索或临时突出不会裁剪同口径表和导出数据。</p>
    <div className="v1-gallery__multi-pid-layout">
      <div className="v1-gallery__pid-tools" aria-label="业务 PID 图例与筛选">
        <label className="v1-gallery__pid-search ui-search"><Search aria-hidden="true" /><span className="sr-only">搜索业务名称或 PID</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索业务名称或 PID" /></label>
        <div className="v1-gallery__pid-summary"><span aria-live="polite">已突出 {highlightedPids.length} / 5 项</span><button type="button" onClick={() => { setFocusedPid(firstPid); setHighlightedPids(firstPid ? [firstPid] : []); }}><RotateCcw aria-hidden="true" />恢复默认</button></div>
      </div>
      <Chart option={option} theme="v13" ariaLabel={`${metricName("M016", "日活跃用户数")}按全部业务 PID 展示的 7 日多系列趋势固定视觉样例`} style={{ height: 342 }} />
      <PaginatedLegend label="当前目录全部业务 PID" items={visiblePlatforms.map(series => ({ id: series.pid, label: `${series.name}（${series.pid}）`, selected: highlightedPids.includes(series.pid), color: highlightedPids.includes(series.pid) ? palette[highlightedPids.indexOf(series.pid) % palette.length] : "#b8c2cf" }))} onToggle={toggleHighlight} />
    </div>
    <ChartDataTable title="全部业务 PID 日活跃用户数同口径数据表" label="查看全部 PID 同口径数据表" exportAction={<SnapshotExport caption="全部业务 PID 日活跃用户数同口径快照" />}>
      <SnapshotTable caption="全部业务 PID 日活跃用户数同口径快照" columns={["业务平台", "PID", ...DATES.map(actualDate)]} rows={PID_SERIES.map((series) => [series.name, series.pid, ...series.values.map((value) => value === null ? "缺失" : value.toLocaleString())])} showExport={false} />
    </ChartDataTable>
  </article>;
}

function StateExamples() {
  const states = [
    { key: "normal", title: "正常", value: "194,319 人", detail: "完整 · 视觉样例", tone: "success" },
    { key: "zero", title: "真实 0", value: "0 小时", detail: "有记录且值为 0", tone: "success" },
    { key: "missing", title: "缺失", value: "—", detail: "09-05 无值，不补 0", tone: "warning" },
    { key: "partial", title: "部分数据", value: "5 / 7 日", detail: "缺少 09-05、09-06", tone: "warning" },
    { key: "empty", title: "无记录", value: "当前范围无记录", detail: "查询成功但没有记录", tone: "neutral" },
    { key: "immature", title: "未成熟", value: "D7 尚未成熟", detail: "等待观察窗口结束", tone: "warning" },
    { key: "not-produced", title: "未产出", value: "当前数据日未产出", detail: "不使用昨日结果顶替", tone: "neutral" },
    { key: "refresh-failed", title: "刷新失败", value: "保留 09-07 旧结果", detail: "明确标注旧水位与失败", tone: "warning" },
    { key: "loading", title: "加载中", value: "正在读取", detail: "保留页面骨架，不显示旧值", tone: "loading" },
    { key: "error", title: "查询失败", value: "暂时无法读取", detail: "错误可恢复 · 不伪造结果", tone: "danger" },
    { key: "long", title: "超长名称", value: "Android · 应用商店自然新增用户", detail: "完整名称可查看，不撑破布局", tone: "neutral" }
  ];
  return <section className="v1-gallery__state-section" data-chart-kind="state-boundaries" aria-labelledby="v1-state-title">
    <header><div><h2 id="v1-state-title">状态与边界</h2><p>同一个状态词在 KPI、图表和表格中保持一致，颜色只做辅助。</p></div></header>
    <div className="v1-gallery__state-grid">{states.map((state) => <article key={state.key} data-state-example={state.key} className={`is-${state.key}`}>
      <header><span className={`ui-status ui-status--${state.tone === "danger" ? "warning" : state.tone}`}>{state.key === "loading" && <LoaderCircle aria-hidden="true" />}{state.key === "error" && <AlertCircle aria-hidden="true" />}{state.title}</span></header>
      <strong>{state.value}</strong><p>{state.detail}</p>
      {state.key === "error" && <button type="button" className="ui-button ui-button--secondary ui-button--sm"><RotateCcw aria-hidden="true" />重试样例</button>}
    </article>)}</div>
  </section>;
}

function buildOptions() {
  const singleLine: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", formatter: axisComparisonTooltip("人", CURRENT) },
    xAxis: { type: "category", data: DATES, boundaryGap: false },
    series: [{ name: "日活跃用户数", type: "line", data: CURRENT, connectNulls: false, symbol: "circle", symbolSize: 7, lineStyle: { color: palette[0], width: 2 }, itemStyle: { color: palette[0] } }]
  };
  const compareLine: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", formatter: axisComparisonTooltip("人", CURRENT, COMPARE) },
    legend: { data: ["当前期", "对比期"], bottom: 0, textStyle: { color: "#5e6673" } },
    xAxis: { type: "category", data: DATES, boundaryGap: false },
    series: [
      { name: "当前期", type: "line", data: CURRENT, connectNulls: false, symbol: "circle", symbolSize: 7, lineStyle: { color: palette[0], width: 2 }, itemStyle: { color: palette[0] } },
      { name: "对比期", type: "line", data: COMPARE, symbol: "emptyCircle", symbolSize: 7, lineStyle: { color: "#7186b7", width: 1.5, type: "dashed" }, itemStyle: { color: "#7186b7" } }
    ]
  };
  const seriesData = [
    { name: "Android DAU", values: [102220, 104680, 0, 108410, null, 112730, 119880] },
    { name: "iOS DAU", values: [42100, 43840, 44720, 45600, 46190, 47200, 48620] },
    { name: "Web DAU", values: [24100, 24340, 24760, 25210, 25700, 25990, 25819] }
  ];
  const multiLine: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", order: "seriesAsc", axisPointer: { type: "line" }, valueFormatter: (value: any) => formatNumber(value, "人") },
    legend: { type: "scroll", data: seriesData.map((series) => series.name), bottom: 0, textStyle: { color: "#5e6673" } },
    xAxis: { type: "category", data: DATES.map(actualDate), boundaryGap: false, axisLabel: { formatter: (date: string) => date.slice(5) } },
    series: seriesData.map((series, index) => ({ name: series.name, type: "line", data: series.values, connectNulls: false, symbol: ["circle", "emptyCircle", "diamond"][index], symbolSize: 7, lineStyle: { color: palette[index], width: 2, type: index === 1 ? "dashed" : index === 2 ? "dotted" : "solid" }, itemStyle: { color: palette[index] }, emphasis: { focus: "series" } }))
  };
  const timeBars = [41620, 43810, 0, 45670, 46920, 47880, 46626];
  const verticalBar: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", formatter: axisComparisonTooltip("人", timeBars) },
    xAxis: { type: "category", data: DATES },
    series: [{ name: "新增用户数", type: "bar", data: timeBars, barMaxWidth: 34, itemStyle: { color: palette[0], borderRadius: [3, 3, 0, 0] } }]
  };
  const groupCurrent = [102220, 48620, 25819];
  const groupCompare = [96410, 47200, 24980];
  const groupedBar: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", formatter: (params: any[]) => {
      const index = Number(params?.[0]?.dataIndex ?? 0);
      return `${["Android", "iOS", "Web"][index]}<br/>${comparisonTooltip({ currentDate: "2026-09-08", currentValue: groupCurrent[index], comparisonDate: "2026-09-01", comparisonValue: groupCompare[index], unit: "人" })}`;
    } },
    legend: { data: ["当前期", "对比期"], bottom: 0 },
    xAxis: { type: "category", data: ["Android", "iOS", "Web"] },
    series: [
      { name: "当前期", type: "bar", data: groupCurrent, barMaxWidth: 30, itemStyle: { color: palette[0], borderRadius: [3, 3, 0, 0] } },
      { name: "对比期", type: "bar", data: groupCompare, barMaxWidth: 30, itemStyle: { color: "#9bacd2", borderRadius: [3, 3, 0, 0] } }
    ]
  };
  const rankValues = [58120, 52440, 48980, 44120, 39840, 36210, 33840, 29480, 27100, 24620, 21760, 19420];
  const horizontalRank: ChartOption = {
    animation: false,
    grid: { left: 14, right: 24, top: 18, bottom: 22, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: categoryTooltip("人") },
    xAxis: { type: "value", axisLabel: { color: "#6b7280", fontSize: 11 }, splitLine: { lineStyle: { color: "#edf0f4" } } },
    yAxis: { type: "category", inverse: true, data: PLATFORM_NAMES, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: "#5e6673", width: 150, overflow: "truncate", fontSize: 11 } },
    series: [{ name: "活跃用户", type: "bar", data: rankValues, barMaxWidth: 18, itemStyle: { color: palette[0], borderRadius: [0, 3, 3, 0] } }]
  };
  const stackCategories = ["自然新增", "内部导量", "广告投放", "其他新增"];
  const stacked: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (params: any[]) => {
      const items = Array.isArray(params) ? params : [params];
      return stackedTooltip(
        "2026-09-08",
        items[0]?.axisValue ?? "未知",
        items.map((item) => ({ name: item.seriesName, value: item.value })),
        "人"
      );
    } },
    legend: { data: ["Android", "iOS", "Web"], bottom: 0 },
    xAxis: { type: "category", data: stackCategories },
    series: [
      { name: "Android", type: "bar", stack: "user", data: [18240, 12820, 9840, 24800], itemStyle: { color: palette[0] } },
      { name: "iOS", type: "bar", stack: "user", data: [14920, 9360, 7400, 19640], itemStyle: { color: palette[1] } },
      { name: "Web", type: "bar", stack: "user", data: [6210, 4280, 5180, 12240], itemStyle: { color: palette[2] } }
    ]
  };
  const pieData = [{ value: 119880, name: "Android" }, { value: 48620, name: "iOS" }, { value: 25819, name: "Web" }];
  const pie: ChartOption = {
    animation: false,
    tooltip: { trigger: "item", formatter: (params: any) => structureTooltip("端别", params?.name, params?.value, "人", Number(params?.percent ?? 0)) },
    legend: { orient: "horizontal", left: "center", bottom: 0, textStyle: { color: "#5e6673" } },
    series: [{ name: "端别用户结构", type: "pie", radius: "58%", center: ["50%", "43%"], data: pieData, label: { formatter: "{b}\n{d}%", color: "#5e6673" }, itemStyle: { borderColor: "#fff", borderWidth: 2 } }]
  };
  const donut: ChartOption = {
    animation: false,
    tooltip: { trigger: "item", formatter: (params: any) => structureTooltip("用户类型", params?.name, params?.value, "人", Number(params?.percent ?? 0)) },
    legend: { orient: "horizontal", left: "center", bottom: 0, textStyle: { color: "#5e6673" } },
    series: [{ name: "新老用户结构", type: "pie", radius: ["38%", "60%"], center: ["50%", "43%"], data: [{ value: 46626, name: "新用户" }, { value: 147693, name: "老用户" }], label: { formatter: "{b}\n{d}%", color: "#5e6673" }, itemStyle: { borderColor: "#fff", borderWidth: 2 } }]
  };
  const funnelStages = [
    { value: 120000, name: "访问", medianHours: "起点" },
    { value: 62400, name: "下载", medianHours: "1.6 小时" },
    { value: 37440, name: "注册", medianHours: "3.2 小时" },
    { value: 24680, name: "首日活跃", medianHours: "8.4 小时" }
  ];
  const funnel: ChartOption = {
    animation: false,
    tooltip: { trigger: "item", formatter: (params: any) => {
      const index = Math.max(0, funnelStages.findIndex((stage) => stage.name === params?.name));
      const stage = funnelStages[index];
      if (index === 0) return funnelTooltip({ dateRange: "2026-09-02 至 2026-09-08", stageName: stage.name, stageValue: stage.value });
      const previous = funnelStages[index - 1];
      return funnelTooltip({
        dateRange: "2026-09-02 至 2026-09-08",
        stageName: stage.name,
        stageValue: stage.value,
        adjacentRate: stage.value / previous.value * 100,
        loss: previous.value - stage.value,
        overallRate: stage.value / funnelStages[0].value * 100,
        medianHours: stage.medianHours
      });
    } },
    series: [{ name: "注册转化漏斗", type: "funnel", left: "10%", top: 12, bottom: 18, width: "80%", min: 0, max: 120000, minSize: "20%", maxSize: "100%", sort: "descending", gap: 3, label: { show: true, position: "inside", formatter: (params: any) => `${params?.name ?? "未知步骤"}  ${Number(params?.value ?? 0).toLocaleString()}`, color: "#fff" }, data: funnelStages }]
  };
  const latencyBuckets = [
    ["≤0.5s", 12420], ["0.5–1s", 28110], ["1–1.5s", 21840], ["1.5–2s", 13220], ["2–3s", 6840], [">3s", 2940]
  ] as const;
  const latency: ChartOption = {
    ...commonCartesian(),
    tooltip: { trigger: "axis", formatter: (params: any[]) => latencyTooltip("2026-09-08", params?.[0]?.name, params?.[0]?.value) },
    xAxis: { type: "category", data: latencyBuckets.map(([label]) => label) },
    series: [{ name: "首帧样本数", type: "bar", data: latencyBuckets.map(([, value]) => value), barMaxWidth: 42, itemStyle: { color: palette[2], borderRadius: [3, 3, 0, 0] } }]
  };
  return { singleLine, compareLine, multiLine, verticalBar, groupedBar, horizontalRank, stacked, pie, donut, funnel, latency, rankValues, pieData, latencyBuckets };
}

function V1ChartStatesFixture() {
  const [mode, setMode] = useState<PreviewMode>("charts");
  const options = useMemo(buildOptions, []);
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const currentRows = DATES.map((date, index) => [actualDate(date), CURRENT[index] === null ? "—" : CURRENT[index]!.toLocaleString(), CURRENT[index] === null ? "缺失" : CURRENT[index] === 0 ? "真实 0" : "可用"]);
  const comparisonRows = DATES.map((date, index) => [actualDate(date), CURRENT[index] === null ? "—" : CURRENT[index]!.toLocaleString(), actualDate(COMPARE_DATES[index]), COMPARE[index].toLocaleString(), <DifferenceValue value={CURRENT[index] === null ? null : CURRENT[index]! - COMPARE[index]} />, CURRENT[index] === null ? "缺失" : CURRENT[index] === 0 ? "真实 0" : "可用"]);

  return <div className="v2-page v1-gallery" data-page="v1-chart-states-fixture" data-preview-marker="V1_CHART_STATES_PREVIEW_MARKER">
    <section className="v1-gallery__gate" aria-label="开发体验页说明">
      <div><span>仅开发环境</span><b>V1 图表与状态体验页</b><p>固定视觉样例，不接 API、不保存、不代表真实业务结果。</p></div>
      <div role="group" aria-label="体验内容">
        <a href="?design=core-overview">核心总览</a>
        <button type="button" className={mode === "charts" ? "is-active" : ""} aria-pressed={mode === "charts"} onClick={() => setMode("charts")}>图表全集</button>
        <button type="button" className={mode === "states" ? "is-active" : ""} aria-pressed={mode === "states"} onClick={() => setMode("states")}>状态与边界</button>
      </div>
    </section>

    <header className="v1-gallery__head">
      <div><span className="v2-eyebrow">设计与交互校准工具</span><h1>V1 图表与状态体验</h1><p>一次确认 V1 共用图形、专用分析样式、表格和异常状态；核心经营总览仍只放业务需要的图表。</p></div>
      <aside><CheckCircle2 aria-hidden="true" /><span><b>本页不进入产品导航</b><small>高级图表和未确认类型不在本期范围</small></span></aside>
    </header>

    {mode === "charts" && <nav className="v1-gallery__jump" aria-label="体验页快速定位">
      <button type="button" onClick={() => jumpTo("v1-kpi-compact")}>指标卡 2</button><button type="button" onClick={() => jumpTo("v1-lines")}>折线 4</button><button type="button" onClick={() => jumpTo("v1-bars")}>柱状 4</button><button type="button" onClick={() => jumpTo("v1-structure")}>结构 2</button><button type="button" onClick={() => jumpTo("v1-tables")}>表格 2</button><button type="button" onClick={() => jumpTo("v1-special")}>专用分析 3</button>
    </nav>}

    {mode === "charts" ? <>
    <div id="v1-kpi-compact"><CompactKpis /></div>
    <DetailedKpi />

    <section id="v1-lines" className="v1-gallery__section" aria-labelledby="v1-lines-title">
      <header><div><h2 id="v1-lines-title">折线图</h2><p>按实际日期展示趋势；缺失断线，真实 0 落在 0 轴，不互相替代。</p></div></header>
      <div className="v1-gallery__grid">
        <ChartPanel kind="line-single" title="单系列趋势" meta="日活跃用户数 · 按日 · 大盘整体" note="09-04 为真实 0，09-06 缺失并断线。" option={options.singleLine} columns={["实际日期", "当前值（人）", "状态"]} rows={currentRows} />
        <ChartPanel kind="line-comparison" title="当前期与对比期" meta="日活跃用户数 · 上一等长周期" note="实线代表当前期，虚线代表对比期；悬停或键盘聚焦样例点可查看实际日期、两期值与差值。" columns={["当前期日期", "当前期（人）", "对比期日期", "对比期（人）", "差值（人）", "状态"]} rows={comparisonRows}>
          <div className="v1-gallery__chart-wrap">
            <Chart option={options.compareLine} theme="v13" ariaLabel="日活跃用户数当前期与上一等长周期对比折线，固定视觉样例" style={{ height: 264 }} />
            <button type="button" className="v1-gallery__comparison-point" aria-label="查看 2026-09-05 当前期与 2026-08-29 对比期数据" aria-describedby="v1-gallery-comparison-tooltip">
              <span id="v1-gallery-comparison-tooltip" role="tooltip"><em>当前期 2026-09-05 · 176,540 人</em><em>对比期 2026-08-29 · 171,320 人</em><em>较对比期 <ChangeValue direction="up" onEmphasis>+5,220 人</ChangeValue></em></span>
            </button>
          </div>
        </ChartPanel>
        <ChartPanel kind="line-multi" title="同单位多系列趋势" meta="端别 DAU · 3 个系列 · 单位均为人" note="系列用颜色、线型、点型和文字图例共同区分；Android 的缺失点保持断线。" option={options.multiLine} columns={["实际日期", "Android DAU", "iOS DAU", "Web DAU", "状态"]} rows={DATES.map((date, index) => [actualDate(date), [102220, 104680, 0, 108410, null, 112730, 119880][index] ?? "—", [42100, 43840, 44720, 45600, 46190, 47200, 48620][index], [24100, 24340, 24760, 25210, 25700, 25990, 25819][index], index === 4 ? "Android 缺失" : index === 2 ? "含真实 0" : "可用"])} />
        <MultiPidTrend />
      </div>
    </section>

    <section id="v1-bars" className="v1-gallery__section" aria-labelledby="v1-bars-title">
      <header><div><h2 id="v1-bars-title">柱状图</h2><p>时间变化、周期对比、分类排行和可加总结构分别使用对应变体。</p></div></header>
      <div className="v1-gallery__grid">
        <ChartPanel kind="bar-time" title="时间纵向柱" meta="新增用户数 · 独立日期数量比较" note="用于离散日期量级比较；增长趋势默认折线，真实 0 保留为 0 高度并由表格与悬停说明。" option={options.verticalBar} columns={["实际日期", "新增用户数", "状态"]} rows={DATES.map((date, index) => [actualDate(date), [41620, 43810, 0, 45670, 46920, 47880, 46626][index], index === 2 ? "真实 0" : "可用"])} />
        <ChartPanel kind="bar-comparison" title="当前与对比并列柱" meta="端别 DAU · 当前日 2026-09-08 vs 上周同日 2026-09-01" note="只在同口径、同单位下并列；不做任意双轴。" option={options.groupedBar} columns={["端别", "当前期 2026-09-08（人）", "对比期 2026-09-01（人）", "差值（人）"]} rows={[["Android", "102,220", "96,410", <DifferenceValue value={5810} />], ["iOS", "48,620", "47,200", <DifferenceValue value={1420} />], ["Web", "25,819", "24,980", <DifferenceValue value={839} />]]} />
        <ChartPanel kind="bar-horizontal-ranking" title="长名称与多分类横向排行" meta="活跃用户 Top12 · 表格保留全集" note="图形对高基数做 TopN 收敛，完整长名称和全部分类仍在同口径表格中。" option={options.horizontalRank} height={390} columns={["排名", "完整分类名称", "活跃用户（人）", "状态"]} rows={[...PLATFORM_NAMES, "Android · 其他渠道（完整表保留）", "iOS · 其他渠道（完整表保留）"].map((name, index) => [index + 1, name, (options.rankValues[index] ?? 16840 - index * 410).toLocaleString(), "可用"])} />
        <ChartPanel kind="bar-stacked" title="合法堆叠柱" meta="新增来源 × 互斥端别 · 可加总用户数" note="仅端别互斥且各段可加总时堆叠；比例、不同单位或重叠人群不得套用。" option={options.stacked} columns={["来源", "Android", "iOS", "Web", "合计"]} rows={[["自然新增", 18240, 14920, 6210, 39370], ["内部导量", 12820, 9360, 4280, 26460], ["广告投放", 9840, 7400, 5180, 22420], ["其他新增", 24800, 19640, 12240, 56680]]} />
      </div>
    </section>

    <section id="v1-structure" className="v1-gallery__section" aria-labelledby="v1-structure-title">
      <header><div><h2 id="v1-structure-title">结构占比</h2><p>只有整体明确、分类互斥且能完整加总为 100% 时使用饼图或环形图。</p></div></header>
      <div className="v1-gallery__grid">
        <ChartPanel kind="pie" title="饼图 · 端别结构" meta="数据日 2026-09-08 · 整体 194,319 人" note="低基数完整展示；不得用于高基数排行。" option={options.pie} columns={["互斥端别", "用户数", "占比"]} rows={[["Android", "119,880", "61.69%"], ["iOS", "48,620", "25.02%"], ["Web", "25,819", "13.29%"]]} />
        <ChartPanel kind="donut" title="环形图 · 新老结构" meta="数据日 2026-09-08 · 整体 194,319 人" note="环形中心留白用于表达整体语义，不额外堆装饰数字。" option={options.donut} columns={["互斥用户类型", "用户数", "占比"]} rows={[["新用户", "46,626", "24.00%"], ["老用户", "147,693", "76.00%"]]} />
      </div>
    </section>

    <section id="v1-tables" className="v1-gallery__section" aria-labelledby="v1-tables-title">
      <header><div><h2 id="v1-tables-title">表格</h2><p>普通聚合用于逐对象扫数，二维交叉用于两个稳定维度的组合分析。</p></div></header>
      <div className="v1-gallery__grid">
        <article className="v1-gallery__panel ui-chart-surface" data-chart-kind="table-aggregate"><header className="v1-gallery__panel-head"><div><h3>普通聚合表</h3><p>平台经营摘要 · 数据日 2026-09-08</p></div><span className="ui-status ui-status--neutral">全集</span></header><SnapshotTable caption="平台经营聚合结果" columns={["业务平台", "DAU", "新增", "观影率", "数据状态"]} rows={[["TikTok", "182,744", "41,205", "76.43%", "完整"], ["Pornhub", "194,319", "46,626", "78.13%", "完整"], ["XHamster", "131,508", "29,480", "77.04%", "部分"], ["超长业务平台名称用于验证列宽与换行", "96,315", "21,906", "—", "无记录"]]} /></article>
        <DashboardPanel className="v1-gallery__panel" chartKind="table-crosstab" title="二维交叉表" note="端别 × 用户来源 · 当前日新增用户数" tools={<SnapshotExport caption="端别与用户来源交叉结果" />}><PivotTable label="端别与用户来源交叉结果" rowHeading="端别 × 来源" columns={["自然新增", "内部导量", "广告投放"]} rows={[{ key: "android", label: "Android", values: ["18,240", "12,820", "9,840"], total: "40,900" }, { key: "ios", label: "iOS", values: ["14,920", "9,360", "7,400"], total: "31,680" }, { key: "web", label: "Web", values: ["6,210", "4,280", "5,180"], total: "15,670" }]} totals={{ key: "total", label: "合计", values: ["39,370", "26,460", "22,420"], total: "88,250" }} /></DashboardPanel>
      </div>
    </section>

    <CardModeExample />
    <GroupedTrendExample />
    <CommerceChartExamples />
    <section id="v1-special" className="v1-gallery__section" aria-labelledby="v1-special-title">
      <header><div><h2 id="v1-special-title">专用分析样式</h2><a href="/analysis/funnels?design=personal-workspace">体验有序漏斗配置与查询</a><a href="/analysis/events?design=personal-workspace">体验事件分析与饼图切换</a><p>真实漏斗、留存矩阵和耗时分布有自己的输入、状态与结果语义，不进入通用图表切换器。</p></div></header>
      <div className="v1-gallery__grid">
        <ChartPanel kind="funnel-real" title="真实转化漏斗" meta="同一用户 · 有序步骤 · 7 日转化窗口" note="只有身份归一、步骤顺序和窗口均可证明时才称漏斗；阶段量拼接不能替代。" option={options.funnel} columns={["步骤", "同一用户数", "上一步转化", "总体转化"]} rows={[["访问", "120,000", "100%", "100%"], ["下载", "62,400", "52.00%", "52.00%"], ["注册", "37,440", "60.00%", "31.20%"], ["首日活跃", "24,680", "65.92%", "20.57%"]]} />
        <RetentionChartExample />
        <ChartPanel kind="latency-distribution" title="首帧耗时分布" meta="分布容器视觉确认" note="权威源尚未确认稳定分位输出；本样例只确认耗时分布容器，不把平均值或 0 ms 当成 P50 / P90 / P95。" option={options.latency} columns={["首帧耗时桶", "样本数（次）", "状态"]} rows={options.latencyBuckets.map(([bucket, count]) => [bucket, count.toLocaleString(), "视觉样例"])} />
      </div>
    </section>

    </> : <StateExamples />}

    <footer className="v1-gallery__footer"><Info aria-hidden="true" /><p><b>体验边界</b>：面积、散点、气泡、雷达、仪表盘、地图和任意双轴不进入 V1。阶段关系卡已在核心经营总览样板中验证；漏斗转化趋势和 用户留存趋势复用本页已验证的折线基线。正式页面只按业务任务选用需要的类型，不把本页当组件展厅直接复制。</p></footer>
  </div>;
}

export default V1ChartStatesFixture;
