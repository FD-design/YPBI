import { ReviewTools } from "../components/ReviewTools";
import { createContext, useContext } from "react";
import { readPreviewQuery } from "./preview-query";
import { usePreviewQuery } from "./usePreviewQuery";
import { coreDailyCards, corePeriodMetric } from "./core-period-preview";
import { parseExtendedView, extendedBoardHref } from "./extended-board-view";
import { previewFavorites, setPreviewFavorite } from "./preview-favorites";
import { downloadPreviewWorkbook, type WorkbookSheet } from "./preview-workbook";
import { metricRows } from "./topic-preview-export";
import { DETAIL_COLUMNS, DETAIL_ROWS, detailColumnKey, operatingDetailRows, operatingSummaryModels, operatingDetailExportRows, operatingValueLabel, selectOperatingRows, operatingDetailBreakdown, type DetailRow, type DetailColumn } from "./operating-detail-snapshot";
import { retentionTargetDate } from "./operating-detail-snapshot";
import { operatingColumnDocumentation, summaryColumn } from "./operating-detail-columns";
import { MetricBreakdown } from "../features/dashboards/MetricBreakdown";
import { OPERATING_BREAKDOWNS, operatingDimensionLabel } from "./operating-breakdown-preview";
import { acquisitionWorkbook } from "./acquisition-export";
import { DashboardHeader, DashboardSectionHeading } from "../features/dashboards/DashboardPresentation";
import { DashboardActions, DashboardQueryFields } from "../features/dashboards/DashboardToolbar";
import { Toast, useToast } from "../../components/ui/Toast";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronRight,
  Copy,
  Info,
  RefreshCw,
  Star
} from "lucide-react";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { FloatingHint, restoreReadingFocus } from "../../components/ui/FloatingHint";
import { MetricReadingDialog } from "../features/dashboards/MetricReadingDialog";
import { LiveSeriesDetails } from "../features/dashboards/ConnectedMetricCard";
import { ComparisonDetails } from "../features/dashboards/ComparisonDetails";
import { metricHeadingUnit } from "../../components/metric-unit";
import { ChangeValue } from "../../components/ui/ChangeValue";
import { changeDirection } from "../../components/ui/change-presentation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { DashboardMetricCard } from "../features/dashboards/DashboardMetricCard";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import { detailChange, formatDetailValue, type DetailValueKind } from "./operating-detail-presentation";
import type { DashboardMetricComparison } from "../features/dashboards/dashboard-metric-card-model";
import {
  coreOverviewDesignCardModels,
  coreOverviewDesignMetricAuthority,
  type CoreOverviewDesignMode
} from "./core-overview-contract-fixture";
import "./core-overview-design-fixture.css";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { AdvertisingOverview, advertisingSheet } from "./AdvertisingOverview";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { liveMetricModel, useLiveDashboard } from "../features/dashboards/LiveDashboardContext";
import { useOperatingLive } from "./useOperatingLive";
import { operatingLiveSummary, operatingLiveExportRows, operatingLiveCalculationRows, OPERATING_LIVE_IDS } from "./operating-live-model";

type ComparisonMode = "previous" | "week" | "month" | "year" | "none";

interface DateRangeValue {
  start: string;
  end: string;
}

interface FilterState extends DateRangeValue {
  scope: string;
  comparison: ComparisonMode;
}


type DesignMetricAuthority = ReturnType<typeof coreOverviewDesignMetricAuthority>;

type ChainKey = "content" | "acquisition" | "payment";

interface ChainMetricValue {
  metric: DesignMetricAuthority;
  note?: string;
}

interface ChainPanel {
  key: ChainKey;
  title: string;
  note: string;
  stages: ChainMetricValue[];
  relations: ChainMetricValue[];
  diagnostics?: ChainMetricValue[];
}

const MAX_COMPLETE_DATE = "2026-09-08";
const INITIAL_FILTERS: FilterState = {
  scope: "all",
  comparison: "none",
  start: "2026-09-02",
  end: MAX_COMPLETE_DATE
};


const CHAIN_PANELS: ChainPanel[] = [
  {
    key: "content",
    title: "内容消费",
    note: "查看活跃、观影与有效观看规模；各项按自身统计规则计算。",
    stages: [
      { metric: coreOverviewDesignMetricAuthority("M016") },
      { metric: coreOverviewDesignMetricAuthority("M026") },
      { metric: coreOverviewDesignMetricAuthority("M035") }
    ],
    relations: [
      { metric: coreOverviewDesignMetricAuthority("M081"), note: "日活跃用户到观影用户" }
    ]
  },
  {
    key: "acquisition",
    title: "获客转化",
    note: "访问与下载展示次数，注册展示人数；转化率的分母详见各项说明。",
    stages: [
      { metric: coreOverviewDesignMetricAuthority("M001") },
      { metric: coreOverviewDesignMetricAuthority("M003") },
      { metric: coreOverviewDesignMetricAuthority("M008") }
    ],
    relations: [
      { metric: coreOverviewDesignMetricAuthority("M005"), note: "次数口径" },
      { metric: coreOverviewDesignMetricAuthority("M006"), note: "分母按 IP·天统计 · 趋势参考" },
      { metric: coreOverviewDesignMetricAuthority("M007"), note: "分母按 IP·天统计 · 趋势参考" }
    ]
  },
  {
    key: "payment",
    title: "支付链路",
    note: "从支付提交查看充值到账结果，下方环节指标用于定位转化变化。",
    stages: [
      { metric: coreOverviewDesignMetricAuthority("M084") },
      { metric: coreOverviewDesignMetricAuthority("M086") }
    ],
    relations: [
      { metric: coreOverviewDesignMetricAuthority("M090"), note: "主链转化" }
    ],
    diagnostics: [
      { metric: coreOverviewDesignMetricAuthority("M070") },
      { metric: coreOverviewDesignMetricAuthority("M071") },
      { metric: coreOverviewDesignMetricAuthority("M072") }
    ]
  }
];


const LAUNCH_SUCCESS_RATE = coreOverviewDesignMetricAuthority("M080");
const PLAY_SUCCESS_RATE = coreOverviewDesignMetricAuthority("M031");

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC"
});



function parseBusinessDate(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function businessDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftBusinessDate(value: string, offset: number) {
  const date = parseBusinessDate(value);
  date.setUTCDate(date.getUTCDate() + offset);
  return businessDate(date);
}

function dateLabel(value: string) {
  return DATE_FORMATTER.format(parseBusinessDate(value)).replaceAll("/", ".");
}

function dateRangeLabel(value: DateRangeValue) {
  return `${dateLabel(value.start)} — ${dateLabel(value.end)}`;
}

function sameFilters(left: FilterState, right: FilterState) {
  return left.scope === right.scope
    && left.comparison === right.comparison
    && left.start === right.start
    && left.end === right.end;
}

function comparisonLabel(value: ComparisonMode) {
  return {
    previous: "上一等长周期",
    week: "上周同期",
    month: "上月同期",
    year: "去年同期",
    none: "不对比"
  }[value];
}

function scopeLabel(value: string) {
  return {
    all: "大盘整体",
    PH: "PH · Pornhub",
    TT: "TT · TikTok",
    XH: "XH · XHamster",
    XN: "XN · XNXX"
  }[value] ?? value;
}

function IconAction({ label, children, onClick }: {
  label: string;
  children: ReactNode;
  onClick: () => void;
}) {
  const tooltipId = `core-action-${useId().replaceAll(":", "")}`;
  return <button
    type="button"
    className="ui-icon-button core-review__icon-action"
    aria-label={label}
    aria-describedby={tooltipId}
    onClick={onClick}
  >
    {children}
    <span id={tooltipId} role="tooltip">{label}</span>
  </button>;
}

function MetricDefinitionLabel({ metric, onOpen, dimensionLabel }: {
  metric: DesignMetricAuthority;
  onOpen: (metric: DesignMetricAuthority) => void;
  dimensionLabel?: string;
}) {
  return <FloatingHint className="core-review__metric-help" content={metric.definition}>
    <button
      type="button"
      aria-label={`查看${metric.name}说明`}
      onClick={() => onOpen(metric)}
    >
      <span>{dimensionLabel ? <>{metric.name.slice(0, -(dimensionLabel.length + 2))}<span className="core-review__column-slice">（{dimensionLabel}）</span></> : metric.name}</span><Info aria-hidden="true" />
    </button>
  </FloatingHint>;
}

// Additional DEV comparison snapshots; never used by the production query adapter.
const CorePeriod = createContext({ range: INITIAL_FILTERS, compared: false });
function ChainSummary({ item, showComparison, onOpenDefinition, supporting = false }: {
 item: ChainMetricValue; showComparison: boolean; onOpenDefinition: (metric: DesignMetricAuthority) => void; supporting?: boolean;
}) {
 const { range } = useContext(CorePeriod), original = corePeriodMetric(item.metric.id, range, showComparison), live = useLiveDashboard();
 const [reading, setReading] = useState(false);
 const connected = live?.metricIds.includes(item.metric.id), model = connected ? liveMetricModel(original, live!) : original, result = model.result;
 const series = live?.state.status === "success" ? live.state.data.data.series.find(series => series.metric.id === item.metric.id) : undefined;
 return <DataOriginProvider value={connected ? "pending" : "demo"}><MetricSummary title={<><MetricDefinitionLabel metric={item.metric} onOpen={connected ? () => setReading(true) : onOpenDefinition} /> <DataOriginBadge /></>} context={connected ? `${live!.query.dateRange[1]} · ${live!.platformName}` : undefined} value={result.status === "available" ? result.value.display : "—"} unit={result.status === "available" ? result.value.unit : undefined} size={supporting ? "supporting" : "standard"} comparison={result.status === "available" ? result.comparison : null} note={result.status === "available" ? item.note : result.label ?? result.message} />
   {reading && <MetricReadingDialog title={item.metric.name} onClose={() => setReading(false)} content={series && live?.state.status === "success" ? <LiveSeriesDetails series={series} result={live.state.data}/> : <p>当前真实查询尚无可用结果，请重试读取。</p>} />}
 </DataOriginProvider>;
}

function ChainMetricList({ label, metrics, onOpenDefinition, diagnostic = false, showComparison }: {
  label: string;
  metrics: ChainMetricValue[];
  onOpenDefinition: (metric: DesignMetricAuthority) => void;
  diagnostic?: boolean;
  showComparison: boolean;
}) {
  return <section
    className={`core-review__chain-metrics${diagnostic ? " is-diagnostic" : ""}`}
    data-chain-part={diagnostic ? "diagnostics" : "relationships"}
    aria-label={label}
  >
    {diagnostic && <header><b>{label}</b><span>用于定位转化变化</span></header>}
    <ul>
      {metrics.map((item) => <li key={item.metric.id} data-chain-item={diagnostic ? "diagnostic" : "relationship"}>
        <ChainSummary item={item} showComparison={showComparison} onOpenDefinition={onOpenDefinition} supporting />
      </li>)}
    </ul>
  </section>;
}

function ChainCard({ panel, hidden, onOpenDefinition, showComparison }: {
  panel: ChainPanel;
  hidden: boolean;
  showComparison: boolean;
  onOpenDefinition: (metric: DesignMetricAuthority) => void;
}) {
  return <article
    id={`core-chain-panel-${panel.key}`}
    className="core-review__chain-card"
    role="tabpanel"
    aria-labelledby={`core-chain-tab-${panel.key}`}
    hidden={hidden}
    tabIndex={hidden ? -1 : 0}
  >
    <p className="core-review__chain-context">{panel.note}</p>
    <ol data-chain-part="stages" aria-label={`${panel.title}阶段指标`}>
      {panel.stages.map((stage) => <li key={stage.metric.id}>
        <ChainSummary item={stage} showComparison={showComparison} onOpenDefinition={onOpenDefinition} />
      </li>)}
    </ol>
    <ChainMetricList label="转化表现" metrics={panel.relations} onOpenDefinition={onOpenDefinition} showComparison={showComparison} />
    {panel.diagnostics && <ChainMetricList
      label="诊断指标"
      metrics={panel.diagnostics}
      onOpenDefinition={onOpenDefinition}
      diagnostic
      showComparison={showComparison}
    />}
  </article>;
}

type DetailComparisonMode = "none" | "previousDay" | "previousWeek";
interface SelectedDetail { row: DetailRow; column: DetailColumn; columnIndex: number; trigger: HTMLButtonElement; }

function DetailMetricCell({ row, column, columnIndex, currentDate, previousDate, previousWeekDate, comparisonMode, onOpen }: {
  row: DetailRow;
  column: DetailColumn;
  columnIndex: number;
  previousDate: string;
  previousWeekDate: string;
  currentDate: string;
  comparisonMode: DetailComparisonMode;
  onOpen: (detail: SelectedDetail) => void;
}) {
  const value = row.values[columnIndex];
  const previousChange = detailChange(value.current, value.previousDay, column.kind);
  const weekChange = detailChange(value.current, value.previousWeek, column.kind);
  const currentLabel = operatingValueLabel(value, column);
  const previousLabel = formatDetailValue(value.previousDay, column.kind, true, column.unit);
  const weekLabel = formatDetailValue(value.previousWeek, column.kind, true, column.unit);
  const explanation = `${row.name} · ${column.metric.name}：当前 ${currentLabel}；昨日 ${dateLabel(previousDate)} 为 ${previousLabel}${previousChange ? `，${previousChange.display}` : ""}；上周同日 ${dateLabel(previousWeekDate)} 为 ${weekLabel}${weekChange ? `，${weekChange.display}` : ""}。`;
  const selectedChange = comparisonMode === "previousDay" ? previousChange : weekChange;

  const tooltip = value.state === "unsupported" ? <p>{column.pendingReason}</p> : <div className="core-review__detail-tooltip">
    <b className="core-review__tip-title">{row.name} · {column.metric.name}</b>
    <div className="core-review__tip-current"><small>{currentDate}</small><strong>{currentLabel}</strong></div>
    {column.periodDays && <p>注册日 {currentDate} · 目标日 {retentionTargetDate(column, currentDate)}</p>}
    <DetailComparisonLines current={value.current} baseline={value.previousDay} kind={column.kind} unit={column.unit} label="较昨日" date={previousDate} onEmphasis />
    <DetailComparisonLines current={value.current} baseline={value.previousWeek} kind={column.kind} unit={column.unit} label="较上周同日" date={previousWeekDate} onEmphasis />
  </div>;
  return <td className="is-number" data-column-key={detailColumnKey(column)}><FloatingHint className="core-review__cell-hint" content={tooltip}>
    <button type="button" className="core-review__detail-trigger" aria-label={explanation} onClick={(event) => onOpen({ row, column, columnIndex, trigger: event.currentTarget })}>
      <b className={value.state ? "is-unavailable" : undefined}>{currentLabel}</b>
      {comparisonMode !== "none" && value.state !== "unsupported" && <small className="core-review__selected-change ui-metric-comparison"><ChangeValue direction={selectedChange?.direction ?? null}>{selectedChange?.display ?? "不可比"}</ChangeValue></small>}
    </button>
  </FloatingHint></td>;
}

function DetailComparisonLines({ current, baseline, kind, unit, label, date, onEmphasis = false }: {
  current: number | null; baseline: number | null; kind: DetailValueKind; unit?: string; label: string; date: string; onEmphasis?: boolean;
}) {
  const change = detailChange(current, baseline, kind);
  const difference = current === null || baseline === null ? null : current - baseline;
  return <span className="core-review__baseline">
    <span className="core-review__baseline-head"><span>{label}</span><b>{formatDetailValue(baseline, kind, true, unit)}</b></span><small>{date}</small>
    <span><ChangeValue direction={change?.direction ?? null} onEmphasis={onEmphasis}>{change?.display ?? (baseline === 0 && kind !== "ratio" ? "基准为 0，增长率不可比" : "数据不足，不可比")}</ChangeValue>
      {difference !== null && kind !== "ratio" && kind !== "platformRatio" && <span> · 差值 <ChangeValue direction={changeDirection(difference)} onEmphasis={onEmphasis}>{difference > 0 ? "+" : difference < 0 ? "−" : ""}{formatDetailValue(Math.abs(difference), kind, true, unit)}</ChangeValue></span>}</span>
  </span>;
}

function DetailSnapshotDialog({ detail, date, onClose }: { detail: SelectedDetail; date: string; onClose: () => void }) {
  const value = detail.row.values[detail.columnIndex];
  return <MetricReadingDialog title={detail.column.metric.name} onClose={onClose} content={<div className="core-review__snapshot-content">
      <p>{detail.row.name} · {date} · {value.evidence ? "待验数" : "演示数据"}</p>
      <MetricSummary title="当日结果" value={operatingValueLabel(value, detail.column)} />
      {detail.column.sourceLabel && <p>日报原字段：{detail.column.sourceLabel}（{detail.column.sourceColumn} 列） · 单位：{detail.column.unit}</p>}
      {detail.column.periodDays && <p>注册日 {date} · D{detail.column.periodDays} 目标日 {retentionTargetDate(detail.column, date)}。目标日完整观察结束后方可读取留存结果。</p>}
      {detail.column.metric.id === "M018" && <p>自然月 {date.slice(0, 7)} · 数据截至日：待接口返回。月活为月内去重人数，不累加日活。</p>}
      {detail.column.pendingReason ? <p>{detail.column.pendingReason}</p> : <>
      <DetailComparisonLines current={value.current} baseline={value.previousDay} kind={detail.column.kind} unit={detail.column.unit} label="较昨日" date={shiftBusinessDate(date, -1)} />
      <DetailComparisonLines current={value.current} baseline={value.previousWeek} kind={detail.column.kind} unit={detail.column.unit} label="较上周同日" date={shiftBusinessDate(date, -7)} />
      </>}
      <p>{detail.column.metric.definition}</p>
      {value.evidence && <><p>{value.evidence.current.formula}</p><table className="ui-table"><thead><tr><th>日期</th><th>计算输入</th><th>状态</th><th>查询时间</th></tr></thead><tbody>{Object.values(value.evidence).map(evidence => <tr key={evidence.date}><td>{evidence.date}</td><td>{evidence.inputs.map(input => `${input.name} ${input.value ?? "—"} ${input.unit}`).join(" / ")}</td><td>{evidence.label}{evidence.stale ? " · 上次查询结果" : ""}</td><td>{evidence.fetchedAt ?? "—"}</td></tr>)}</tbody></table></>}
    </div>} />;
}

function CoreOverviewDesignFixture() {
  const live = useLiveDashboard();
  const operating = useOperatingLive(live);
  const shared = readPreviewQuery();
  const initialView = parseExtendedView(new URLSearchParams(window.location.search).get("view"));
  const initialFilters: FilterState = { ...(initialView?.range ?? shared.range), scope: "all", comparison: (initialView?.compared ?? shared.compared) ? "previous" : "none" };
  const [mode, setMode] = useState<CoreOverviewDesignMode>(initialView?.mixed ? "mixed" : "normal");
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(initialFilters);
  usePreviewQuery(appliedFilters, appliedFilters.comparison !== "none");
  const [favorite, setFavorite] = useState(() => previewFavorites().includes("5.2"));
  const [recovered, setRecovered] = useState<string[]>([]);
  const { notice, notify: setNotice } = useToast();
  const [reading, setReading] = useState<{ title: string; content: ReactNode } | null>(null);
  const [activeChain, setActiveChain] = useState<ChainKey>("content");
  const [sort, setSort] = useState({ columnIndex: 0, direction: "desc" as "asc" | "desc" });
  const [detailComparison, setDetailComparison] = useState<DetailComparisonMode>("none");
  const [detailPlatform, setDetailPlatform] = useState("all");
  const [adAudience,setAdAudience]=useState("all");
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [locatedColumn, setLocatedColumn] = useState("");
  const detailScroll = useRef<HTMLDivElement>(null);
  const locateColumn = (key: string) => {
    setLocatedColumn(key);
    const scroller = detailScroll.current;
    const header = scroller?.querySelector<HTMLElement>(`th[data-column-key="${key}"]`);
    if (!scroller || !header) return;
    const fixedWidth = [...scroller.querySelectorAll("thead th")].slice(0, 2).reduce((total, th) => total + th.getBoundingClientRect().width, 0);
    scroller.scrollTo({ left: Math.max(0, scroller.scrollLeft + header.getBoundingClientRect().left - scroller.getBoundingClientRect().left - fixedWidth - 1) });
  };
  const [breakdownId, setBreakdownId] = useState<string | null>(null);
  useEffect(() => setBreakdownId(null), [detailPlatform, appliedFilters.end]);
  const [selectedDetail, setSelectedDetail] = useState<SelectedDetail | null>(null);
  const metrics = useMemo(() => coreDailyCards(mode, appliedFilters, appliedFilters.comparison !== "none").map(model => recovered.includes(model.metric.id) ? coreDailyCards("normal", appliedFilters, appliedFilters.comparison !== "none").find(item => item.metric.id === model.metric.id)! : model), [appliedFilters, mode, recovered]);
  const hasPendingFilters = !sameFilters(filters, appliedFilters);
  const detailDate = live?.query.dateRange[1] ?? appliedFilters.end;
  const previousDate = shiftBusinessDate(detailDate, -1);
  const previousWeekDate = shiftBusinessDate(detailDate, -7);
  const detailRows = operating.rows ?? operatingDetailRows(detailDate);
  const detailColumns = operating.columns;
  const detailModels = live ? operatingLiveSummary(live, operating.resources, detailRows, detailPlatform) : operatingSummaryModels(detailRows, detailPlatform, detailDate);
  const detailScopeLabel = detailPlatform === "all" ? "全部平台" : detailRows.find(row => row.pid === detailPlatform)?.name ?? "未知平台";
  const sortedRows = useMemo(() => selectOperatingRows(detailRows, detailPlatform).slice().sort((left, right) => {
    const leftValue = left.values[sort.columnIndex]?.current;
    const rightValue = right.values[sort.columnIndex]?.current;
    if (leftValue === null) return rightValue === null ? left.name.localeCompare(right.name) : 1;
    if (rightValue === null) return -1;
    const result = leftValue - rightValue;
    return sort.direction === "asc" ? result : -result;
  }), [sort, detailRows, detailPlatform]);


  const reviewAction = (message: string) => setNotice(message);

  const performCopy = async () => {
    const href = new URL(extendedBoardHref("5.2", { range: { start: appliedFilters.start, end: appliedFilters.end }, compared: appliedFilters.comparison !== "none", mixed: mode === "mixed" }), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(href);
      setNotice("已复制当前视图链接，保留已应用日期与对比条件。");
    } catch {
      setReading({ title: "复制当前视图链接", content: <textarea readOnly aria-label="当前视图链接" value={href} /> });
    }
  };

  const openMetricDefinition = (metric: DesignMetricAuthority) => {
    setReading({ title: `${metric.name} · 指标说明`, content: <p>{metric.definition}</p> });
  };

  const applyFilters = () => {
    setAppliedFilters(filters);
    setSelectedDetail(null);
    setRecovered([]);
    window.history.replaceState(window.history.state, "", extendedBoardHref("5.2", { range: { start: filters.start, end: filters.end }, compared: filters.comparison !== "none", mixed: mode === "mixed" }));
    reviewAction(`已应用样板条件：${scopeLabel(filters.scope)}，${dateRangeLabel(filters)}，${comparisonLabel(filters.comparison)}。`);
  };

  const updateSort = (columnIndex: number) => {
    setSort((current) => current.columnIndex === columnIndex
      ? { columnIndex, direction: current.direction === "desc" ? "asc" : "desc" }
      : { columnIndex, direction: "desc" });
  };

  const navigateChainTabs = (event: ReactKeyboardEvent<HTMLButtonElement>, currentKey: ChainKey) => {
    const currentIndex = CHAIN_PANELS.findIndex((panel) => panel.key === currentKey);
    const requestedIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % CHAIN_PANELS.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + CHAIN_PANELS.length) % CHAIN_PANELS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? CHAIN_PANELS.length - 1
            : -1;
    if (requestedIndex < 0) return;
    event.preventDefault();
    const requested = CHAIN_PANELS[requestedIndex];
    setActiveChain(requested.key);
    window.requestAnimationFrame(() => document.getElementById(`core-chain-tab-${requested.key}`)?.focus());
  };

  const renderMetricCards = (models: typeof metrics, variant: "compact" | "value" = "compact") => models.map((model) => {
    const metricId = model.metric.id;
    const detailConnected = variant === "value" && live && detailPlatform !== "all" && live.metricIds.includes(OPERATING_LIVE_IDS[metricId + ":overall"]);
    return <DataOriginProvider key={metricId} value={detailConnected ? "pending" : "demo"}><DashboardMetricCard
      key={metricId}
      model={model}
      variant={variant}
      onOpenBreakdown={variant === "value" && OPERATING_BREAKDOWNS[metricId] ? () => setBreakdownId(metricId) : undefined}
      breakdownDimensions={operatingDimensionLabel(metricId)}
      analysisHref={`/analysis/metrics/${metricId}`}
      onOpenAnalysis={() => setReading({ title: model.metric.name, content: <><p>{model.metric.definitionLabel}</p><p>{detailConnected ? "当前为同一平台、数据日的真实日汇总，待验数。计算输入见同口径数据表。" : "当前为本地演示数据。真实指标查询与分析跳转尚未接入。"}</p></> })}
      onOpenDefinition={() => setReading({ title: `${model.metric.name} · 指标说明`, content: <><p>{model.metric.definitionLabel}</p>{model.result.status==="available"&&model.result.calculation&&<CalculationEvidence basis={model.result.calculation}/>}</> })}
      onOpenComparison={() => setReading({ title: `${model.metric.name} · 周期对比`, content: model.result.status === "available" && model.result.comparison
        ? <ComparisonDetails comparison={model.result.comparison} onEmphasis={false} />
        : <p>当前条件没有可查看的对比结果。</p> })}
      onOpenTrendPoint={(_, point, series) => setReading({ title: `${model.metric.name} · 趋势详情`, content: <><p>{`${series === "current" ? "当前期" : "对比期"}${point.label} · ${point.actualDate}：${point.value?.display ?? point.stateLabel}。`}</p>{point.calculation&&<CalculationEvidence basis={point.calculation}/>}</> })}
      onRetry={() => setRecovered(ids => [...ids, metricId])}
    /></DataOriginProvider>;
  });

  const exportSheets = (detailOnly = false): WorkbookSheet[] => {
    if (live && detailOnly) return [
      { name: "00_导出说明", rows: [["数据日", detailDate], ["平台", detailScopeLabel], ["来源", "逐字段区分待验数与演示数据"], ["完整性", "未知"], ["数据水位", "未返回"], ["金额", "真实金额采用服务端返回单位，保留接口数值；各列单独标明单位，不跨PID汇总"], ["大盘摘要", detailPlatform === "all" ? "独立演示结果，不相加平台人数" : "同一平台日值"]] },
      { name: "01_经营明细", rows: operatingLiveExportRows(sortedRows, detailColumns, detailDate) },
      { name: "02_数值摘要", rows: metricRows(detailModels, id => detailColumns.find(c => c.metric.id === id && !c.slice)?.unit ?? "人") },
      { name: "03_字段说明", rows: [["指标", "单位", "数据来源", "定义"], ...detailColumns.map(column => [column.metric.name, column.unit, live.metricIds.includes(OPERATING_LIVE_IDS[detailColumnKey(column)]) ? "待验数" : "演示数据", column.metric.definition])] },
      { name: "04_计算输入", rows: operatingLiveCalculationRows(sortedRows, detailColumns) }
    ];
    const wideRows = operatingDetailExportRows(sortedRows, appliedFilters.end);
    const coreUnit = (id: string) => summaryColumn(id)?.unit ?? "人";
    const section = (name: string, ids: string[]): WorkbookSheet => ({ name, rows: metricRows(ids.map(id => corePeriodMetric(id, appliedFilters, appliedFilters.comparison !== "none"))) });
    const metadata: WorkbookSheet = { name: "00_导出说明", rows: [
      ["数据性质", "合成演示数据，非正式业务结果"], ["统计日期", detailOnly ? appliedFilters.end : dateRangeLabel(appliedFilters)],
      ["明细数据日", appliedFilters.end], ["昨日日期", previousDate], ["上周同日日期", previousWeekDate], ["明细业务平台", detailScopeLabel], ["明细范围", "所选范围结束日的单日快照"],
      ["数值单位", "百分比按 0–100 输出；人均广告点击为次/人；ARPU、ARPPU为USD/人；端别比值以iOS为1，其他单位见字段说明"], ["导出范围", "全部已筛选行、73个业务列及10项数值摘要，不受可视区域和卡片收起状态裁剪"],
      ["大盘汇总", "独立查询结果，不对各 PID 人数相加"]
    ] };
    const detail: WorkbookSheet = { name: "01_经营明细", rows: wideRows };
    const states: WorkbookSheet = { name: "99_数据状态与限制", rows: [
      ["正式查询", "尚未接入真实数据和验数"], ["维度结果", "未验证的客户端、新老用户结果留空，数据状态为待接口支持"],
      ["注册留存", "观察尚未结束时数值留空，数据状态为未成熟"],
      ...DETAIL_COLUMNS.filter(column => column.pendingReason).map(column => [column.metric.name, column.pendingReason!]),
      ...metrics.filter(model => model.result.status !== "available").map(model => [model.metric.name, model.result.status])
    ] };
    const fields: WorkbookSheet = { name: "03_字段说明", rows: operatingColumnDocumentation() };
    if (detailOnly) return [metadata, detail, { name: "02_数值摘要", rows: metricRows(detailModels, coreUnit) }, fields, states];
    return [metadata, { name: "01_经营核心", rows: metricRows(metrics, coreUnit) }, { ...detail, name: "02_经营明细" },
      section("03_留存观影", ["M016", "M026", "M102", "M035", "M036", "M020"]),
      section("04_支付", CHAIN_PANELS.find(panel => panel.key === "payment")!.stages.concat(CHAIN_PANELS.find(panel => panel.key === "payment")!.relations, CHAIN_PANELS.find(panel => panel.key === "payment")!.diagnostics ?? []).map(item => item.metric.id)),
      { name: "05_获客渠道", rows: acquisitionWorkbook({ ...appliedFilters, channel: "all", comparison: appliedFilters.comparison === "none" ? "none" : "previous" }, false, [], "growth").find(sheet => sheet.name === "03_增长效果_来源渠道")!.rows }, { ...fields, name: "06_字段说明" }, advertisingSheet(appliedFilters,adAudience,mode==="mixed",appliedFilters.comparison!=="none"), states];
  };

  return <CorePeriod.Provider value={{ range: appliedFilters, compared: appliedFilters.comparison !== "none" }}><div className="v2-page core-review" data-page="core-overview-design-fixture">
    <ReviewTools><section className="core-review__gate" aria-label="设计样板说明">
      <div className="core-review__gate-copy"><span>开发环境设计评审</span><b>固定演示数据，不是正式业务结果，也不接入生产查询。</b></div>
      <div className="core-review__gate-actions">
        <div role="group" aria-label="样板状态">
          <button type="button" className={mode === "normal" ? "is-active" : ""} aria-pressed={mode === "normal"} onClick={() => { setMode("normal"); setRecovered([]); }}>正常态</button>
          <button type="button" className={mode === "mixed" ? "is-active" : ""} aria-pressed={mode === "mixed"} onClick={() => { setMode("mixed"); setRecovered([]); }}>组合异常态</button>
        </div>
      </div>
    </section></ReviewTools>

    <DashboardHeader className="core-review__page-head" title="核心经营总览" breadcrumb="公共概览 / 官方看板" description="用于快速判断跨业务核心结果、周期变化、关键链路与数据完整性；各区域按自身统计范围与日期口径独立阅读。" summary="先看 6＋3 项核心结果，再看内容、获客、支付链路与经营明细；所有区域独立遵守数据准入。">
      <section className="core-review__filter-bar" aria-label="看板工具栏">
        <div className="core-review__filter-controls">
          <DashboardQueryFields date={<DateRangePicker
            value={{ start: filters.start, end: filters.end }}
            maxDate={MAX_COMPLETE_DATE} today="2026-09-10" maxDays={366}
            onChange={(range) => setFilters((current) => ({ ...current, ...range }))}
          />} scope={<MenuSelect
            className="core-review__select"
            label="业务范围"
            ariaLabel="业务范围"
            align="end"
            density="compact"
            value={filters.scope}
            onChange={(scope) => setFilters((current) => ({ ...current, scope }))}
            groups={[{ label: "可用业务平台", options: [
              { value: "all", label: "大盘整体", meta: "合成演示范围" },
              { value: "PH", label: "PH · Pornhub", meta: "当前未提供该范围的演示结果", disabled: true },
              { value: "TT", label: "TT · TikTok", meta: "当前未提供该范围的演示结果", disabled: true },
              { value: "XH", label: "XH · XHamster", meta: "当前未提供该范围的演示结果", disabled: true },
              { value: "XN", label: "XN · XNXX", meta: "当前未提供该范围的演示结果", disabled: true }
            ] }]}
          />} comparison={<MenuSelect
            className="core-review__select core-review__comparison-select"
            label="对比周期"
            ariaLabel="对比周期"
            align="end"
            density="compact"
            value={filters.comparison}
            onChange={(comparison) => setFilters((current) => ({ ...current, comparison: comparison as ComparisonMode }))}
            groups={[{ label: "同口径对比", options: [
              { value: "previous", label: "上一等长周期" },
              { value: "week", label: "上周同期", meta: "演示能力未接入", disabled: true },
              { value: "month", label: "上月同期", meta: "演示能力未接入", disabled: true },
              { value: "year", label: "去年同期", meta: "演示能力未接入", disabled: true },
              { value: "none", label: "不对比", meta: "隐藏对比值、对比线和图例" }
            ] }]}
          />} apply={<button type="button" className="ui-button ui-button--primary ui-button--md core-review__apply" onClick={applyFilters}>应用</button>} />
        </div>
        <div className="core-review__toolbar-actions" aria-label="看板操作">
          <DashboardActions favorite={<IconAction label={favorite ? "取消收藏" : "收藏看板"} onClick={() => { try { setPreviewFavorite("5.2", !favorite); setFavorite(!favorite); setNotice(favorite ? "已取消收藏" : "已加入我的收藏（仅本机）"); } catch { setNotice("本机存储不可用，收藏未保存"); } }}><Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} /></IconAction>} copyLink={<IconAction label="复制当前视图链接" onClick={performCopy}><Copy aria-hidden="true" /></IconAction>} refresh={<IconAction label="刷新看板" onClick={() => { setRecovered([]); setNotice("演示快照已重新载入，保留已应用条件"); }}><RefreshCw aria-hidden="true" /></IconAction>} exportAction={<PreviewExportControl name="核心经营总览" scope="整张看板已成功查询的组件；独立列出部分结果、未产出及失败范围。" context={dateRangeLabel(appliedFilters)} pending={hasPendingFilters} onDownloadPreview={() => downloadPreviewWorkbook("核心经营总览", exportSheets())} iconOnly />} />
        </div>
        {hasPendingFilters && <p className="core-review__pending-filter" role="status">条件已修改，点击“应用”后更新结果</p>}
      </section>
    </DashboardHeader>

    <section className="core-review__section" aria-labelledby="core-main-results">
      <header><DashboardSectionHeading title="主结果" id="core-main-results" /><small>6 项 · 紧凑指标卡</small></header>
      <div className={`core-review__metric-grid${appliedFilters.comparison === "none" ? " is-without-comparison" : ""}`}>
        {renderMetricCards(metrics.slice(0, 6))}
      </div>
    </section>

    <section className="core-review__section" aria-labelledby="core-efficiency-results">
      <header><DashboardSectionHeading title="效率与留存" id="core-efficiency-results" /><small>3 项 · 紧凑指标卡</small></header>
      <div className={`core-review__metric-grid${appliedFilters.comparison === "none" ? " is-without-comparison" : ""}`}>
        {renderMetricCards(metrics.slice(6))}
      </div>
    </section>

    <section className="core-review__section" aria-labelledby="core-key-chains">
      <header><DashboardSectionHeading title="关键业务链路与质量" id="core-key-chains" /></header>
      <div className="core-review__chains-layout">
        <div className="core-review__chain-grid">
          <div className="core-review__chain-tabs" role="tablist" aria-label="关键业务链路">
            {CHAIN_PANELS.map((panel) => <button
              key={panel.key}
              id={`core-chain-tab-${panel.key}`}
              type="button"
              role="tab"
              aria-selected={activeChain === panel.key}
              aria-controls={`core-chain-panel-${panel.key}`}
              tabIndex={activeChain === panel.key ? 0 : -1}
              onClick={() => setActiveChain(panel.key)}
              onKeyDown={(event) => navigateChainTabs(event, panel.key)}
            >{panel.title}</button>)}
          </div>
          {CHAIN_PANELS.map((panel) => <ChainCard
            key={panel.key}
            panel={panel}
            hidden={activeChain !== panel.key}
            onOpenDefinition={openMetricDefinition}
            showComparison={appliedFilters.comparison !== "none"}
          />)}
        </div>
        <aside className="core-review__quality" aria-label="关键质量与数据状态">
          <header><h3>关键质量</h3></header>
          {[LAUNCH_SUCCESS_RATE, PLAY_SUCCESS_RATE].map(metric => <div key={metric.id}><ChainSummary item={{ metric }} showComparison={appliedFilters.comparison !== "none"} onOpenDefinition={openMetricDefinition} supporting /></div>)}
          <div className={mode === "mixed" ? "is-warning" : ""}>
            <span>数据状态</span><b>{live ? live.state.status === "success" ? "真实结果待验数" : live.state.status === "failure" ? "真实查询失败" : "正在读取真实数据" : mode === "mixed" ? "5/9 项展示结果" : "9/9 项可用"}</b>
            <small>{live ? `${live.platformName} · 其余区域见来源标记` : mode === "mixed" ? "含部分/旧结果；另有加载、无记录、未成熟与失败" : "当前期完整 · 4/4 个业务平台"}</small>
          </div>
          <button type="button" onClick={() => setReading({ title: "数据状态", content: <p>{live ? "待验数表示真实后台结果，完整性和数据水位未返回。演示数据区域为独立合成样例，不参与真实值计算。" : "当前为固定演示数据。正式数据状态将按范围、两期完整性、平台覆盖和逐项原因展示。"}</p> })}>查看数据状态<ChevronRight aria-hidden="true" /></button>
        </aside>
      </div>
    </section>

    <AdvertisingOverview range={appliedFilters} audience={adAudience} onAudience={setAdAudience} compared={appliedFilters.comparison!=="none"} mixed={mode==="mixed"} pending={hasPendingFilters} onOpen={(title,content)=>setReading({title,content})}/>
    <section className="core-review__section core-review__detail" aria-labelledby="core-operating-detail">
      <header>
        <div><DashboardSectionHeading title="经营明细" id="core-operating-detail" badge={!live && <DataOriginBadge />} /><p>当日快照 · 平台筛选仅作用于本区域</p></div>
        <div className="core-review__detail-actions"><time dateTime={detailDate}>数据日 {detailDate}</time>
          <MenuSelect label="平台" ariaLabel="经营明细平台" density="compact" value={detailPlatform}
            groups={[{ label: "经营明细平台", options: [{ value: "all", label: "全部平台" }, ...detailRows.map(row => ({ value: row.pid, label: row.name }))] }]}
            onChange={value => { setDetailPlatform(value); setSelectedDetail(null); }} />
          <span className="core-review__comparison-label">变化参考</span>
          <MenuSelect label="变化参考" ariaLabel="经营明细变化参考" density="compact" value={detailComparison}
            groups={[{ label: "变化参考", options: [{ value: "none", label: "不显示" }, { value: "previousDay", label: "较昨日" }, { value: "previousWeek", label: "较上周同日" }] }]}
            onChange={(value) => setDetailComparison(value as DetailComparisonMode)} />
          <PreviewExportControl name="经营明细" dataOrigin={live ? "mixed" : "demo"} scope="当前局部平台范围的全部明细列，以单张宽表导出；保留数值精度、逐列数据状态与计算输入。" context={`数据日 ${detailDate} · ${detailScopeLabel}`} pending={hasPendingFilters || Boolean(live && (!live.canExport || live.controls.dirty))} onDownloadPreview={() => { if (live && (!live.canExport || live.controls.dirty)) return; downloadPreviewWorkbook("经营明细", exportSheets(true), live ? "mixed" : "demo"); }} />
        </div>
      </header>
      <div id="operating-summary-cards" className="core-review__detail-summary" role="group" aria-label="经营明细纯数值卡">
        {renderMetricCards(summaryExpanded ? detailModels : detailModels.slice(0, 6), "value")}
      </div>
      <div className="core-review__detail-tools">
        <button type="button" className="ui-button ui-button--secondary" aria-expanded={summaryExpanded} aria-controls="operating-summary-cards" onClick={() => setSummaryExpanded(value => !value)}>{summaryExpanded ? "收起" : "展开全部 10 项"}</button>
        <MenuSelect label="定位指标列" ariaLabel="定位经营明细指标列" density="compact" searchable placeholder="搜索并定位指标列" value={locatedColumn}
          groups={[...new Set(detailColumns.map(c => c.group))].map(group => ({ label: group, options: detailColumns.filter(c => c.group === group).map(c => ({ value: detailColumnKey(c), label: c.metric.name, meta: `${c.sourceLabel ? `日报：${c.sourceLabel} · ` : ""}${c.unit}` })) }))}
          onChange={locateColumn} />
      </div>
      <p className="core-review__detail-context">{detailPlatform === "all" ? "数值卡为独立大盘结果，明细列出各业务平台，不对平台人数相加。" : `${detailScopeLabel} · 数值卡与下方同一平台明细一致。`} 注册留存按数据日注册用户观察，各周期观察结束前显示“未成熟”。</p>
      <div ref={detailScroll} className="core-review__comparison-scroll" tabIndex={0} role="region" aria-label="业务平台经营指标横向比较表">
        <table className="core-review__comparison-table">
          <caption>{live ? "授权平台的当日快照；来源与未返回状态逐列展示" : "固定设计演示数据；正式页面动态返回所有有权限且有真实结果的业务平台"}</caption>
          <thead><tr>
            <th scope="col">状态</th>
            <th scope="col">业务平台</th>
            <th scope="col">模式</th>
            <th scope="col">推广状态</th>
            {detailColumns.map((column, columnIndex) => {
              const active = sort.columnIndex === columnIndex;
              const nextDirection = active && sort.direction === "desc" ? "升序" : "降序";
              const unit = metricHeadingUnit(column.metric.name, column.unit);
              return <th key={detailColumnKey(column)} data-column-key={detailColumnKey(column)} scope="col" className={`is-number${column.slice ? " is-slice" : ""}${locatedColumn === detailColumnKey(column) ? " is-located" : ""}`} aria-sort={active ? (sort.direction === "desc" ? "descending" : "ascending") : "none"}>
                <div className="core-review__comparison-heading">
                  <MetricDefinitionLabel metric={column.metric} onOpen={openMetricDefinition} dimensionLabel={column.slice} />
                  {live && <DataOriginProvider value={live.metricIds.includes(OPERATING_LIVE_IDS[detailColumnKey(column)]) ? "pending" : "demo"}><DataOriginBadge /></DataOriginProvider>}
                  {unit && <small className="metric-heading-unit">（{unit}）</small>}
                  {!column.pendingReason && <button
                    type="button"
                    className="core-review__sort-action"
                    aria-label={`按${column.metric.name}${nextDirection}排列`}
                    onClick={() => updateSort(columnIndex)}
                  >{active
                      ? sort.direction === "desc" ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />
                      : <ArrowUpDown aria-hidden="true" />}
                  </button>}
                </div>
              </th>;
            })}
          </tr></thead>
          <tbody>{sortedRows.map((row) => <tr key={row.pid}>
            <td><span className={row.state === "完整" ? "core-review__complete" : "ui-status ui-status--warning"}>{row.state}</span></td>
            <td><b>{row.name}</b><small>PID {row.pid}</small></td>
            <td><span className="core-review__complete">{row.productMode ?? "待接口支持"}</span></td>
            <td><span className="core-review__complete">{row.promotionStatus ?? "待接口支持"}</span></td>
            {detailColumns.map((column, columnIndex) => <DetailMetricCell
              key={detailColumnKey(column)}
              row={row}
              column={column}
              columnIndex={columnIndex}
              previousDate={previousDate}
              previousWeekDate={previousWeekDate}
              currentDate={detailDate}
              comparisonMode={detailComparison}
              onOpen={setSelectedDetail}
            />)}
          </tr>)}</tbody>
        </table>
      </div>
      <footer>
        <span><CheckCircle2 aria-hidden="true" />{sortedRows.length} 个平台 · 73 个业务列 · {live ? "逐列区分待验数与演示数据" : "合成演示数据"} · 导出保留状态</span>

      </footer>
    </section>

    {selectedDetail && <DetailSnapshotDialog detail={selectedDetail} date={detailDate} onClose={() => {
      const trigger = selectedDetail.trigger;
      setSelectedDetail(null);
      window.requestAnimationFrame(() => restoreReadingFocus(trigger));
    }} />}
    {breakdownId && detailModels.some(model => model.metric.id === breakdownId) && <MetricBreakdown model={operatingDetailBreakdown(detailModels.find(model => model.metric.id === breakdownId)!, detailRows, detailPlatform, detailDate)} onClose={() => setBreakdownId(null)} />}
    {reading && <MetricReadingDialog {...reading} onClose={() => setReading(null)} />}
    {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
  </div></CorePeriod.Provider>;
}

export default CoreOverviewDesignFixture;
