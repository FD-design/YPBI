import { useEffect, useRef, type ReactNode } from "react";
import { DataOriginProvider } from "../components/DataOrigin";
import { DashboardPanel } from "../features/dashboards/DashboardPresentation";
import { RetentionMatrix, type RetentionMatrixRow } from "../features/dashboards/RetentionMatrix";
import { useV2Resource, type V2ResourceState } from "../api/useV2Resource";
import { fetchDailyDashboard } from "../api/client";
import { livePointStateLabel, liveExportMetadata, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { topicMetric } from "./topic-preview-fixtures";
import { shiftDate } from "../../components/ui/date-range-model";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { downloadPreviewWorkbook } from "./preview-workbook";
import type { DailyDashboardQuery, DailyDashboardSuccess } from "../../../contracts/daily-dashboard";
import { MenuSelect } from "../../components/ui/MenuSelect";
import { REGISTRATION_COHORT_SCOPES, REGISTRATION_RETENTION_WINDOWS, isReadableRegistrationCohortPoint, registrationCohortMetricId, registrationCohortScopeLabel, type RegistrationCohortScope } from "../features/dashboards/registration-cohort";

const windows = REGISTRATION_RETENTION_WINDOWS;
function usePageRefresh(key: string, revision: number, enabled: boolean, retry: () => void) {
  const previous = useRef({ key, revision });
  useEffect(() => {
    const last = previous.current;
    previous.current = { key, revision };
    // A changed business key already starts its own request. A page refresh
    // retries the same resource without discarding its last successful result.
    if (enabled && last.key === key && last.revision !== revision) retry();
  }, [key, revision, enabled, retry]);
}
function cohortState(state: V2ResourceState<DailyDashboardSuccess | null>, query: DailyDashboardQuery): V2ResourceState<DailyDashboardSuccess> {
  if (state.status !== "success") return state;
  const actual = state.data?.data.query;
  return actual && actual.boardId === query.boardId && actual.pid === query.pid
    && actual.dateRange.every((date, index) => date === query.dateRange[index])
    ? { ...state, data: state.data! } : { status: "loading" };
}
export function useCohortReading(live: LiveDashboardReading | null, range: {start:string;end:string}) {
  const query = live ? {...live.query,dateRange:[range.start,range.end] as [string,string]} : null;
  const same = query?.dateRange.every((date,i)=>date===live!.query.dateRange[i]);
  const key = JSON.stringify([query,live?.metricIds,Boolean(same)]);
  const extra=useV2Resource(key,signal=>!query||same?Promise.resolve(null):fetchDailyDashboard(query,live!.metricIds,signal));
  const before=query?{...query,dateRange:[shiftDate(range.start,-((Date.parse(range.end)-Date.parse(range.start))/86400000+1)),shiftDate(range.start,-1)] as [string,string]}:null;
  const previousKey = JSON.stringify([before,live?.metricIds,Boolean(same),Boolean(live?.comparison)]);
  const previous=useV2Resource(previousKey,signal=>!before||same||!live?.comparison?Promise.resolve(null):fetchDailyDashboard(before,live.metricIds,signal));
  usePageRefresh(key, live?.refreshRevision ?? 0, Boolean(query && !same), extra.retry);
  usePageRefresh(previousKey, live?.refreshRevision ?? 0, Boolean(before && !same && live?.comparison), previous.retry);
  if(!live||!query||same)return live;
  return {...live,query,state:cohortState(extra.state,query),retry:()=>{extra.retry();if(live.comparison)previous.retry();},comparison:live.comparison&&before?{...live.comparison,query:before,state:cohortState(previous.state,before)}:undefined};
}
export function connectedCohortRows(query: DailyDashboardQuery, state: V2ResourceState<DailyDashboardSuccess | null>, scope: RegistrationCohortScope = "overall"): RetentionMatrixRow[] {
  const series = state.status === "success" ? state.data?.data.series ?? [] : [];
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDate(query.dateRange[0], index);
    const read = (id: string) => series.find(series => series.metric.id === id)?.points.find(point => point.date === date);
    const cells = windows.map(([id, days]) => {
      const point = read(registrationCohortMetricId(id, scope));
      const ready = isReadableRegistrationCohortPoint(point);
      return { id, rate: ready ? point?.value ?? null : null, count: ready ? point?.inputs[0]?.value ?? null : null, base: ready ? point?.inputs[1]?.value ?? null : null, availableAt: shiftDate(date, days),
        status: state.status === "loading" ? "读取中" : state.status === "failure" ? "读取失败" : point ? livePointStateLabel(point) + (state.refreshError ? " · 上次查询结果" : " · 待验数") : "字段未返回" };
    });
    const bases = [...new Set(cells.map(cell => cell.base).filter((value): value is number => value !== null))];
    return { date, base: bases.length === 1 ? bases[0] : null, cells };
  });
}
export function ConnectedCohorts({ title, live, pending, open, scope = "overall", onScopeChange }: { title: string; live: LiveDashboardReading; range: {start:string;end:string}; pending:boolean; open:(title:string,content:ReactNode)=>void; scope?:RegistrationCohortScope; onScopeChange?:(scope:RegistrationCohortScope)=>void }) {
  const query = live.query, state = live.state, rows = connectedCohortRows(query, state, scope), scopeLabel = registrationCohortScopeLabel(scope);
  const tools = <PreviewExportControl name={title} dataOrigin="live" context={query.dateRange.join(" 至 ") + " · 注册日 · " + scopeLabel + " · 待验数"} pending={pending || live.controls.dirty || !live.canExport || state.status !== "success"} scope="当前期及已启用对比期的所选注册日分组、人数与状态；矩阵展示当前期" onDownloadPreview={() => {
    if (!live.canExport || pending || live.controls.dirty || state.status !== "success") return;
    const periods=[{name:"当前注册留存",query,state},...(live.comparison?[{name:"对比注册留存",query:live.comparison.query,state:live.comparison.state}]:[])];
    downloadPreviewWorkbook(title, [{name:"数据说明",rows:[...liveExportMetadata(live),["注册日分组",scopeLabel]]},...periods.map(period=>({name:period.name,rows:[["注册日","注册日分组","注册人数","留存周期","留存人数","留存率（%）","目标日","状态","平台","查询时间"],...connectedCohortRows(period.query,period.state,scope).flatMap(row=>row.cells.map(cell=>[row.date,scopeLabel,cell.base??null,topicMetric(cell.id).name,cell.count,cell.rate===null?null:cell.rate*100,cell.availableAt,cell.status,query.pid,period.state.status==="success"?period.state.data?.data.fetchedAt??null:null]))]}))], "pending");
  }} />;
  return <DataOriginProvider value="pending"><DashboardPanel title={title} note={`注册日期 ${query.dateRange.join(" 至 ")} · ${live.platformName} · ${scopeLabel} · 按注册时的客户端或获客类型分组；观察未结束批次不计入汇总`}>
    <RetentionMatrix key={scope} title={title} rows={rows} columns={windows.map(([id, days]) => ({id,name:topicMetric(id).name,label:days===1?"次日":"第 "+days+" 天",definition:topicMetric(id).definition}))} dateLabel="注册日期" baseLabel="注册用户数" scopeLabel={scopeLabel} scopeControl={onScopeChange && <MenuSelect label="注册日分组" ariaLabel="注册日分组" density="compact" value={scope} onChange={value=>onScopeChange(value as RegistrationCohortScope)} groups={[{label:"注册日分组",options:[...REGISTRATION_COHORT_SCOPES]}]} />} onOpen={open} resetKey={JSON.stringify([query,scope])} tools={tools} />
  </DashboardPanel></DataOriginProvider>;
}
