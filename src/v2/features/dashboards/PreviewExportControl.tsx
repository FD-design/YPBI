import { Button } from "../../../components/ui/Button";
import { FloatingHint, restoreReadingFocus } from "../../../components/ui/FloatingHint";
import { Download, X } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { useBodyScrollLock } from "../../../components/layout/useBodyScrollLock";
import { useDialogBackdrop } from "../../../components/ui/useDialogBackdrop";
import { LiveHeaderExportContext, liveDataEnvironment, useLiveDashboard } from "./LiveDashboardContext";
import { dataEnvironmentLabel } from "../../api/daily-dashboard-environment";
import type { DataEnvironmentMode } from "../../api/dataEnvironmentPreference";

/** 下载能力按结果来源显式提供；未接入服务时展示范围与不可下载原因。 */
export function PreviewExportControl({ name, scope, context, pending = false, iconOnly = false, onDownloadPreview, unavailableReason, dataOrigin = "demo", dataEnvironment }: { name: string; scope: string; context: string; pending?: boolean; iconOnly?: boolean; onDownloadPreview?: () => void; unavailableReason?: string; dataOrigin?: "demo" | "mixed" | "live"; dataEnvironment?: DataEnvironmentMode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const live = useLiveDashboard(), header = useContext(LiveHeaderExportContext);
  const realSource = header && live && live.metricIds.length > 0 ? {
    pending: live.controls.dirty || live.state.status !== "success",
    context: `${dataEnvironmentLabel(liveDataEnvironment(live))} · ${live.platformName} · ${live.query.dateRange.join(" 至 ")} · 待验数`
  } : undefined;
  const realExport = realSource && live?.canExport ? { ...realSource, download: live.controls.export } : undefined;
  const sourceContext = dataOrigin === "demo" ? context : `${dataEnvironmentLabel(dataEnvironment)}${dataOrigin === "mixed" ? "（真实部分）" : ""} · ${context}`;
  return <>
    <FloatingHint content={`导出${name}`}><button ref={trigger} className={iconOnly ? "ui-icon-button" : "ui-button ui-button--sm core-review__export-action"} type="button" aria-label={`导出${name}`} onClick={() => setOpen(true)}><Download aria-hidden="true" />{!iconOnly && "导出"}</button></FloatingHint>
    {open && <ExportDialog name={name} scope={scope} context={sourceContext} pending={pending} onDownloadPreview={onDownloadPreview} unavailableReason={unavailableReason} dataOrigin={dataOrigin} realSource={realSource} realExport={realExport} onClose={() => { setOpen(false); restoreReadingFocus(trigger.current); }} />}
  </>;
}
function ExportDialog({ name, scope, context, pending, onClose, onDownloadPreview, unavailableReason, dataOrigin = "demo", realSource, realExport }: { name: string; scope: string; context: string; pending: boolean; onClose: () => void; onDownloadPreview?: () => void; unavailableReason?: string; dataOrigin?: "demo" | "mixed" | "live"; realSource?: { pending: boolean; context: string }; realExport?: { download: () => void; pending: boolean; context: string } }) {
  const [error, setError] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  useBodyScrollLock(true);
  useEffect(() => { ref.current?.showModal(); const dialog = ref.current; return () => dialog?.close(); }, []);
  const close = () => { ref.current?.close(); onClose(); };
  const backdrop = useDialogBackdrop(ref, close);
  const hasDemo = Boolean(onDownloadPreview && dataOrigin === "demo");
  return <dialog {...backdrop} ref={ref} className="v2-metric-detail" aria-label={`导出${name}`} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}>
    <header className="v2-metric-detail__head"><div><h2>导出{name}</h2><p>XLSX · 完整聚合结果</p></div><button className="v2-icon-button" type="button" aria-label="关闭导出" onClick={close} autoFocus><X /></button></header>
    <div className="v2-metric-detail__body" tabIndex={0} aria-label="导出范围"><h3>导出范围</h3><p>{scope}</p><p>{realSource ? hasDemo ? "真实结果与演示样例使用独立下载入口；演示样例为固定合成数据，仅供界面核对。" : "真实结果以当前已应用查询为范围，保留待验数状态。" : context}</p><h3>文件结构</h3><p>导出说明、业务结果、数据状态与限制。保留查询实际范围、指标口径版本及必要基准；临时显隐与分页不裁剪结果。</p>
      <div className="v2-warning-list" role="status"><p>{realSource ? !realExport ? "当前账号没有真实结果导出权限。" : realSource.pending ? "真实查询尚未完成或条件尚未应用，暂不能下载真实结果。" : hasDemo ? "真实后台结果标记待验数；演示样例不用于经营结论，也不与真实结果混算。" : "将下载真实后台结果，标记待验数。" : pending ? "当前条件尚未应用或没有可导出的结果，请恢复有效条件后再导出。" : onDownloadPreview ? dataOrigin === "live" ? "将下载真实后台结果，标记待验数。" : dataOrigin === "mixed" ? "文件分开标明真实待验数与演示数据；两种来源独立计算。" : "将下载标注为“演示数据”的 XLSX 文件，仅供界面核对，不是正式业务结果。" : unavailableReason ?? "当前页面使用固定演示数据，正式查询与导出服务尚未接入，暂不可下载。"}</p>{error && <p role="alert">{error}</p>}</div>
    </div>
    {realSource && <p className="dashboard-table-context">真实数据：{realSource.context}。{hasDemo && "真实结果与演示样例使用独立下载入口。"}</p>}
    <footer className="v2-metric-detail__foot">{realExport && <Button variant="primary" type="button" disabled={realExport.pending} onClick={() => { try { realExport.download(); close(); } catch { setError("导出未完成，请重试。"); } }}>下载真实 XLSX</Button>}<Button variant={realExport ? "secondary" : "primary"} type="button" disabled={pending || !onDownloadPreview} onClick={() => { try { onDownloadPreview?.(); close(); } catch { setError("导出未完成，请重试；当前结果未改变。"); } }}>{onDownloadPreview && dataOrigin === "demo" ? "下载演示 XLSX" : "下载 XLSX"}</Button></footer>
  </dialog>;
}
