import { ArrowLeft, CalendarDays, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { M016_METRIC_ID, type MetricCatalogItem, type PlatformCatalogItem, type V2MetricQuerySuccess } from "../../../contracts/bi-v2";
import { Chart, type ChartOption } from "../../components/Chart";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { fetchMetricCatalog, fetchPlatformCatalog, queryMetric, V2RequestError } from "../api/client";
import { useV2Resource } from "../api/useV2Resource";
import { defaultM016DateRange, validateDateRange } from "../app/dateRange";
import { navigate, ProductLink, useBrowserLocation } from "../app/router";
import { RefreshNotice, ResourceFailurePanel, StatePanel } from "../components/StatePanel";

interface MetricAnalysisData {
  metric: MetricCatalogItem;
  platforms: PlatformCatalogItem[];
  effectivePid: string;
  result: V2MetricQuerySuccess;
}

function requestedQuery(search: string) {
  const params = new URLSearchParams(search);
  const fallback = defaultM016DateRange();
  return {
    pid: params.get("pid")?.trim() ?? "",
    start: params.get("start") ?? fallback[0],
    end: params.get("end") ?? fallback[1]
  };
}

function formatExact(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value);
}

function formatShanghaiTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false
  }).format(parsed);
  return `${formatted}（Asia/Shanghai）`;
}

function seriesStatusLabel(status: V2MetricQuerySuccess["data"]["seriesStatus"]) {
  if (status === "available") return "可用";
  if (status === "partial") return "部分数据";
  if (status === "no_values") return "有记录但无值";
  return "无记录";
}

function resultRows(result: V2MetricQuerySuccess) {
  return [
    ...result.data.points.map((point) => ({ businessDate: point.businessDate, value: point.value as number | null, state: "available" as const })),
    ...result.data.unavailableDates.map((point) => ({ businessDate: point.businessDate, value: null, state: point.state }))
  ].sort((left, right) => left.businessDate.localeCompare(right.businessDate));
}

function resultChartOption(result: V2MetricQuerySuccess): ChartOption {
  const rows = resultRows(result);
  return {
    animationDuration: 180,
    grid: { top: 24, right: 24, bottom: 42, left: 70, containLabel: false },
    tooltip: { trigger: "item", renderMode: "richText" },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: rows.map((row) => row.businessDate),
      axisLabel: { color: "#6b7280", hideOverlap: true },
      axisLine: { lineStyle: { color: "#e1e6ee" } }
    },
    yAxis: {
      type: "value",
      name: result.data.metric.unit,
      minInterval: 1,
      axisLabel: { color: "#6b7280" },
      splitLine: { lineStyle: { color: "#edf0f4" } }
    },
    series: [{
      type: "line",
      name: result.data.metric.name,
      data: rows.map((row) => row.value),
      connectNulls: false,
      showSymbol: rows.length <= 31,
      symbol: "circle",
      symbolSize: 7,
      lineStyle: { width: 2 },
      emphasis: { focus: "series" }
    }]
  };
}

export function MetricAnalysisPage({ metricId }: { metricId: string }) {
  const location = useBrowserLocation();
  const routeQuery = useMemo(() => requestedQuery(location.search), [location.search]);
  const [draftPid, setDraftPid] = useState(routeQuery.pid);
  const [draftStart, setDraftStart] = useState(routeQuery.start);
  const [draftEnd, setDraftEnd] = useState(routeQuery.end);
  const [formError, setFormError] = useState<string | null>(null);
  const defaultPidRef = useRef<string | null>(null);

  useEffect(() => {
    setDraftPid(routeQuery.pid);
    setDraftStart(routeQuery.start);
    setDraftEnd(routeQuery.end);
    setFormError(null);
  }, [routeQuery.end, routeQuery.pid, routeQuery.start]);

  const pidRequestKey = routeQuery.pid && routeQuery.pid !== defaultPidRef.current ? routeQuery.pid : "__default_pid__";
  const requestKey = `${metricId}|${pidRequestKey}|${routeQuery.start}|${routeQuery.end}`;
  const load = useCallback(async (signal: AbortSignal): Promise<MetricAnalysisData> => {
    if (metricId !== M016_METRIC_ID) throw new V2RequestError(`首批版本尚未开放指标 ${metricId}`, { kind: "error", code: "UNSUPPORTED_V2_ROUTE", status: 422 });
    const rangeError = validateDateRange(routeQuery.start, routeQuery.end);
    if (rangeError) throw new V2RequestError(rangeError, { kind: "error", code: "INVALID_DATE_RANGE", status: 400 });
    const [metrics, platforms] = await Promise.all([fetchMetricCatalog(signal), fetchPlatformCatalog(signal)]);
    const metric = metrics.find((item) => item.id === metricId);
    if (!metric) throw new V2RequestError(`指标目录当前未返回 ${metricId}`, { kind: "error", code: "METRIC_NOT_IN_CATALOG", status: 404 });
    if (!platforms.length) throw new V2RequestError("当前身份没有可查询的业务平台", { kind: "forbidden", code: "NO_ACCESSIBLE_PLATFORM", status: 403 });
    const effectivePid = routeQuery.pid || (platforms.some((item) => item.pid === "PH") ? "PH" : platforms[0].pid);
    if (!routeQuery.pid) defaultPidRef.current = effectivePid;
    if (!platforms.some((item) => item.pid === effectivePid)) throw new V2RequestError(`平台 ${effectivePid} 不在当前可用目录中`, { kind: "forbidden", code: "PID_ACCESS_DENIED", status: 403 });
    const result = await queryMetric({ metricId: M016_METRIC_ID, pid: effectivePid, dateRange: [routeQuery.start, routeQuery.end], grain: "day" }, signal);
    return { metric, platforms: [...platforms].sort((left, right) => left.order - right.order), effectivePid, result };
  }, [metricId, routeQuery.end, routeQuery.pid, routeQuery.start]);
  const { state, retry } = useV2Resource(requestKey, load);

  useEffect(() => {
    if (state.status === "success" && !draftPid) setDraftPid(state.data.effectivePid);
  }, [draftPid, state]);

  useEffect(() => {
    if (state.status !== "success") return;
    const currentPath = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, "") : location.pathname;
    if (currentPath !== `/analysis/metrics/${encodeURIComponent(metricId)}`) return;
    const params = new URLSearchParams(location.search);
    let changed = false;
    if (!routeQuery.pid) {
      params.set("pid", state.data.effectivePid);
      changed = true;
    }
    if (!params.get("start")) {
      params.set("start", routeQuery.start);
      changed = true;
    }
    if (!params.get("end")) {
      params.set("end", routeQuery.end);
      changed = true;
    }
    if (changed) navigate(`${location.pathname}?${params.toString()}${location.hash}`, { replace: true, preserveScroll: true });
  }, [location.hash, location.pathname, location.search, metricId, routeQuery.end, routeQuery.pid, routeQuery.start, state]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const error = validateDateRange(draftStart, draftEnd);
    if (error) {
      setFormError(error);
      return;
    }
    if (!draftPid) {
      setFormError("请选择业务平台");
      return;
    }
    setFormError(null);
    const params = new URLSearchParams({ pid: draftPid, start: draftStart, end: draftEnd });
    const next = `/analysis/metrics/${M016_METRIC_ID}?${params}`;
    if (`${location.pathname}${location.search}` === next) retry();
    else navigate(next);
  };

  const rows = state.status === "success" ? resultRows(state.data.result) : [];
  const hasAvailablePoints = state.status === "success" && state.data.result.data.points.length > 0;
  const busy = state.status === "loading" || (state.status === "success" && state.refreshing);
  const pageTitle = state.status === "success" ? state.data.metric.name : `${metricId} 指标分析`;

  return <div className="v2-page" data-page="metric-analysis">
    <header className="v2-page-head v2-page-head--analysis">
      <div>
        <ProductLink className="v2-back-link" href="/data/metrics"><ArrowLeft aria-hidden="true" />返回指标中心</ProductLink>
        <span className="v2-eyebrow">分析中心 / 指标分析</span>
        <h1>{pageTitle}</h1>
        <p>首批只读分析；已应用的查询条件写入 URL，未指定时使用最近 7 个完整业务日。</p>
      </div>
      <button type="button" className="v2-button v2-button--secondary v2-page-refresh" aria-label={state.status === "success" && state.refreshing ? "正在刷新指标结果" : "刷新指标结果"} onClick={retry} disabled={busy}>
        <RefreshCw className={state.status === "success" && state.refreshing ? "is-spinning" : ""} aria-hidden="true" />
        <span>{state.status === "success" && state.refreshing ? "刷新中" : "刷新结果"}</span>
      </button>
    </header>

    <form className="v2-query-bar" onSubmit={submit} aria-label="指标查询条件">
      <div className="v2-query-field v2-query-field--platform"><MenuSelect
        className="v2-platform-select"
        label="业务平台"
        ariaLabel="业务平台"
        value={draftPid}
        disabled={state.status !== "success"}
        groups={[{ label: "可用平台", options: state.status === "success" ? state.data.platforms.map((platform) => ({ value: platform.pid, label: platform.name, meta: platform.pid })) : [] }]}
        onChange={setDraftPid}
      /></div>
      <label><span>开始日期</span><input type="date" value={draftStart} onChange={(event) => setDraftStart(event.target.value)} /></label>
      <label><span>结束日期</span><input type="date" value={draftEnd} onChange={(event) => setDraftEnd(event.target.value)} /></label>
      <button type="submit" className="v2-button v2-button--primary" disabled={busy}><CalendarDays aria-hidden="true" />应用并查询</button>
      {formError && <p className="v2-form-error" role="alert">{formError}</p>}
    </form>

    {state.status === "loading" && <StatePanel kind="loading" title="正在查询真实指标" description="正在校验身份、指标目录、平台范围和 M016 日粒度查询能力。" />}
    {state.status === "failure" && <ResourceFailurePanel state={state} onRetry={retry} />}
    {state.status === "success" && <>
      {state.refreshError && <RefreshNotice onRetry={retry}>刷新失败，当前仍显示上次成功查询：{state.refreshError.message}{state.refreshError.requestId ? `（请求 ID：${state.refreshError.requestId}）` : ""}</RefreshNotice>}
      <section className="v2-analysis-context" aria-label="查询上下文">
        <div><span>指标</span><b>{state.data.metric.id} · {state.data.metric.name}</b><small>{state.data.metric.authority.version}</small></div>
        <div><span>平台</span><b>{state.data.result.data.scope.platformName}</b><small>{state.data.result.data.scope.pid}</small></div>
        <div><span>实际查询日期</span><b>{state.data.result.data.dateRange[0]} 至 {state.data.result.data.dateRange[1]}</b><small>Asia/Shanghai · 日粒度</small></div>
        <div><span>数据状态</span><b>{seriesStatusLabel(state.data.result.data.seriesStatus)}</b><small>{state.data.result.meta.validationStatus === "pending_validation" ? "技术称已实现（待验数）" : state.data.result.meta.validationStatus}</small></div>
      </section>

      {state.data.result.meta.warnings.length > 0 && <div className="v2-warning-list" role="status">{state.data.result.meta.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      {state.data.result.data.seriesStatus === "partial" && <div className="v2-warning-list" role="status"><p>当前范围只有部分日期可用；缺失日期在图表中断开，并在结果表中保留真实状态。</p></div>}

      {!hasAvailablePoints ? <StatePanel
        kind="empty"
        title={state.data.result.data.seriesStatus === "no_values" ? "有记录但无可用值" : "当前范围无记录"}
        description={state.data.result.data.seriesStatus === "no_values" ? "服务端返回了对应日期记录，但指标值均为空；页面不会把空值补成 0。" : "查询成功，但服务端在当前范围没有返回业务记录；页面不会把无记录补成 0。"}
        action={{ label: "重新查询", onClick: retry }}
      /> : <section className="v2-result-surface" aria-label="指标趋势">
        <header><div><h2>{state.data.metric.name}趋势</h2><p>{state.data.result.data.scope.platformName} · {state.data.result.data.dateRange[0]} 至 {state.data.result.data.dateRange[1]}</p></div><span className="v2-status v2-status--warning">{state.data.metric.authority.statusLabel}</span></header>
        <Chart option={resultChartOption(state.data.result)} theme="v13" ariaLabel={`${state.data.metric.name}日趋势，缺失日期断开`} style={{ width: "100%", height: 360 }} />
      </section>}

      {rows.length > 0 && <section className="v2-table-surface v2-result-table" aria-label="完整查询结果">
        <header><div><h2>完整结果表</h2><p>精确值与服务端逐日状态；不受图表展示范围影响。</p></div><span>{rows.length} 行</span></header>
        <div className="v2-table-scroll"><table className="v2-table">
          <thead><tr><th>业务日期</th><th className="is-number">{state.data.metric.name}（{state.data.metric.unit}）</th><th>数据状态</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.businessDate}><td data-label="业务日期">{row.businessDate}</td><td data-label={`${state.data.metric.name}（${state.data.metric.unit}）`} className="is-number">{row.value === null ? "—" : formatExact(row.value)}</td><td data-label="数据状态">{row.state === "available" ? <span className="v2-status v2-status--success">可用</span> : <span className="v2-status v2-status--neutral">{row.state === "no_record" ? "无记录" : "无值"}</span>}</td></tr>)}</tbody>
        </table></div>
      </section>}

      <section className="v2-query-meta" aria-label="查询追溯信息">
        <h2>查询追溯</h2>
        <dl>
          <div><dt>查询 ID</dt><dd>{state.data.result.meta.queryId}</dd></div>
          <div><dt>请求完成时间</dt><dd>{formatShanghaiTimestamp(state.data.result.meta.fetchedAt)}</dd></div>
          <div><dt>数据水位</dt><dd>{state.data.result.meta.watermark ?? "暂未提供"}</dd></div>
          <div><dt>来源接口</dt><dd>{state.data.result.meta.sourceApiIds.length ? state.data.result.meta.sourceApiIds.join("、") : "未返回"}</dd></div>
        </dl>
      </section>
    </>}
  </div>;
}
