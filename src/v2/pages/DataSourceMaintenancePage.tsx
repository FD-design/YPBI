import {
  AlertTriangle,
  CheckCircle2,
  Database,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  TestTubeDiagonal,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AdminRequestError,
  fetchDataSourceStatus,
  loginMaintenance,
  logoutMaintenance,
  testDataSource,
  updateDataSourceToken,
  type CredentialSite,
  type DataSourceStatus
} from "../api/adminDataSources";
import { StatePanel } from "../components/StatePanel";
import { useAuthentication } from "../app/AuthProvider";
import { ProductLink } from "../app/router";
import { useDialogBackdrop } from "../../components/ui/useDialogBackdrop";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import "./data-source-maintenance.css";

type AccessState =
  | { status: "checking" }
  | { status: "signed_out"; error?: AdminRequestError }
  | { status: "ready"; sources: DataSourceStatus[] }
  | { status: "disabled"; error: AdminRequestError }
  | { status: "failure"; error: AdminRequestError };

type Operation =
  | { kind: "idle" }
  | { kind: "login" | "logout" }
  | { kind: "current" | "candidate" | "save"; site: CredentialSite };

interface SiteNotice {
  tone: "neutral" | "pending" | "success" | "danger";
  message: string;
  checkedAt?: string;
}

const SITES: CredentialSite[] = ["primary", "secondary"];
const INITIAL_NOTICES: Record<CredentialSite, SiteNotice> = {
  primary: { tone: "neutral", message: "本次维护会话尚未检测" },
  secondary: { tone: "neutral", message: "本次维护会话尚未检测" }
};

function asAdminError(error: unknown, fallback: string) {
  return error instanceof AdminRequestError
    ? error
    : new AdminRequestError(fallback, { kind: "error", code: "ADMIN_REQUEST_FAILED", status: 0 });
}

function isLocalDevelopment() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "由服务器环境配置提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间不可识别";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function siteName(site: CredentialSite) {
  return site === "primary" ? "站1" : "站2";
}

function saveOutcomeUnknown(error: AdminRequestError) {
  return error.status === 0 || (error.status >= 500 && error.kind !== "upstream") || error.code === "INVALID_ADMIN_RESPONSE";
}

function SaveConfirmationDialog({
  site,
  busy,
  onCancel,
  onConfirm
}: {
  site: CredentialSite;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const backdrop = useDialogBackdrop(dialogRef, onCancel, !busy);
  useBodyScrollLock(true);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return <dialog
    {...backdrop}
    ref={dialogRef}
    className="v2-save-dialog"
    aria-labelledby={`save-title-${site}`}
    aria-describedby={`save-description-${site}`}
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
  >
    <div className="v2-save-dialog__icon"><AlertTriangle aria-hidden="true" /></div>
    <div><h2 id={`save-title-${site}`}>确认替换{siteName(site)}当前 Token？</h2><p id={`save-description-${site}`}>系统会再次验证候选凭证；收到成功结果后对全站所有用户的查询立即生效。若响应中断，页面会提示先核对当前连接。</p></div>
    <div className="v2-save-dialog__actions"><button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={onCancel} disabled={busy} autoFocus><X aria-hidden="true" />取消</button><button type="button" className="ui-button ui-button--primary ui-button--lg" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}确认验证并保存</button></div>
  </dialog>;
}

function SourceConnectionGuide() {
  return <section className="v2-source-guide" aria-label="真实数据接入步骤">
    <h2>接入真实数据</h2>
    <ol>
      <li><b>取得后台 Token</b><span>使用对应站点的后台账号；Token 与下方请求用户名必须配套。</span></li>
      <li><b>验证并保存</b><span>先验证候选凭证，保存成功后由 BI 服务端自动用于该站点查询。</span></li>
      <li><b>核对指标接入</b><span>逐项核对字段、口径与数据范围。<ProductLink href="/data/metrics">查看指标接入状态</ProductLink></span></li>
    </ol>
    <p>连接通过不等于所有指标可用；开发演示页保持演示数据，未接入的正式指标显示待接入。</p>
  </section>;
}

export function DataSourceMaintenancePage() {
  const authentication = useAuthentication();
  const csrfToken = authentication.state.status === "authenticated"
    ? authentication.state.session.csrfToken
    : "";
  const secureContext = window.location.protocol === "https:" || isLocalDevelopment();
  const [access, setAccess] = useState<AccessState>({ status: "checking" });
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [drafts, setDrafts] = useState<Record<CredentialSite, string>>({ primary: "", secondary: "" });
  const [notices, setNotices] = useState<Record<CredentialSite, SiteNotice>>(INITIAL_NOTICES);
  const [pageError, setPageError] = useState<AdminRequestError | null>(null);
  const [confirmingSite, setConfirmingSite] = useState<CredentialSite | null>(null);

  const closeSaveConfirmation = (site: CredentialSite) => {
    setConfirmingSite(null);
    window.requestAnimationFrame(() => document.getElementById(`save-token-${site}`)?.focus());
  };

  const clearSensitiveState = () => {
    setDrafts({ primary: "", secondary: "" });
    setNotices(INITIAL_NOTICES);
    setConfirmingSite(null);
  };

  const focusSiteFeedback = (site: CredentialSite, target: "status" | "input") => {
    window.requestAnimationFrame(() => document.getElementById(target === "status" ? `probe-status-${site}` : `token-${site}`)?.focus());
  };

  const handleAccessError = (error: unknown) => {
    const problem = asAdminError(error, "暂时无法连接数据源维护服务");
    setPageError(null);
    if (["login_required", "disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) clearSensitiveState();
    if (problem.kind === "login_required") setAccess({ status: "signed_out" });
    else if (problem.kind === "disabled") setAccess({ status: "disabled", error: problem });
    else setAccess({ status: "failure", error: problem });
  };

  const loadStatus = async (signal?: AbortSignal) => {
    const sources = await fetchDataSourceStatus(signal);
    setPageError(null);
    setAccess({ status: "ready", sources });
  };

  useEffect(() => {
    if (!secureContext) {
      setAccess({
        status: "failure",
        error: new AdminRequestError("数据源维护只允许通过 HTTPS 使用", { kind: "insecure", code: "HTTPS_REQUIRED", status: 426 })
      });
      return undefined;
    }
    const controller = new AbortController();
    loadStatus(controller.signal).catch((error) => {
      if (!controller.signal.aborted) handleAccessError(error);
    });
    return () => controller.abort();
  }, [secureContext]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operation.kind !== "idle" || password.length < 12) return;
    setOperation({ kind: "login" });
    try {
      await loginMaintenance(password, csrfToken);
      setPassword("");
      await loadStatus();
    } catch (error) {
      const problem = asAdminError(error, "维护登录失败");
      if (["disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) handleAccessError(problem);
      else setAccess({ status: "signed_out", error: problem });
    } finally {
      setPassword("");
      setOperation({ kind: "idle" });
    }
  };

  const logout = async () => {
    if (operation.kind !== "idle") return;
    setOperation({ kind: "logout" });
    setPageError(null);
    clearSensitiveState();
    try {
      await logoutMaintenance(csrfToken);
      setAccess({ status: "signed_out" });
    } catch (error) {
      const problem = asAdminError(error, "退出失败，服务端维护会话可能仍然有效，请重试");
      if (["disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) handleAccessError(problem);
      else setPageError(problem);
    } finally {
      setOperation({ kind: "idle" });
    }
  };

  const runSiteOperation = async (kind: "current" | "candidate" | "save", site: CredentialSite) => {
    if (operation.kind !== "idle" || access.status !== "ready") return;
    setPageError(null);
    const token = drafts[site].trim();
    if (kind !== "current" && (token.length < 16 || token.length > 4096)) {
      setNotices((current) => ({ ...current, [site]: { tone: "danger", message: "候选 Token 长度应为 16～4096 个字符" } }));
      return;
    }
    setOperation({ kind, site });
    setNotices((current) => ({ ...current, [site]: { tone: "pending", message: kind === "save" ? "正在再次验证并保存…" : "正在验证凭证探针…" } }));
    try {
      if (kind === "save") {
        const updated = await updateDataSourceToken(site, token, csrfToken);
        setAccess((current) => current.status === "ready"
          ? { status: "ready", sources: current.sources.map((item) => item.site === site ? updated : item) }
          : current);
        setNotices((current) => ({ ...current, [site]: { tone: "success", message: "候选 Token 已验证、保存并立即生效", checkedAt: updated.updatedAt ?? undefined } }));
        setDrafts((current) => ({ ...current, [site]: "" }));
        setConfirmingSite(null);
        focusSiteFeedback(site, "status");
      } else {
        const result = await testDataSource(site, csrfToken, kind === "candidate" ? token : undefined);
        setNotices((current) => ({
          ...current,
          [site]: {
            tone: "success",
            message: kind === "candidate" ? "候选 Token 验证通过，未保存，当前凭证未改变" : "当前凭证探针通过",
            checkedAt: result.checkedAt
          }
        }));
        focusSiteFeedback(site, "status");
      }
    } catch (error) {
      const problem = asAdminError(error, kind === "save" ? "更新失败" : "凭证探针失败");
      if (["login_required", "disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) {
        clearSensitiveState();
        setPageError(null);
        if (problem.kind === "login_required") setAccess({ status: "signed_out", error: problem });
        else handleAccessError(problem);
      } else {
        const unknown = kind === "save" && saveOutcomeUnknown(problem);
        const message = unknown
          ? "保存结果未确认。请先测试当前连接或刷新页面核对，不要直接假定旧凭证仍有效"
          : kind === "save"
            ? `${problem.message}；服务端已明确拒绝本次更新，原凭证保持不变`
            : kind === "candidate"
              ? `${problem.message}；候选 Token 未保存，可修改后重试`
              : problem.message;
        setNotices((current) => ({ ...current, [site]: { tone: "danger", message } }));
        focusSiteFeedback(site, unknown ? "status" : "input");
      }
    } finally {
      if (kind === "save") setConfirmingSite(null);
      setOperation({ kind: "idle" });
    }
  };

  if (access.status === "checking") {
    return <div className="v2-page" data-page="data-source-maintenance"><StatePanel kind="loading" title="正在检查维护会话" description="正在读取站点配置状态，不会读取或回显 Token 原文。" /></div>;
  }

  if (access.status === "disabled") {
    return <div className="v2-page" data-page="data-source-maintenance"><StatePanel kind="error" title="数据源维护尚未启用" description="服务器尚未配置独立维护密码。配置后才能进入受保护的维护页面。" code={access.error.code} /></div>;
  }

  if (access.status === "failure") {
    const insecure = access.error.kind === "insecure";
    const proxyMisconfigured = access.error.kind === "proxy_misconfigured";
    return <div className="v2-page" data-page="data-source-maintenance"><StatePanel
      kind="error"
      title={insecure ? "需要安全连接" : proxyMisconfigured ? "维护入口配置异常" : "暂时无法打开维护页面"}
      description={insecure
        ? "请改用本站的 HTTPS 地址后重试；Token 不允许通过普通 HTTP 传输。"
        : proxyMisconfigured
          ? "服务器未正确转发客户端来源信息，请联系运维检查反向代理后重试。"
          : access.error.message}
      code={access.error.code}
      requestId={access.error.requestId}
      action={insecure ? undefined : { label: "重新检查", onClick: () => { setAccess({ status: "checking" }); loadStatus().catch(handleAccessError); } }}
    /></div>;
  }

  if (access.status === "signed_out") {
    return <div className="v2-page" data-page="data-source-maintenance">
      <header className="v2-page-head"><div><span className="v2-eyebrow">管理中心</span><h1>数据源维护</h1><p>使用独立维护会话管理上游 Token，与普通 BI 登录及数据权限相互隔离。</p></div></header>
      <SourceConnectionGuide />
      <section className="v2-maintenance-login">
        <div className="v2-maintenance-login__intro"><ShieldCheck aria-hidden="true" /><div><h2>进入受保护配置</h2><p>维护会话有效期 30 分钟。连续输错 5 次后，当前来源会锁定 15 分钟。</p></div></div>
        <form onSubmit={login}>
          <label htmlFor="maintenance-password"><span>维护密码</span><input id="maintenance-password" type="password" autoComplete="current-password" minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} disabled={operation.kind === "login"} autoFocus /></label>
          {access.error && <div className="v2-inline-alert v2-inline-alert--danger" role="alert"><AlertTriangle aria-hidden="true" /><span>{access.error.message}{access.error.code && <small>错误代码：{access.error.code}</small>}</span></div>}
          <button type="submit" className="ui-button ui-button--primary ui-button--lg" disabled={operation.kind === "login" || password.length < 12}>{operation.kind === "login" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{operation.kind === "login" ? "正在验证" : "进入维护页面"}</button>
        </form>
      </section>
    </div>;
  }

  const busy = operation.kind !== "idle";
  return <div className="v2-page" data-page="data-source-maintenance">
    <header className="v2-page-head">
      <div><span className="v2-eyebrow">管理中心</span><h1>数据源维护</h1><p>所有已登录用户均可在此维护共享 Token；保存后对全站查询生效。日常查询由 BI 后端自动携带凭证。</p></div>
      <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={logout} disabled={busy}>{operation.kind === "logout" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <LogOut aria-hidden="true" />}退出维护</button>
    </header>

    <div className="v2-security-note"><ShieldCheck aria-hidden="true" /><div><b>凭证原文不会回显</b><span>输入值只提交给本站 BI 后端，本站页面不会写入浏览器本地存储。候选验证不会保存，验证并保存成功后才会替换当前凭证。</span></div></div>
    <SourceConnectionGuide />

    {pageError && <div className="v2-inline-alert v2-inline-alert--danger" role="alert"><AlertTriangle aria-hidden="true" /><span>{pageError.message}<small>退出未确认成功，请重试；在成功前服务端维护会话可能仍然有效。{pageError.code && ` 错误代码：${pageError.code}`}</small></span></div>}

    <section className="v2-source-grid" aria-label="上游数据源">
      {SITES.map((site) => {
        const source = access.sources.find((item) => item.site === site);
        const notice = notices[site];
        const siteOperation = operation.kind !== "idle" && "site" in operation && operation.site === site ? operation.kind : null;
        const draftLength = drafts[site].trim().length;
        const draftValid = draftLength >= 16 && draftLength <= 4096;
        return <article className="v2-source-card" key={site}>
          <header className="v2-source-card__head">
            <div className="v2-source-title"><Database aria-hidden="true" /><div><h2>{siteName(site)}</h2><span>{site === "primary" ? "主后台" : "第二后台"}</span></div></div>
            <span className={`v2-status-pill ${source?.configured ? "is-configured" : "is-unconfigured"}`}>{source?.configured ? "已配置" : "未配置"}</span>
          </header>

          <dl className="v2-source-facts">
            <div><dt>请求用户名</dt><dd>{source?.userName || "未配置"}</dd></div>
            <div><dt>当前 Token</dt><dd>{source?.tokenHint || "未配置"}</dd></div>
            <div><dt>Token 更新时间</dt><dd>{source?.configured ? formatTimestamp(source.updatedAt) : "尚未配置"}</dd></div>
            <div><dt>PID 路由范围</dt><dd>由服务器配置决定，当前接口不返回具体清单</dd></div>
          </dl>

          <div id={`probe-status-${site}`} className={`v2-probe-status is-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"} aria-live="polite" tabIndex={-1}>
            {notice.tone === "pending" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : notice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : notice.tone === "danger" ? <AlertTriangle aria-hidden="true" /> : <TestTubeDiagonal aria-hidden="true" />}
            <span><b>凭证探针</b>{notice.message}{notice.checkedAt && <small>检测时间：{formatTimestamp(notice.checkedAt)}</small>}</span>
          </div>

          <button type="button" className="ui-button ui-button--secondary ui-button--lg v2-test-current" disabled={busy || !source?.configured} onClick={() => runSiteOperation("current", site)}>{siteOperation === "current" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{siteOperation === "current" ? "正在测试" : "测试当前连接"}</button>

          <div className="v2-token-editor">
            <label htmlFor={`token-${site}`}><span>候选 Token</span><input id={`token-${site}`} type="password" autoComplete="off" data-1p-ignore="true" data-lpignore="true" autoCapitalize="none" spellCheck={false} minLength={16} maxLength={4096} aria-describedby={`token-help-${site}${draftLength > 0 && !draftValid ? ` token-error-${site}` : ""}`} placeholder="粘贴后可先仅验证，不保存" value={drafts[site]} onChange={(event) => { setDrafts((current) => ({ ...current, [site]: event.target.value })); setNotices((current) => ({ ...current, [site]: INITIAL_NOTICES[site] })); if (confirmingSite === site) setConfirmingSite(null); }} disabled={busy} /></label>
            <small id={`token-help-${site}`}><EyeOff aria-hidden="true" />仅更新 Token；请求地址、用户名与 PID 路由由服务器维护。</small>
            {draftLength > 0 && !draftValid && <p id={`token-error-${site}`} className="v2-field-error">Token 长度应为 16～4096 个字符</p>}
            <div className="v2-source-actions">
              <button type="button" className="ui-button ui-button--secondary ui-button--lg" disabled={busy || !draftValid} onClick={() => runSiteOperation("candidate", site)}>{siteOperation === "candidate" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <TestTubeDiagonal aria-hidden="true" />}{siteOperation === "candidate" ? "正在验证" : "仅验证，不保存"}</button>
              <button id={`save-token-${site}`} type="button" className="ui-button ui-button--primary ui-button--lg" disabled={busy || !draftValid} onClick={() => setConfirmingSite(site)}><Save aria-hidden="true" />验证并保存</button>
            </div>
          </div>

        </article>;
      })}
    </section>

    {confirmingSite && <SaveConfirmationDialog site={confirmingSite} busy={operation.kind === "save"} onCancel={() => closeSaveConfirmation(confirmingSite)} onConfirm={() => runSiteOperation("save", confirmingSite)} />}

    <p className="v2-maintenance-footnote">“凭证探针通过”仅说明该站点当前 Token 与用户名可以访问指定探针接口，不代表全部 PID、全部接口或指标已经验数。</p>
  </div>;
}
