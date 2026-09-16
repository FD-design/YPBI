import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { Info, Search } from "lucide-react";
import { Chart } from "../../components/Chart";
import { Button } from "../../components/ui/Button";
import { FloatingHint } from "../../components/ui/FloatingHint";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { PaginatedTable } from "../../components/ui/PaginatedTable";
import { CHART_PALETTE } from "../../theme/tokens";
import { CalculationEvidence } from "../features/dashboards/CalculationEvidence";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { MetricSummary } from "../features/dashboards/MetricSummary";
import type { DashboardMetricCardModel } from "../features/dashboards/dashboard-metric-card-model";
import {
  contentDiscoveryOverall,
  contentDiscoverySheet,
  contentPositionTrendModel,
  contentPositionRows,
  orderBoardRows,
  searchDemandRows,
  searchDemandSheet,
  searchDemandTrendModel,
  videoClickSourceMetricModel,
  videoClickSourceRows,
  videoClickSourceSheet,
  type BoardSortOrder
} from "./content-discovery-analysis-model";
import { demoMetric, demoRangeLabel, demoUnit, demoValue, extendedMetricModel } from "./extended-board-model";
import type { ExtendedView } from "./extended-board-view";
import { HORIZONTAL_BAR_GRID, horizontalBarEndLabel } from "./horizontal-bar-reading";
import { PreviewMetricCard, type OpenPreviewReading } from "./PreviewMetricCard";
import { metricRows } from "./topic-preview-export";
import type { WorkbookSheet } from "./preview-workbook";

type ExportFactory = (title: string, sheets: WorkbookSheet[]) => ReactElement;
type Selection = { id: string; group: string; order: BoardSortOrder };
const trendSheet = (name: string, model: DashboardMetricCardModel): WorkbookSheet => ({ name, rows: metricRows([model], demoUnit) });

function MetricName({ id, open, label, definition }: { id?: string; open: OpenPreviewReading; label?: string; definition?: ReactNode }) {
  const metric = id ? demoMetric(id) : undefined;
  const name = label ?? metric!.name, content = definition ?? <p>{metric!.definition}</p>;
  return <FloatingHint content={content}>
    <button className="board-analysis__metric-name" type="button" onClick={() => open(name, <>{content}</>)}>{name}<Info aria-hidden="true" /></button>
  </FloatingHint>;
}

const rawRate = (basis: ReturnType<typeof contentDiscoveryOverall>["current"]) => basis.denominator.value && basis.numerator.value !== null ? basis.numerator.value / basis.denominator.value : null;
const percentLabel = (value: number) => `${(value * 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
const countLabel = (value: number | null, unit = "次") => value === null ? "—" : `${value.toLocaleString("zh-CN")} ${unit}`;

export function ContentDiscoveryAnalysis({ view, open, exportAction, onSelectionChange }: {
  view: ExtendedView;
  pending: boolean;
  open: OpenPreviewReading;
  exportAction: ExportFactory;
  onSelectionChange?: (selection: Selection) => void;
}) {
  const [search, setSearch] = useState(""), [order, setOrder] = useState<BoardSortOrder>("position");
  const overall = useMemo(() => contentDiscoveryOverall(view.range), [view.range]);
  const rows = useMemo(() => orderBoardRows(contentPositionRows(view.range), order, row => rawRate(row.current) ?? -Infinity), [view.range, order]);
  const filtered = rows.filter(row => `${row.page} ${row.list} ${row.name} ${row.key}`.toLowerCase().includes(search.toLowerCase().trim()));
  const sheet = contentDiscoverySheet(view.range, view.compared, order);
  const currentRate = rawRate(overall.current);
  const inputName = (role: "numerator" | "denominator", comparison = false) => <MetricName open={open}
    label={`${comparison ? "对比" : ""}${role === "numerator" ? "视频点击数" : "视频曝光数"}`}
    definition={<><p>{role === "numerator" ? "匹配到合格视频曝光的点击次数，作为曝光-点击转化率的分子；不是产品全局全部视频点击。" : "符合已登记视频曝光规则的曝光次数，作为曝光-点击转化率的分母；不是页面访问次数或去重人数。"}</p><p>{(comparison ? overall.comparison : overall.current).scope}</p></>} />;
  const rateName = <MetricName id="M044" open={open} label="曝光-点击转化率" definition={<><p>{demoMetric("M044").definition}</p><CalculationEvidence basis={overall.current} /></>} />;
  const trendModel = extendedMetricModel("M044", view.range, view.compared);
  const trend = () => open("视频内容曝光-点击转化率 · 总体趋势", <PreviewMetricCard model={trendModel} open={open} retry={() => {}} exportAction={exportAction("视频内容曝光-点击转化率同口径数据", [trendSheet("01_总体逐日趋势", trendModel)])} />);
  const showPositionTrend = (row: ReturnType<typeof contentPositionRows>[number]) => {
    const model = contentPositionTrendModel(view.range, view.compared, row.position);
    open(`${row.name} · 曝光点击趋势`, <PreviewMetricCard model={model} open={open} retry={() => {}} exportAction={exportAction(`${row.name}曝光点击趋势`, [trendSheet("01_所选位置逐日趋势", model)])} />);
  };
  const changeOrder = (next: string) => { const value = next as BoardSortOrder; setOrder(value); onSelectionChange?.({ id: "M044", group: "位置", order: value }); };
  return <DashboardPanel title="内容发现总体与位置" guidanceKey="discovery.sources" chartKind="content-discovery-position" note={`${demoRangeLabel(view.range)} · 按页面、列表和位置比较`} tools={<div className="board-control-group board-control-group--secondary"><span>排序</span><MenuSelect label="排序" ariaLabel="内容发现总体与位置排序" value={order} density="compact" onChange={changeOrder} groups={[{ label: "排序", options: [{ value: "position", label: "按业务顺序" }, { value: "desc", label: "按转化率降序" }] }]} /></div>}>
    <div className="board-analysis__summary" aria-label="内容发现总体摘要">
      <MetricSummary title={inputName("denominator")} value={countLabel(overall.current.denominator.value)} />
      <MetricSummary title={inputName("numerator")} value={countLabel(overall.current.numerator.value)} />
      <MetricSummary title={rateName} value={currentRate === null ? "—" : percentLabel(currentRate)} supplementary={<Button size="sm" variant="ghost" onClick={trend}>查看总体趋势</Button>} />
    </div>
    <div className="board-analysis__formula"><CalculationEvidence basis={overall.current} compact /></div>
    <div className="board-preview__category-scroll" aria-label="各位置曝光点击转化率图"><Chart theme="v13" ariaLabel="各位置曝光点击转化率比较" style={{ height: Math.max(260, rows.length * 34 + 60) }} option={{ grid: HORIZONTAL_BAR_GRID, tooltip: { trigger: "axis", formatter: (params: { dataIndex: number }[]) => { const row = rows[params[0].dataIndex], value = rawRate(row.current); return `${row.page} · ${row.list}<br/>${row.name} · ${value === null ? "—" : percentLabel(value)}<br/>${row.current.numerator.name} ${countLabel(row.current.numerator.value)}<br/>${row.current.denominator.name} ${countLabel(row.current.denominator.value)}`; } }, xAxis: { type: "value", axisLabel: { formatter: (value: number) => `${(value * 100).toFixed(0)}%` } }, yAxis: { type: "category", inverse: true, data: rows.map(row => row.name), axisLabel: { width: 132, overflow: "truncate" } }, series: [{ name: "当前期", type: "bar", data: rows.map(row => rawRate(row.current)), label: horizontalBarEndLabel(value => value === null ? "—" : percentLabel(value)), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[0] } }, ...(view.compared ? [{ name: "对比期", type: "bar", data: rows.map(row => rawRate(row.comparison)), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[1] } }] : [])] }} /></div>
    <section className="board-analysis__table" aria-labelledby="content-position-table-heading"><header><h3 id="content-position-table-heading">位置精确表</h3>{exportAction("内容发现总体与位置", [sheet])}</header>
      <p className="dashboard-table-context">{overall.current.formula}</p>
      <label className="topic-preview__search ui-search"><Search /><input aria-label="搜索内容发现位置" value={search} placeholder="搜索页面、列表或位置" onChange={event => setSearch(event.target.value.slice(0, 120))} /></label>
      <PaginatedTable label="内容发现位置完整结果" resetKey={JSON.stringify([search, order, view])} columnCount={view.compared ? 12 : 8} head={<tr><th>页面</th><th>列表</th><th>位置</th><th>{inputName("numerator")}</th><th>{inputName("denominator")}</th><th>{rateName}</th>{view.compared && <><th>{inputName("numerator", true)}</th><th>{inputName("denominator", true)}</th><th>对比转化率</th><th>差值（百分点）</th></>}<th>状态</th><th>趋势</th></tr>} rows={filtered.map(row => { const current = rawRate(row.current), comparison = rawRate(row.comparison); return <tr key={row.key}><td>{row.page}</td><td>{row.list}</td><td>{row.name}</td><td>{countLabel(row.current.numerator.value)}</td><td>{countLabel(row.current.denominator.value)}</td><td>{current === null ? "—" : percentLabel(current)}</td>{view.compared && <><td>{countLabel(row.comparison.numerator.value)}</td><td>{countLabel(row.comparison.denominator.value)}</td><td>{comparison === null ? "—" : percentLabel(comparison)}</td><td>{current === null || comparison === null ? "—" : ((current - comparison) * 100).toFixed(2)}</td></>}<td>隔离演示</td><td><button type="button" onClick={() => showPositionTrend(row)}>查看趋势</button></td></tr>; })} />
    </section>
  </DashboardPanel>;
}

const searchMetricValue = (id: string, row: ReturnType<typeof searchDemandRows>[number], comparison = false) => id === "M092" ? (comparison ? row.comparisonSearches : row.searches) : id === "M093" ? (comparison ? row.comparisonUsers : row.users) : rawRate(comparison ? row.comparisonConversion : row.conversion);

export function SearchDemandAnalysis({ view, open, exportAction, onSelectionChange }: {
  view: ExtendedView;
  pending: boolean;
  open: OpenPreviewReading;
  exportAction: ExportFactory;
  onSelectionChange?: (selection: Selection) => void;
}) {
  const [group, setGroup] = useState<"搜索词" | "搜索类型">("搜索词"), [id, setId] = useState("M092"), [order, setOrder] = useState<BoardSortOrder>("desc"), [top, setTop] = useState("10"), [search, setSearch] = useState("");
  const rows = useMemo(() => orderBoardRows(searchDemandRows(view.range, group), order, row => searchMetricValue(id, row) ?? -Infinity), [view.range, group, id, order]);
  const chartRows = rows.slice(0, Number(top));
  const filtered = rows.filter(row => `${row.name} ${row.key}`.toLowerCase().includes(search.toLowerCase().trim()));
  const sheet = searchDemandSheet(view.range, view.compared, group, order, id as "M092" | "M093" | "M046");
  const notifySelection = (nextId = id, nextGroup = group, nextOrder = order) => onSelectionChange?.({ id: nextId, group: nextGroup, order: nextOrder });
  const metric = demoMetric(id), rate = id === "M046";
  const format = (value: number | null) => value === null ? "—" : rate ? percentLabel(value) : demoValue(id, value);
  const showSearchTrend = (row: ReturnType<typeof searchDemandRows>[number]) => {
    const metricId = id as "M092" | "M093" | "M046", model = searchDemandTrendModel(metricId, view.range, view.compared, row.position);
    open(`${row.name} · ${metric.name}趋势`, <PreviewMetricCard model={model} open={open} retry={() => {}} exportAction={exportAction(`${row.name}${metric.name}趋势`, [trendSheet("01_所选搜索项逐日趋势", model)])} />);
  };
  return <DashboardPanel title="搜索需求" guidanceKey="discovery.search" chartKind="search-demand" note={`${demoRangeLabel(view.range)} · 需求规模与结果承接同表核对`} tools={<>
    <div className="board-control-group"><span>图形指标</span><div className="board-metric-segments" role="group" aria-label="搜索需求图形指标">{["M092", "M093", "M046"].map(value => <Button key={value} size="sm" variant={id === value ? "primary" : "secondary"} aria-pressed={id === value} onClick={() => { setId(value); notifySelection(value); }}>{value === "M092" ? "搜索次数" : value === "M093" ? "搜索用户" : "搜索承接率"}</Button>)}</div></div>
    <div className="board-dimension-controls"><span>比较维度</span><MenuSelect label="比较维度" ariaLabel="搜索需求分组" value={group} density="compact" onChange={next => { const value = next as typeof group; setGroup(value); notifySelection(id, value); }} groups={[{ label: "比较维度", options: ["搜索词", "搜索类型"].map(value => ({ value, label: value })) }]} /></div>
    <div className="board-control-group board-control-group--secondary"><span>排序</span><MenuSelect label="排序" ariaLabel="搜索需求排序" value={order} density="compact" onChange={next => { const value = next as BoardSortOrder; setOrder(value); notifySelection(id, group, value); }} groups={[{ label: "排序", options: [{ value: "position", label: "按业务顺序" }, { value: "desc", label: "按当前值降序" }] }]} /></div>
    {group === "搜索词" && <MenuSelect label="图形展示数量" ariaLabel="搜索需求图形展示数量" value={top} density="compact" onChange={setTop} groups={[{ label: "图形展示数量", options: [5, 10, 20].map(value => ({ value: String(value), label: `前 ${value} 项` })) }]} />}
  </>}>
    <div className="board-preview__category-scroll" tabIndex={chartRows.length > 10 ? 0 : undefined} aria-label="搜索需求分类图"><Chart theme="v13" ariaLabel={`${metric.name}分类比较`} style={{ height: Math.max(260, chartRows.length * (view.compared ? 46 : 32) + 60) }} option={{ grid: HORIZONTAL_BAR_GRID, tooltip: { trigger: "axis", formatter: (params: { dataIndex: number }[]) => { const row = chartRows[params[0].dataIndex]; return `${row.name}<br/>${metric.name} · ${format(searchMetricValue(id, row))}${id === "M046" ? `<br/>${row.conversion.numerator.name} ${countLabel(row.conversion.numerator.value)}<br/>${row.conversion.denominator.name} ${countLabel(row.conversion.denominator.value)}` : ""}`; } }, xAxis: { type: "value", axisLabel: { hideOverlap: true, formatter: (value: number) => rate ? `${(value * 100).toFixed(0)}%` : demoValue(id, value, false) } }, yAxis: { type: "category", inverse: true, data: chartRows.map(row => row.name), axisLabel: { width: 132, overflow: "truncate" } }, series: [{ name: "当前期", type: "bar", data: chartRows.map(row => searchMetricValue(id, row)), label: horizontalBarEndLabel(format), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[0] } }, ...(view.compared ? [{ name: "对比期", type: "bar", data: chartRows.map(row => searchMetricValue(id, row, true)), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[1] } }] : [])] }} /></div>
    <section className="board-analysis__table" aria-labelledby="search-demand-table-heading"><header><h3 id="search-demand-table-heading">搜索规模与承接明细</h3>{exportAction("搜索需求与承接", [sheet])}</header>
      <p className="dashboard-table-context">{demoMetric("M046").definition.split("公式：").at(-1)}</p>
      <label className="topic-preview__search ui-search"><Search /><input aria-label="搜索搜索需求" value={search} placeholder={`搜索${group}名称或标识`} onChange={event => setSearch(event.target.value.slice(0, 120))} /></label>
      <PaginatedTable label="搜索需求完整结果" resetKey={JSON.stringify([group, search, order, view])} columnCount={view.compared ? 14 : 9} head={<tr><th>{group}</th><th>位置</th><th><MetricName id="M092" open={open} /></th><th><MetricName id="M093" open={open} /></th><th>{rows[0]?.conversion.numerator.name}</th><th>{rows[0]?.conversion.denominator.name}</th><th><MetricName id="M046" open={open} label="搜索承接率" /></th>{view.compared && <><th>对比搜索次数</th><th>对比搜索用户</th><th>对比承接分子</th><th>对比承接分母</th><th>对比承接率</th></>}<th>状态</th><th>趋势</th></tr>} rows={filtered.map(row => { const current=rawRate(row.conversion),comparison=rawRate(row.comparisonConversion); return <tr key={row.key}><td>{row.name}</td><td>{row.position}</td><td>{demoValue("M092", row.searches)}</td><td>{demoValue("M093", row.users)}</td><td>{countLabel(row.conversion.numerator.value)}</td><td>{countLabel(row.conversion.denominator.value)}</td><td>{current===null?"—":percentLabel(current)}</td>{view.compared && <><td>{demoValue("M092", row.comparisonSearches)}</td><td>{demoValue("M093", row.comparisonUsers)}</td><td>{countLabel(row.comparisonConversion.numerator.value)}</td><td>{countLabel(row.comparisonConversion.denominator.value)}</td><td>{comparison===null?"—":percentLabel(comparison)}</td></>}<td>隔离演示</td><td><button type="button" onClick={() => showSearchTrend(row)}>查看趋势</button></td></tr>; })} />
    </section>
  </DashboardPanel>;
}

const sourceTabLabel = (row: ReturnType<typeof videoClickSourceRows>[number]) =>
  row.tabName ? row.tabName : "不受 Tab 控制";

const sourceChartLabel = (row: ReturnType<typeof videoClickSourceRows>[number]) =>
  row.tabName ? row.listName + " · " + row.tabName : row.pageName + " · " + row.listName;

export function VideoClickSourceAnalysis({ view, open, exportAction, onSelectionChange }: {
  view: ExtendedView;
  pending: boolean;
  open: OpenPreviewReading;
  exportAction: ExportFactory;
  onSelectionChange?: (selection: Selection) => void;
}) {
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<BoardSortOrder>("desc");
  const [top, setTop] = useState("10");
  const rows = useMemo(() => orderBoardRows(videoClickSourceRows(view.range), order, row => row.current), [view.range, order]);
  const chartRows = rows.slice(0, Number(top));
  const filtered = rows.filter(row =>
    [row.pageName, row.pageId, row.listName, row.listId, row.tabName, row.tabGroupId, row.tabId]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search.toLowerCase().trim())
  );
  const overallModel = useMemo(() => videoClickSourceMetricModel(view.range, view.compared), [view.range, view.compared]);
  const sheet = videoClickSourceSheet(view.range, view.compared, order);
  const showSourceTrend = (row: ReturnType<typeof videoClickSourceRows>[number]) => {
    const model = videoClickSourceMetricModel(view.range, view.compared, row.key);
    open(sourceChartLabel(row) + " · 视频点击趋势", <PreviewMetricCard model={model} open={open} retry={() => {}} exportAction={exportAction(sourceChartLabel(row) + "视频点击趋势", [trendSheet("01_所选来源逐日趋势", model)])} />);
  };
  const changeOrder = (next: string) => {
    const value = next as BoardSortOrder;
    setOrder(value);
    onSelectionChange?.({ id: "M109", group: "全局页面与列表来源", order: value });
  };
  return <>
    <div className="board-preview__primary-metric" aria-label="视频点击来源总体">
      <PreviewMetricCard
        model={overallModel}
        open={open}
        retry={() => {}}
        exportAction={exportAction("视频点击来源总体与逐日趋势", [trendSheet("01_总体逐日趋势", overallModel), sheet])}
      />
    </div>
    <DashboardPanel
      title="全局页面与列表来源"
      chartKind="video-click-source"
      note={demoRangeLabel(view.range) + " · 用户主动点击；图形只展示前 N 项，表格与导出保留全部来源"}
      tools={<>
        <div className="board-control-group board-control-group--secondary"><span>排序</span><MenuSelect label="排序" ariaLabel="视频点击来源排序" value={order} density="compact" onChange={changeOrder} groups={[{ label: "排序", options: [{ value: "position", label: "按业务顺序" }, { value: "desc", label: "按当前值降序" }] }]} /></div>
        <MenuSelect label="图形展示数量" ariaLabel="视频点击来源图形展示数量" value={top} density="compact" onChange={setTop} groups={[{ label: "图形展示数量", options: [5, 10, 20].map(value => ({ value: String(value), label: "前 " + value + " 项" })) }]} />
      </>}
    >
      <div className="board-preview__category-scroll" tabIndex={chartRows.length > 10 ? 0 : undefined} aria-label="全局视频点击来源图">
        <Chart
          theme="v13"
          ariaLabel="全局视频点击来源比较"
          style={{ height: Math.max(300, chartRows.length * (view.compared ? 46 : 34) + 64) }}
          onClick={params => {
            const row = chartRows[(params as { dataIndex: number }).dataIndex];
            if (row) showSourceTrend(row);
          }}
          option={{
            grid: { ...HORIZONTAL_BAR_GRID, left: 182 },
            tooltip: {
              trigger: "axis",
              formatter: (params: { dataIndex: number }[]) => {
                const row = chartRows[params[0].dataIndex];
                return row.pageName + " · " + row.listName
                  + "<br/>Tab · " + sourceTabLabel(row)
                  + "<br/>当前期 · " + demoValue("M109", row.current)
                  + (view.compared ? "<br/>对比期 · " + demoValue("M109", row.comparison) + "<br/>差值 · " + demoValue("M109", row.current - row.comparison) : "");
              }
            },
            xAxis: { type: "value", axisLabel: { hideOverlap: true, formatter: (value: number) => demoValue("M109", value, false) } },
            yAxis: { type: "category", inverse: true, data: chartRows.map(sourceChartLabel), axisLabel: { width: 168, overflow: "truncate" } },
            series: [
              { name: "当前期", type: "bar", data: chartRows.map(row => row.current), label: horizontalBarEndLabel(value => value === null ? "—" : demoValue("M109", value)), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[0] } },
              ...(view.compared ? [{ name: "对比期", type: "bar", data: chartRows.map(row => row.comparison), barMaxWidth: 16, itemStyle: { color: CHART_PALETTE[1] } }] : [])
            ]
          }}
        />
      </div>
      <section className="board-analysis__table" aria-labelledby="video-click-source-table-heading">
        <header><h3 id="video-click-source-table-heading">视频点击来源明细</h3>{exportAction("全局视频点击来源", [sheet])}</header>
        <p className="dashboard-table-context">页面、列表与点击发生时的 Tab 上下文共同标识来源；未知来源单独保留。</p>
        <label className="topic-preview__search ui-search"><Search /><input aria-label="搜索视频点击来源" value={search} placeholder="搜索页面、列表或 Tab" onChange={event => setSearch(event.target.value.slice(0, 120))} /></label>
        <PaginatedTable
          label="视频点击来源完整结果"
          resetKey={JSON.stringify([search, order, view])}
          columnCount={view.compared ? 8 : 6}
          head={<tr><th>页面</th><th>列表</th><th>Tab 上下文</th><th>当前点击次数</th>{view.compared && <><th>对比点击次数</th><th>差值</th></>}<th>状态</th><th>趋势</th></tr>}
          rows={filtered.map(row => <tr key={row.key}>
            <td>{row.pageName}</td><td>{row.listName}</td><td>{sourceTabLabel(row)}</td><td>{demoValue("M109", row.current)}</td>
            {view.compared && <><td>{demoValue("M109", row.comparison)}</td><td>{demoValue("M109", row.current - row.comparison)}</td></>}
            <td>隔离演示</td><td><button type="button" onClick={() => showSourceTrend(row)}>查看趋势</button></td>
          </tr>)}
        />
      </section>
    </DashboardPanel>
  </>;
}
