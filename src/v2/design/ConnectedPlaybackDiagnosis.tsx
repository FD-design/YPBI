import type { ComponentProps } from "react";
import { Download } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { ConnectedCategoryDimension, type ConnectedCategorySource } from "./ConnectedCategoryDimension";
import { demoUnit } from "./extended-board-model";
import { playbackDiagnosisComparisonIssue, playbackDiagnosisMetricModel, playbackDiagnosisNotice, playbackDiagnosisReading, playbackDiagnosisRows, playbackDiagnosisSheet, playbackDiagnosisSupported } from "./playback-diagnosis-model";
import { playbackGroupIdentity, playbackVideoTypeSheet } from "./live-playback-groups";
import { downloadPreviewWorkbook } from "./preview-workbook";
import { liveExportMetadata } from "../features/dashboards/LiveDashboardContext";

const source: ConnectedCategorySource = { rows: playbackDiagnosisRows, sheet: playbackDiagnosisSheet, supported: playbackDiagnosisSupported,
  notice: playbackDiagnosisNotice, reading: playbackDiagnosisReading,
  detailModel: playbackDiagnosisMetricModel, comparisonIssue: playbackDiagnosisComparisonIssue,
  detailExport: (live, row) => { const group = playbackGroupIdentity(row.seriesId); return group ? <Button onClick={() => downloadPreviewWorkbook("播放质量诊断", [
    { name: "00_导出说明", rows: liveExportMetadata(live) }, playbackVideoTypeSheet(live, [group.id], group.key)
  ], "pending")}><Download size={14} />导出</Button> : undefined; },
  unit: (_live, id) => demoUnit(id), guidanceKey: "playback.diagnosis", inlineInputs: true };

export function ConnectedPlaybackDiagnosis(props: Omit<ComponentProps<typeof ConnectedCategoryDimension>, "source" | "renderSelect">) {
  return <ConnectedCategoryDimension {...props} source={source} />;
}
