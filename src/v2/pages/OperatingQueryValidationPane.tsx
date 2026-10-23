import { Download, LoaderCircle, Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AdminRequestError } from "../api/adminDataSources";
import { runOperatingValidation, type OperatingValidationReport, type ValidationSafeError } from "../api/operating-query-validation";
import { useDataEnvironment } from "../app/DataEnvironmentProvider";

const duration = (value?: number) => value === undefined ? "—" : `${(value / 1000).toFixed(1)} 秒`;
const GROUP_STATES = { waiting: "等待创建", creating: "正在创建", running: "等待任务与投影", complete: "已取得业务投影", failed: "读取失败", cancelled: "已停止等待" };
const PHASES = { query: "后台查询", projection: "BI投影", complete: "投影完成" };
function safeErrorText(error: ValidationSafeError) {
  return Object.entries(error).map(([key, value]) => `${key}=${value}`).join("；");
}
function defaultDate() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
}
function downloadEvidence(report: OperatingValidationReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `bi-operating-validation-production-${report.date}-${report.startedAt.replace(/[:.]/g, "-")}.json`;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function OperatingQueryValidationPane({ csrfToken, disabled, onBusyChange, onMaintenanceError }: {
  csrfToken: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onMaintenanceError: (error: AdminRequestError) => void;
}) {
  const environment = useDataEnvironment();
  const [date, setDate] = useState(defaultDate);
  const [report, setReport] = useState<OperatingValidationReport | null>(null);
  const [running, setRunning] = useState(false);
  const current = useRef({ onBusyChange, onMaintenanceError });
  current.current = { onBusyChange, onMaintenanceError };
  const run = useRef<{ controller: AbortController; generation: number } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; run.current?.controller.abort(); current.current.onBusyChange(false); };
  }, []);
  useEffect(() => { run.current?.controller.abort(); }, [environment.dataScopeKey]);
  const production = environment.state.status === "ready" && environment.state.mode === "production";
  const start = async () => {
    if (!production || disabled || run.current || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const controller = new AbortController(), id = ++generation.current;
    run.current = { controller, generation: id }; setRunning(true); current.current.onBusyChange(true);
    try {
      await runOperatingValidation(date, csrfToken, { signal: controller.signal,
        onUpdate: next => { if (mounted.current && run.current?.generation === id) setReport(next); },
        onMaintenanceError: error => current.current.onMaintenanceError(error) });
    } finally {
      if (run.current?.generation === id) {
        run.current = null;
        if (mounted.current) { setRunning(false); current.current.onBusyChange(false); }
      }
    }
  };
  const comparison = report?.comparison;
  return <details className="v2-operating-validation" data-testid="operating-validation">
    <summary>异步联调（不切换正式看板）</summary>
    <div className="v2-operating-validation__body">
      <p>仅正式数据：先按站点分组执行异步三步查询，再以相同日期、PID 和93列逐平台同步读取，比较三期业务投影。普通正式看板保持同步。</p>
      <div className="v2-operating-validation__controls">
        <label htmlFor="operating-validation-date"><span>业务日期</span><input id="operating-validation-date" type="date" value={date} max={defaultDate()} disabled={running || disabled} onChange={event => setDate(event.target.value)} /></label>
        <button type="button" className="ui-button ui-button--primary ui-button--lg" disabled={!production || running || disabled || !date || date > defaultDate()} onClick={start}><Play aria-hidden="true" />开始联调</button>
        <button type="button" className="ui-button ui-button--secondary ui-button--lg" disabled={!running} onClick={() => run.current?.controller.abort()}><Square aria-hidden="true" />停止等待</button>
        {report && <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={() => downloadEvidence(report)}><Download aria-hidden="true" />下载联调证据</button>}
      </div>
      {!production && <p className="v2-operating-validation__note" role="status">当前不是已确认的正式数据环境，不能运行联调。请先切回正式数据。</p>}
      {report && <>
        <p className="v2-operating-validation__note">本轮业务日 {report.date} · 正式数据</p>
        <p className="v2-operating-validation__summary" role="status" aria-live="polite">{running && <LoaderCircle className="is-spinning" aria-hidden="true" />}{report.status === "running" ? ({ capabilities: "读取联调范围", async: "异步查询与投影", sync: "同步对照读取", comparison: "逐格比较", finished: "整理证据" }[report.stage]) : report.status === "complete" ? "本轮读取与比较结束" : report.status === "cancelled" ? "已停止本地等待，后台任务状态未被改变" : "本轮联调未完成"} · 已用时 {duration(report.elapsedMs)}</p>
        {report.error && <p className="v2-operating-validation__error" role="alert">{safeErrorText(report.error)}</p>}
        <div className="v2-operating-validation__groups">{report.groups.map((group, index) => <article key={`${group.site}-${index}`}>
          <h3>{group.site === "primary" ? "站1" : "站2"} · {group.pids.length}个平台</h3>
          <p>{GROUP_STATES[group.state]} · reused：{group.reused === undefined ? "未取得" : group.reused ? "是" : "否"}</p>
          <p>{group.progress ? `${PHASES[group.progress.phase]} / ${group.progress.status} · ${group.progress.completedUnits ?? "—"}/${group.progress.totalUnits ?? "—"} · 尝试 ${group.progress.attempts ?? "—"}` : "任务进度尚未取得"}</p>
          <p>创建 {duration(group.createMs)} · 查询观察 {duration(group.queryMs)} · 投影观察 {duration(group.projectionMs)} · 异步总计 {duration(group.asyncMs)}</p>
          <p>同步返回 {group.syncCompleted}/{group.pids.length} · 读取失败 {group.syncFailed}</p>
          {group.error && <p className="v2-operating-validation__error">{safeErrorText(group.error)}</p>}
        </article>)}</div>
        {comparison && <div className="v2-operating-validation__comparison">
          <h3>同参数三期比较</h3>
          <p>适用格 {comparison.totalCells} · 字段一致 {comparison.matchedCells} · 差异 {comparison.differences.length} · 月活日比较不适用 {comparison.notApplicableCells}</p>
          <p>异步可用数值 {comparison.readyCells} · 非就绪 {comparison.nonReadyCells} · 范围问题 {comparison.scopeErrors.length}</p>
          <p className="v2-operating-validation__note">字段一致不等于数值验收通过；非就绪状态保留空值与计算输入，不补0。两次读取之间的数据成熟度或源数据变化需另行核查。</p>
          {comparison.scopeErrors.length > 0 && <p className="v2-operating-validation__error">{comparison.scopeErrors.join("；")}</p>}
          {comparison.differences.length > 0 && <ul>{comparison.differences.slice(0, 8).map(item => <li key={`${item.pid}-${item.columnKey}-${item.date}`}>{item.pid} / {item.columnKey} / {item.metricId} / {item.date}：{item.fields.join("、")}</li>)}</ul>}
        </div>}
        <p className="v2-operating-validation__note">证据包含已校验的异步候选、同步基线及浏览器观察阶段耗时，不是上游原始HTTP；不包含认证信息。停止、离开页面或切换环境会取消本地读取。</p>
      </>}
    </div>
  </details>;
}
