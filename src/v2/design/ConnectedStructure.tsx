import type { ReactNode } from "react";
import { GroupedTrend } from "../features/dashboards/GroupedTrend";
import { DataOriginBadge, DataOriginProvider } from "../components/DataOrigin";
import { liveValue, type LiveDashboardReading } from "../features/dashboards/LiveDashboardContext";
import { PreviewExportControl } from "../features/dashboards/PreviewExportControl";
import { CHART_PALETTE } from "../../theme/tokens";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { RefreshNotice } from "../components/StatePanel";
import { connectedStructureModel } from "./connected-structure-model";

export { liveStructureIds } from "./connected-structure-model";

export function ConnectedStructureContent({ live, title, id, dimension, open }: { live: LiveDashboardReading; title: string; id: string; dimension: string; open: (title: string, content: ReactNode) => void }) {
  const model = connectedStructureModel(live, id, dimension);
  const exported = <PreviewExportControl name={title} dataOrigin="live" pending={!live.canExport || live.controls.dirty || !model.hasCurrentResult}
    context={live.query.dateRange.join(" 至 ") + " · 待验数"} scope="当前分组完整日期，含基数和状态" onDownloadPreview={() => {
      if (!model.hasCurrentResult || !live.canExport || live.controls.dirty) return;
      downloadPreviewWorkbook(title, model.workbook, "pending");
    }} />;
  return <>{live.state.status === "failure" ? <RefreshNotice onRetry={live.retry}>真实结构读取失败，请重试。</RefreshNotice>
    : live.state.status === "success" && live.state.refreshError ? <RefreshNotice onRetry={live.retry}>结构刷新失败，当前保留上次查询结果。</RefreshNotice> : null}
    <GroupedTrend title={title} groups={model.groups.map((group, i) => ({ ...group, color: CHART_PALETTE[i] }))} points={model.points}
      kind={model.unit === "%" ? "line" : "bar"} unit={model.unit} format={value => liveValue(value, model.unit) + " " + model.unit}
      queryKey={JSON.stringify([live.query, id, dimension])} onOpen={open} exportAction={exported}
      summary={selected => <div className="topic-preview__group-summary">{model.summaries.filter(group => selected.includes(group.id)).map(group =>
        <section key={group.id}><span>{group.label}<DataOriginProvider value={live.metricIds.includes(group.id) ? "pending" : null}><DataOriginBadge /></DataOriginProvider></span>
          <strong>{liveValue(group.value, model.unit)} {model.unit}</strong><small>{group.summaryLabel}</small></section>
      )}</div>} />
  </>;
}
