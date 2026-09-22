import { useState } from "react";
import type { DailyDashboardCatalog, DailyDashboardQuery } from "../../../../contracts/daily-dashboard";
import type { V2PlatformCatalogSuccess } from "../../../../contracts/bi-v2";
import { DateRangePicker } from "../../../components/ui/DateRangePicker";
import { MenuSelect } from "../../../components/ui/MenuSelect";
import { fetchDailyDashboard } from "../../api/client";
import { useV2Resource } from "../../api/useV2Resource";
import { useDataEnvironment } from "../../app/DataEnvironmentProvider";
import { navigate } from "../../app/router";
import { ResourceFailurePanel, StatePanel } from "../../components/StatePanel";
import "./connected-daily-board.css";

type Board = DailyDashboardCatalog["items"][number];
type Platforms = V2PlatformCatalogSuccess["data"]["items"];

function formatValue(value: number | null, unit: string) {
  if (value === null) return "—";
  if (unit === "%") return `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${unit}`;
}

export default function ConnectedDailyBoard({ query, board, platforms }: { query: DailyDashboardQuery; board: Board; platforms: Platforms }) {
  const environment = useDataEnvironment();
  const resource = useV2Resource(JSON.stringify(query), (signal) => fetchDailyDashboard(query, board.metricIds, signal));
  const [range, setRange] = useState({ start: query.dateRange[0], end: query.dateRange[1] });
  const [pid, setPid] = useState(query.pid);
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const dirty = range.start !== query.dateRange[0] || range.end !== query.dateRange[1] || pid !== query.pid;
  const apply = () => {
    if (!dirty) {
      resource.retry();
      return;
    }
    const params = new URLSearchParams({ board: query.boardId, pid, start: range.start, end: range.end });
    navigate(`/dashboards/public?${params}`);
  };

  if (resource.state.status === "loading") return <StatePanel kind="loading" title="正在读取看板数据" description="正在按当前平台和日期范围查询后台。" />;
  if (resource.state.status === "failure") return <ResourceFailurePanel state={resource.state} onRetry={resource.retry} />;
  const result = resource.state.data;
  const dates = result.data.series[0]?.points.map((point) => point.date) ?? [];

  return <div className="connected-daily-board">
    <header className="connected-daily-board__header">
      <div><span className={`connected-daily-board__environment is-${environment.state.mode}`}>{environment.state.mode === "test" ? "测试数据" : "正式数据"}</span><h1>{board.title}</h1><p>{platforms.find((platform) => platform.pid === query.pid)?.name ?? query.pid} · {query.dateRange[0]} 至 {query.dateRange[1]} · 真实后台候选结果，待验数</p></div>
      <div className="connected-daily-board__controls">
        <MenuSelect label="平台" ariaLabel="选择平台" value={pid} density="compact" searchable groups={[{ label: "授权平台", options: platforms.map((platform) => ({ value: platform.pid, label: platform.name })) }]} onChange={setPid} />
        <DateRangePicker value={range} onChange={setRange} today={today} maxDate={today} maxDays={366} boundaryLabel="可选择日期截至" />
        <button type="button" className="ui-button ui-button--primary" onClick={apply}>{dirty ? "应用" : "刷新"}</button>
      </div>
    </header>
    <section className="connected-daily-board__cards" aria-label="指标摘要">
      {result.data.series.map((series) => {
        const latest = [...series.points].reverse().find((point) => point.state === "available") ?? null;
        return <article key={series.metric.id}><span>{series.metric.name}</span><strong>{formatValue(latest?.value ?? null, series.metric.unit)}</strong><small>{latest ? `${latest.date} 最近可用日` : "所选范围暂无可用值"}</small></article>;
      })}
    </section>
    <section className="connected-daily-board__table" aria-labelledby="connected-daily-table-title">
      <div><h2 id="connected-daily-table-title">逐日明细</h2><p>缺失、未成熟和异常状态保持为空，不补 0。</p></div>
      <div className="connected-daily-board__table-scroll"><table><thead><tr><th>日期</th>{result.data.series.map((series) => <th key={series.metric.id}>{series.metric.name}</th>)}</tr></thead><tbody>{dates.map((date, index) => <tr key={date}><th>{date}</th>{result.data.series.map((series) => <td key={series.metric.id} data-state={series.points[index]?.state}>{formatValue(series.points[index]?.value ?? null, series.metric.unit)}</td>)}</tr>)}</tbody></table></div>
    </section>
    <footer>查询时间：{new Date(result.data.fetchedAt).toLocaleString("zh-CN")} · 完整性：待核验 · 数据水位：未返回</footer>
  </div>;
}
