import { ArrowRight, RefreshCw, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { fetchMetricCatalog } from "../api/client";
import { useV2Resource } from "../api/useV2Resource";
import { ProductLink } from "../app/router";
import { RefreshNotice, ResourceFailurePanel, StatePanel } from "../components/StatePanel";

export function MetricCatalogPage() {
  const load = useCallback((signal: AbortSignal) => fetchMetricCatalog(signal), []);
  const { state, retry } = useV2Resource("metric-catalog", load);
  const [search, setSearch] = useState("");
  const visibleItems = useMemo(() => {
    if (state.status !== "success") return [];
    const query = search.trim().toLocaleLowerCase("zh-CN");
    if (!query) return state.data;
    return state.data.filter((metric) => [metric.id, metric.code, metric.name, metric.definition]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(query)));
  }, [search, state]);

  return <div className="v2-page" data-page="metric-catalog">
    <header className="v2-page-head">
      <div>
        <span className="v2-eyebrow">数据中心 / 指标中心</span>
        <h1>指标中心</h1>
        <p>这里只展示服务端返回的权威指标目录与真实可用状态，不使用前端固定指标补齐。</p>
      </div>
      <button type="button" className="v2-button v2-button--secondary v2-page-refresh" aria-label={state.status === "success" && state.refreshing ? "正在刷新指标目录" : "刷新指标目录"} onClick={retry} disabled={state.status === "loading" || (state.status === "success" && state.refreshing)}>
        <RefreshCw className={state.status === "success" && state.refreshing ? "is-spinning" : ""} aria-hidden="true" />
        <span>{state.status === "success" && state.refreshing ? "刷新中" : "刷新目录"}</span>
      </button>
    </header>

    {state.status === "loading" && <StatePanel kind="loading" title="正在读取指标目录" description="正在校验身份并请求只读指标目录。" />}
    {state.status === "failure" && <ResourceFailurePanel state={state} onRetry={retry} />}
    {state.status === "success" && <>
      {state.refreshError && <RefreshNotice onRetry={retry}>目录刷新失败，当前仍显示上次成功结果：{state.refreshError.message}{state.refreshError.requestId ? `（请求 ID：${state.refreshError.requestId}）` : ""}</RefreshNotice>}
      {state.data.length === 0 ? <StatePanel kind="empty" title="指标目录为空" description="服务端当前没有返回可展示的指标，页面不会使用本地固定数组补齐。" action={{ label: "重新检查", onClick: retry }} /> : <>
        <section className="v2-toolbar" aria-label="指标目录工具">
          <label className="v2-search">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索指标</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索指标名称、ID 或定义" />
          </label>
          <span>共 {state.data.length} 项</span>
        </section>
        {visibleItems.length === 0 ? <StatePanel compact kind="empty" title="没有匹配的指标" description="请调整搜索词；原始目录仍保持不变。" /> : <section className="v2-table-surface" aria-label="指标目录结果">
          <div className="v2-table-scroll">
            <table className="v2-table">
              <thead><tr><th>指标</th><th>定义</th><th>权威状态</th><th>当前能力</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>{visibleItems.map((metric) => <tr key={metric.id}>
                <td data-label="指标"><div className="v2-metric-name"><b>{metric.name}</b><span>{metric.id} · {metric.unit}</span></div></td>
                <td data-label="定义"><span className="v2-definition">{metric.definition}</span></td>
                <td data-label="权威状态"><div className="v2-status-copy"><span className="v2-status v2-status--warning">{metric.authority.statusLabel}</span><small>{metric.authority.version}</small></div></td>
                <td data-label="当前能力"><span>{metric.capabilities.grains.map((grain) => grain === "day" ? "日粒度" : grain).join("、")} · {metric.capabilities.platformMode === "single_pid" ? "单 PID" : metric.capabilities.platformMode}</span></td>
                <td data-label="操作"><ProductLink className="v2-text-link" href={`/analysis/metrics/${encodeURIComponent(metric.id)}`}>进入分析<ArrowRight aria-hidden="true" /></ProductLink></td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}
      </>}
    </>}
  </div>;
}
