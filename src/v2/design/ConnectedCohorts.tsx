import type { ReactNode } from "react";
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

const windows = [["M020",1],["M021",3],["M022",7],["M023",30]] as const;
export function useCohortReading(live: LiveDashboardReading | null, range: {start:string;end:string}) {
  const query = live ? {...live.query,dateRange:[range.start,range.end] as [string,string]} : null;
  const same = query?.dateRange.every((date,i)=>date===live!.query.dateRange[i]);
  const key = JSON.stringify([query,live?.state.status==="success"?live.state.data.data.queryId:live?.state.status]);
  const extra=useV2Resource(key,signal=>!query||same?Promise.resolve(null):fetchDailyDashboard(query,live!.metricIds,signal));
  const before=query?{...query,dateRange:[shiftDate(range.start,-((Date.parse(range.end)-Date.parse(range.start))/86400000+1)),shiftDate(range.start,-1)] as [string,string]}:null;
  const previous=useV2Resource(JSON.stringify([key,before,Boolean(live?.comparison)]),signal=>!before||same||!live?.comparison?Promise.resolve(null):fetchDailyDashboard(before,live.metricIds,signal));
  if(!live||!query||same)return live;
  const state:V2ResourceState<DailyDashboardSuccess>=extra.state.status==="success"?extra.state.data?{...extra.state,data:extra.state.data}:{status:"loading"}:extra.state;
  return {...live,query,state,retry:()=>{extra.retry();previous.retry();},comparison:live.comparison&&before?{...live.comparison,query:before,state:previous.state}:undefined};
}
export function connectedCohortRows(query: DailyDashboardQuery, state: V2ResourceState<DailyDashboardSuccess | null>): RetentionMatrixRow[] {
  const series = state.status === "success" ? state.data?.data.series ?? [] : [];
  const days = (Date.parse(query.dateRange[1]) - Date.parse(query.dateRange[0])) / 86400000 + 1;
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDate(query.dateRange[0], index);
    const read = (id: string) => series.find(series => series.metric.id === id)?.points.find(point => point.date === date);
    return { date, base: read("M020")?.inputs[1]?.value ?? null, cells: windows.map(([id, days]) => {
      const point = read(id);
      return { id, rate: point?.value ?? null, count: read("M115.d"+days)?.value ?? (point?.state === "available" || point?.state === "zero_denominator" ? point.inputs[0].value : null), availableAt: shiftDate(date, days),
        status: state.status === "loading" ? "读取中" : state.status === "failure" ? "读取失败" : point ? livePointStateLabel(point) + (state.refreshError ? " · 上次查询结果" : " · 待验数") : "字段未返回" };
    }) };
  });
}
export function ConnectedCohorts({ title, live, range, pending, open }: { title: string; live: LiveDashboardReading; range: {start:string;end:string}; pending:boolean; open:(title:string,content:ReactNode)=>void }) {
  const query = live.query, state = live.state, rows = connectedCohortRows(query, state);
  const tools = <PreviewExportControl name={title} dataOrigin="live" context={query.dateRange.join(" 至 ") + " · 注册日 · 待验数"} pending={pending || live.controls.dirty || !live.canExport || state.status !== "success"} scope="当前期及已启用对比期的注册日批次、人数与状态；矩阵展示当前期" onDownloadPreview={() => {
    if (!live.canExport || pending || live.controls.dirty || state.status !== "success") return;
    const periods=[{name:"当前注册留存",query,state},...(live.comparison?[{name:"对比注册留存",query:live.comparison.query,state:live.comparison.state}]:[])];
    downloadPreviewWorkbook(title, [{name:"数据说明",rows:liveExportMetadata(live)},...periods.map(period=>({name:period.name,rows:[["注册日","注册人数","留存周期","留存人数","留存率（%）","目标日","状态","平台","查询时间"],...connectedCohortRows(period.query,period.state).flatMap(row=>row.cells.map(cell=>[row.date,row.base,topicMetric(cell.id).name,cell.count,cell.rate===null?null:cell.rate*100,cell.availableAt,cell.status,query.pid,period.state.status==="success"?period.state.data?.data.fetchedAt??null:null]))]}))], "pending");
  }} />;
  return <DataOriginProvider value="pending"><DashboardPanel title={title} note={`注册日期 ${query.dateRange.join(" 至 ")} · ${live.platformName} · 观察未结束批次不计入汇总`}>
    <RetentionMatrix title={title} rows={rows} columns={windows.map(([id, days]) => ({id,name:topicMetric(id).name,label:days===1?"次日":"第 "+days+" 天",definition:topicMetric(id).definition}))} dateLabel="注册日期" baseLabel="注册用户数" onOpen={open} resetKey={JSON.stringify(query)} tools={tools} />
  </DashboardPanel></DataOriginProvider>;
}
