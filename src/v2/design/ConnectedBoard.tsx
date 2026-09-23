import { useState } from "react";
import type { DailyDashboardCatalog, DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import type { V2PlatformCatalogSuccess } from "../../../contracts/bi-v2";
import { fetchDailyDashboard } from "../api/client";
import { useV2Resource, type V2ResourceState } from "../api/useV2Resource";
import { useAuthentication } from "../app/AuthProvider";
import { navigate, useBrowserLocation } from "../app/router";
import { RefreshNotice } from "../components/StatePanel";
import { DemoDataProvider } from "../components/DataOrigin";
import { LiveDashboardContext, liveDailyReferenceRows, livePointStateLabel } from "../features/dashboards/LiveDashboardContext";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { MenuSelect } from "../../components/ui/MenuSelect";
import Core from "./CoreOverviewDesignFixture";
import Acquisition from "./AcquisitionPreview";
import Topics from "./TopicPreviews";
import Extended from "./ExtendedBoardPreview";
import Functions from "./FunctionUsagePreview";
import { PreviewBoardPresentation } from "./PreviewBoardPresentation";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { validRange as validTopicRange } from "./topic-preview-fixtures";
import { validDemoRange } from "./extended-board-model";
import { previousDailyQuery, supplementaryDailyQuery } from "../features/dashboards/daily-reference-plan";
import { availablePeriodStatistics, periodStatisticLabel } from "../features/dashboards/live-period-statistics";

export default function ConnectedBoard({ query, board, platforms }: { query: DailyDashboardQuery; board: DailyDashboardCatalog["items"][number]; platforms: V2PlatformCatalogSuccess["data"]["items"] }) {
  const location = useBrowserLocation();
  const compared = new URLSearchParams(location.search).get("compare") === "previous";
  const previousQuery = previousDailyQuery(query);
  const referenceQuery = supplementaryDailyQuery(query, compared);
  const { state, retry } = useV2Resource(JSON.stringify(query), async signal => board.metricIds.length ? fetchDailyDashboard(query, board.metricIds, signal) : null);
  const previous = useV2Resource(JSON.stringify([previousQuery, compared]), async signal => compared && board.metricIds.length ? fetchDailyDashboard(previousQuery, board.metricIds, signal) : null);
  const reference = useV2Resource(JSON.stringify(["day-references", referenceQuery]), async signal => referenceQuery && board.metricIds.length ? fetchDailyDashboard(referenceQuery, board.metricIds, signal) : null);
  const [range, setRange] = useState({ start: query.dateRange[0], end: query.dateRange[1] }), [pid, setPid] = useState(query.pid);
  const [comparison, setComparison] = useState(compared ? "previous" : "none");
  const authentication = useAuthentication();
  const canExport = authentication.state.status === "authenticated" && authentication.state.session.user.permissions.includes("bi:export");
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const dirty = range.start !== query.dateRange[0] || range.end !== query.dateRange[1] || pid !== query.pid || compared !== (comparison === "previous");
  const refresh = () => { retry(); previous.retry(); if (referenceQuery) reference.retry(); };
  const apply = () => {
    if (!dirty) { refresh(); return; }
    requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries({ board: query.boardId, pid, start: range.start, end: range.end, compare: comparison })) params.set(key, value);
      navigate("/dashboards/public?" + params, { historyState: window.history.state });
    });
  };
  const exportData = () => {
    if (!canExport || state.status !== "success" || !state.data || dirty) return;
    const periods = [{ name: "当前期", result: state.data, stale: Boolean(state.refreshError) },
      ...(compared && previous.state.status === "success" && previous.state.data ? [{ name: "对比期", result: previous.state.data, stale: Boolean(previous.state.refreshError) }] : [])];
    const dayReferences = liveDailyReferenceRows({ query, state: { ...state, data: state.data }, comparison: compared ? { label: "上一等长周期", query: previousQuery, state: previous.state } : undefined, dayReference: referenceQuery ? { query: referenceQuery, state: reference.state } : undefined }, board.metricIds);
    downloadPreviewWorkbook(board.title, [
      { name: "读取说明", rows: [["数据性质", "真实后台候选结果，待验数"], ["平台", query.pid], ["范围", query.dateRange.join(" 至 ")], ["主值", "普通日指标为所选结束日；注册留存卡按成熟已返回批次加权；本文件逐日列出原始值"], ["完整性", "未知"], ["数据水位", "未返回"], ["对比状态", !compared ? "不对比" : previous.state.status !== "success" || !previous.state.data ? "对比查询未成功，不以演示结果补齐" : "独立读取上一等长周期"]] },
      { name: "指标口径", rows: [["指标", "单位", "计算口径", "来源口径"], ...state.data.data.series.map(series => [series.metric.name, series.metric.unit, series.metric.formula, series.metric.sourceNote])] },
      { name: "周期统计", rows: [["周期", "平台", "指标", "开始日期", "结束日期", "统计类型", "值", "单位", "验数", "完整性", "查询时间", "刷新状态", "计算版本"],
        ...periods.flatMap(period => period.result.data.series.flatMap(series => {
          const statistics = availablePeriodStatistics(series, period.result);
          return (statistics?.values ?? []).map(item => [period.name, period.result.data.query.pid, series.metric.name, ...period.result.data.query.dateRange, periodStatisticLabel(item.kind), item.value, series.metric.unit, "待验数", "未知", period.result.data.fetchedAt, period.stale ? "上次查询结果" : "本次查询结果", statistics!.aggregationVersion]);
        }))] },
      ...(compared ? [{ name: "日值比较基准", rows: [["指标", "参考", "平台", "日期", "结果（原始值）", "单位", "计算输入", "状态", "查询时间", "刷新状态"], ...dayReferences.map(point => [state.data!.data.series.find(series => series.metric.id === point.metricId)?.metric.name ?? point.metricId, point.label, query.pid, point.date, point.value, point.unit, point.calculation ? `${point.calculation.numerator.name}：${point.calculation.numerator.value ?? "—"} ${point.calculation.numerator.unit}；${point.calculation.denominator.name}：${point.calculation.denominator.value ?? "—"} ${point.calculation.denominator.unit}` : "", point.reason ?? "该日未返回", point.fetchedAt, point.freshness ?? "本次查询结果"])] }] : []),
      ...periods.flatMap(period => period.result.data.series.map(series => ({ name: period.name + "-" + series.metric.name, rows: [
        ["日期", "结果（" + (series.metric.unit === "%" ? "原始比值" : series.metric.unit) + "）", ...series.metric.inputs.map(input => input.name + "（" + input.unit + "）"), "状态", "查询时间", "刷新状态"],
        ...series.points.map(point => [point.date, point.value, ...point.inputs.map(input => input.value), livePointStateLabel(point), period.result.data.fetchedAt, period.stale ? "上次查询结果" : "本次查询结果"])
      ] })))
    ], "pending");
  };
  const readingState: V2ResourceState<DailyDashboardSuccess> = state.status === "success"
    ? state.data ? { ...state, data: state.data } : { status: "loading" } : state;
  return <LiveDashboardContext.Provider value={{ query, metricIds: board.metricIds, state: readingState, platformName: platforms.find(item => item.pid === query.pid)!.name,
    platforms, controls: {
      date: <DateRangePicker value={range} onChange={setRange} today={today} maxDate={today} maxDays={366} boundaryLabel="可选择日期截至" />,
      scope: <MenuSelect className="dashboard-query__live-scope" label="平台" ariaLabel="选择平台" value={pid} density="compact" searchable groups={[{ label: "授权平台", options: platforms.map(item => ({ value: item.pid, label: item.name })) }]} onChange={setPid} />,
      comparison: <MenuSelect className="dashboard-query__live-comparison" label="对比周期" ariaLabel="对比周期" value={comparison} density="compact" groups={[{ label: "同口径对比", options: [{ value: "previous", label: "上一等长周期" }, { value: "none", label: "不对比" }] }]} onChange={setComparison} />,
      dirty, acceptsSharedRange: board.id === "5.8" || board.id === "5.9" ? validTopicRange : validDemoRange, apply, export: exportData
    }, comparison: compared ? { label: "上一等长周期", query: previousQuery, state: previous.state } : undefined,
    dayReference: referenceQuery ? { query: referenceQuery, state: reference.state } : undefined, retry: refresh, canExport }}>
    <PreviewBoardPresentation board={board.id}><DemoDataProvider>
      {dirty && <p className="topic-preview__pending" role="status">筛选已修改，点击应用后更新真实结果。</p>}
      {state.status === "success" && state.refreshError && <RefreshNotice onRetry={refresh}>刷新失败，真实区域保留上次结果。</RefreshNotice>}
      {compared && previous.state.status === "failure" && <RefreshNotice onRetry={refresh}>对比期读取失败，当前期独立保留。</RefreshNotice>}
      {compared && previous.state.status === "success" && previous.state.refreshError && <RefreshNotice onRetry={refresh}>对比期刷新失败，保留上次查询基准。</RefreshNotice>}
      {board.id === "5.2" ? <Core /> : board.id === "5.7" ? <Acquisition /> : board.id === "5.8" || board.id === "5.9" ? <Topics board={board.id} /> : board.id === "5.5" ? <Functions /> : <Extended board={board.id as "5.10"} />}
    </DemoDataProvider></PreviewBoardPresentation>
  </LiveDashboardContext.Provider>;
}
