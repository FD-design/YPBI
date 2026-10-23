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
  activateDataPreview,
  deactivateDataPreview,
  fetchDataSourceStatus,
  fetchDataPreviewStatus,
  loginMaintenance,
  logoutMaintenance,
  testDataSource,
  updateDataSourceToken,
  type CredentialSite,
  type DataPreviewStatus,
  type DataSourceStatus
} from "../api/adminDataSources";
import { StatePanel } from "../components/StatePanel";
import { useAuthentication } from "../app/AuthProvider";
import { ProductLink } from "../app/router";
import { useDialogBackdrop } from "../../components/ui/useDialogBackdrop";
import { useBodyScrollLock } from "../../components/layout/useBodyScrollLock";
import "./data-source-maintenance.css";
import { useDataEnvironment } from "../app/DataEnvironmentProvider";
import { OperatingQueryValidationPane } from "./OperatingQueryValidationPane";

type AccessState =
  | { status: "checking" }
  | { status: "signed_out"; error?: AdminRequestError }
  | { status: "ready"; sources: DataSourceStatus[]; preview: DataPreviewStatus }
  | { status: "disabled"; error: AdminRequestError }
  | { status: "failure"; error: AdminRequestError };

type Operation =
  | { kind: "idle" }
  | { kind: "login" | "logout" | "preview_activate" | "preview_deactivate" | "preview_check" | "validation" }
  | { kind: "current" | "candidate" | "save"; site: CredentialSite };

interface SiteNotice {
  tone: "neutral" | "pending" | "success" | "danger";
  message: string;
  checkedAt?: string;
  code?: string;
  requestId?: string;
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

function validUpstreamUserName(value: string) {
  return value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
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
    <div><h2 id={`save-title-${site}`}>确认更新{siteName(site)}共享凭据？</h2><p id={`save-description-${site}`}>系统会再次验证本次后台用户名与候选 Token；成功后立即用于该站全站所有用户的查询。若响应中断，页面会提示先核对当前连接。</p></div>
    <div className="v2-save-dialog__actions"><button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={onCancel} disabled={busy} autoFocus><X aria-hidden="true" />取消</button><button type="button" className="ui-button ui-button--primary ui-button--lg" onClick={onConfirm} disabled={busy}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Save aria-hidden="true" />}确认验证并保存</button></div>
  </dialog>;
}

function SourceConnectionGuide() {
  return <section className="v2-source-guide" aria-label="真实数据接入步骤">
    <h2>接入真实数据</h2>
    <ol>
      <li><b>取得后台 Token</b><span>使用对应站点的后台账号；通常沿用当前用户名，换账号时再同步修改。</span></li>
      <li><b>验证并保存</b><span>先验证候选凭证，保存成功后由 BI 服务端自动用于该站点查询。</span></li>
      <li><b>核对指标接入</b><span>逐项核对字段、口径与数据范围。<ProductLink href="/data/metrics">查看指标接入状态</ProductLink></span></li>
    </ol>
    <p>连接通过不等于所有指标可用；切换数据环境后，已完成映射的页面读取对应后台数据，未接入指标明确显示待接入，不使用演示值补齐。</p>
  </section>;
}

export function DataSourceMaintenancePage({ purpose = "credentials" }: { purpose?: "credentials" | "operating-validation" }) {
  const technical = purpose === "operating-validation";
  const pageName = technical ? "technical-operating-validation" : "data-source-maintenance";
  const authentication = useAuthentication();
  const dataEnvironment = useDataEnvironment();
  const csrfToken = authentication.state.status === "authenticated"
    ? authentication.state.session.csrfToken
    : "";
  const secureContext = window.location.protocol === "https:" || isLocalDevelopment();
  const [access, setAccess] = useState<AccessState>({ status: "checking" });
  const [operation, setOperation] = useState<Operation>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [drafts, setDrafts] = useState<Record<CredentialSite, string>>({ primary: "", secondary: "" });
  const [userNameDrafts, setUserNameDrafts] = useState<Record<CredentialSite, string>>({ primary: "", secondary: "" });
  const [editingUserNames, setEditingUserNames] = useState<Record<CredentialSite, boolean>>({ primary: false, secondary: false });
  const [notices, setNotices] = useState<Record<CredentialSite, SiteNotice>>(INITIAL_NOTICES);
  const [pageError, setPageError] = useState<AdminRequestError | null>(null);
  const [confirmingSite, setConfirmingSite] = useState<CredentialSite | null>(null);
  const [previewToken, setPreviewToken] = useState("");
  const [previewNotice, setPreviewNotice] = useState<SiteNotice>({ tone: "neutral", message: "测试 Token 仅用于当前登录会话，不会替换正式凭据" });
  const [previewVerification, setPreviewVerification] = useState<"confirmed" | "checking" | "unknown">("checking");
  const statusGeneration = useRef(0);
  const statusController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const deferredCheck = useRef(false);
  const latest = useRef({ access, operation, dataEnvironment });
  latest.current = { access, operation, dataEnvironment };

  const invalidateStatusCheck = () => {
    statusGeneration.current++;
    statusController.current?.abort();
    statusController.current = null;
  };
  const beginOperation = (next: Operation) => {
    if (statusController.current) deferredCheck.current = true;
    invalidateStatusCheck();
    if (next.kind === "preview_activate") setPreviewVerification("checking");
    latest.current.operation = next;
    setOperation(next);
  };
  const finishOperation = () => {
    if (!mounted.current) return;
    latest.current.operation = { kind: "idle" };
    setOperation({ kind: "idle" });
  };

  const focusAfterRender = (id: string) => {
    const previousFocus = document.activeElement;
    window.requestAnimationFrame(() => {
      if (!mounted.current || document.activeElement !== previousFocus && document.activeElement !== document.body) return;
      document.getElementById(id)?.focus();
    });
  };

  const closeSaveConfirmation = (site: CredentialSite) => {
    setConfirmingSite(null);
    focusAfterRender(`save-token-${site}`);
  };

  const clearSensitiveState = () => {
    setDrafts({ primary: "", secondary: "" });
    setUserNameDrafts({ primary: "", secondary: "" });
    setEditingUserNames({ primary: false, secondary: false });
    setNotices(INITIAL_NOTICES);
    setConfirmingSite(null);
    setPreviewToken("");
  };

  const focusSiteFeedback = (site: CredentialSite, target: "status" | "token" | "userName") => {
    const id = target === "status" ? `probe-status-${site}` : target === "userName" ? `username-${site}` : `token-${site}`;
    focusAfterRender(id);
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
    invalidateStatusCheck();
    const generation = ++statusGeneration.current;
    const controller = new AbortController();
    statusController.current = controller;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const isCurrent = () => mounted.current && generation === statusGeneration.current && !controller.signal.aborted;
    setPreviewVerification("checking");
    try {
      const [sources, returned] = await Promise.all([fetchDataSourceStatus(controller.signal), fetchDataPreviewStatus(controller.signal)]);
      if (!isCurrent()) return;
      const preview = returned.active && (!returned.expiresAt || Date.parse(returned.expiresAt) <= Date.now())
        ? { ...returned, active: false, expiresAt: null } : returned;
      const previous = latest.current.access;
      setPageError(null);
      setAccess({ status: "ready", sources, preview });
      setPreviewVerification("confirmed");
      setPreviewNotice(current => preview.active && current.tone === "success" ? current : { tone: "neutral", message: preview.active ? "测试临时会话有效，数据查询仍按所选环境执行"
        : previous.status === "ready" && previous.preview.active || latest.current.dataEnvironment.state.mode === "test"
          ? "测试数据会话未启用或已失效，请重新验证测试 Token" : "测试 Token 仅用于当前登录会话，不会替换正式凭据" });
      if (!preview.active && latest.current.dataEnvironment.state.mode === "test" && latest.current.dataEnvironment.state.status === "ready") void latest.current.dataEnvironment.refresh();
      return preview;
    } catch (error) {
      if (!isCurrent()) return;
      setPreviewVerification("unknown");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (statusController.current === controller) statusController.current = null;
    }
  };

  const recheckStatus = () => {
    if (!secureContext || !mounted.current || document.visibilityState !== "visible" || latest.current.access.status !== "ready") return;
    if (latest.current.operation.kind !== "idle") { deferredCheck.current = true; return; }
    if (statusController.current) return;
    void loadStatus().catch(error => {
      const problem = asAdminError(error, "暂时无法确认测试数据会话");
      if (["login_required", "disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) handleAccessError(problem);
      else setPreviewNotice({ tone: "danger", message: "暂时无法确认测试数据会话；当前状态待确认，请恢复网络后重新检查", code: problem.code, requestId: problem.requestId });
    });
  };

  useEffect(() => {
    if (operation.kind !== "idle" || !deferredCheck.current) return;
    deferredCheck.current = false;
    recheckStatus();
  }, [operation.kind, access.status]);

  useEffect(() => {
    mounted.current = true;
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
    window.addEventListener("focus", recheckStatus);
    window.addEventListener("pageshow", recheckStatus);
    document.addEventListener("visibilitychange", recheckStatus);
    return () => {
      mounted.current = false;
      invalidateStatusCheck();
      controller.abort();
      window.removeEventListener("focus", recheckStatus);
      window.removeEventListener("pageshow", recheckStatus);
      document.removeEventListener("visibilitychange", recheckStatus);
    };
  }, [secureContext]);

  const previewExpiresAt = access.status === "ready" && access.preview.active ? access.preview.expiresAt : null;
  useEffect(() => {
    if (!previewExpiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = Date.parse(previewExpiresAt) - Date.now();
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); return; }
      if (latest.current.operation.kind === "preview_activate") { deferredCheck.current = true; return; }
      if (latest.current.access.status !== "ready" || latest.current.access.preview.expiresAt !== previewExpiresAt) return;
      setAccess(current => current.status === "ready" && current.preview.expiresAt === previewExpiresAt
        ? { ...current, preview: { ...current.preview, active: false, expiresAt: null } } : current);
      setPreviewNotice({ tone: "neutral", message: "测试数据会话已到期，请重新验证测试 Token" });
      recheckStatus();
    };
    timer = setTimeout(expire, Math.max(0, Math.min(Date.parse(previewExpiresAt) - Date.now(), 2_147_000_000)));
    return () => clearTimeout(timer);
  }, [previewExpiresAt]);

  useEffect(() => {
    if (dataEnvironment.state.mode !== "test") return;
    if (dataEnvironment.state.status === "expired") {
      setAccess(current => current.status === "ready" ? { ...current, preview: { ...current.preview, active: false, expiresAt: null } } : current);
      setPreviewNotice({ tone: "danger", message: dataEnvironment.state.message });
    } else if (dataEnvironment.state.status === "unconfirmed") {
      setPreviewNotice({ tone: "danger", message: dataEnvironment.state.message });
    }
  }, [dataEnvironment.state]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (operation.kind !== "idle" || password.length < 12) return;
    beginOperation({ kind: "login" });
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
      finishOperation();
    }
  };

  const logout = async () => {
    if (operation.kind !== "idle") return;
    beginOperation({ kind: "logout" });
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
      finishOperation();
    }
  };

  const runSiteOperation = async (kind: "current" | "candidate" | "save", site: CredentialSite) => {
    if (operation.kind !== "idle" || access.status !== "ready") return;
    setPageError(null);
    const token = drafts[site].trim();
    const source = access.sources.find((item) => item.site === site);
    const editingUserName = kind !== "current" && editingUserNames[site];
    const userName = kind === "current" ? "" : (editingUserName ? userNameDrafts[site] : source?.userName ?? "").trim();
    if (kind !== "current" && (token.length < 16 || token.length > 4096)) {
      setNotices((current) => ({ ...current, [site]: { tone: "danger", message: "候选 Token 长度应为 16～4096 个字符" } }));
      focusSiteFeedback(site, "token");
      return;
    }
    if (kind !== "current" && (userName.length < 1 || userName.length > 256)) {
      setEditingUserNames((current) => ({ ...current, [site]: true }));
      setNotices((current) => ({ ...current, [site]: { tone: "danger", message: "请先填写 1～256 个字符的候选后台用户名" } }));
      focusSiteFeedback(site, "userName");
      return;
    }
    if (kind !== "current" && !validUpstreamUserName(userName)) {
      setNotices((current) => ({ ...current, [site]: { tone: "danger", message: "候选后台用户名不能包含控制字符" } }));
      focusSiteFeedback(site, "userName");
      return;
    }
    beginOperation({ kind, site });
    setNotices((current) => ({ ...current, [site]: { tone: "pending", message: kind === "save" ? "正在再次验证并保存…" : "正在验证凭证探针…" } }));
    try {
      if (kind === "save") {
        const updated = await updateDataSourceToken(site, token, csrfToken, editingUserName ? userName : undefined);
        setAccess((current) => current.status === "ready"
          ? { ...current, sources: current.sources.map((item) => item.site === site ? updated : item) }
          : current);
        setNotices((current) => ({ ...current, [site]: { tone: "success", message: "候选凭据已验证、保存并立即生效", checkedAt: updated.updatedAt ?? undefined } }));
        setDrafts((current) => ({ ...current, [site]: "" }));
        setUserNameDrafts((current) => ({ ...current, [site]: updated.userName }));
        setEditingUserNames((current) => ({ ...current, [site]: false }));
        setConfirmingSite(null);
        focusSiteFeedback(site, "status");
      } else {
        const result = await testDataSource(site, csrfToken, kind === "candidate" ? token : undefined, kind === "candidate" && editingUserName ? userName : undefined);
        setNotices((current) => ({
          ...current,
          [site]: {
            tone: "success",
            message: kind === "candidate" ? "候选凭据验证通过，未保存，当前凭证未改变" : "当前凭证探针通过",
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
            ? `${problem.message}；服务端已明确拒绝本次更新，原后台账号与 Token 保持不变`
            : kind === "candidate"
              ? `${problem.message}；候选凭据未保存，可修改后重试`
              : problem.message;
        setNotices((current) => ({ ...current, [site]: { tone: "danger", message, code: problem.code, requestId: problem.requestId } }));
        focusSiteFeedback(site, unknown ? "status" : "token");
      }
    } finally {
      if (kind === "save") setConfirmingSite(null);
      finishOperation();
    }
  };

  const activatePreview = async () => {
    if (operation.kind !== "idle" || access.status !== "ready") return;
    const token = previewToken.trim();
    if (token.length < 16 || token.length > 4096) {
      setPreviewNotice({ tone: "danger", message: "测试 Token 长度应为 16～4096 个字符" });
      return;
    }
    beginOperation({ kind: "preview_activate" });
    setPreviewNotice({ tone: "pending", message: "正在验证测试后台并创建临时会话…" });
    try {
      const activated = await activateDataPreview(token, csrfToken);
      setPreviewToken("");
      setAccess((current) => current.status === "ready" ? { ...current, preview: { enabled: true, active: true, userName: activated.userName, expiresAt: activated.expiresAt } } : current);
      setPreviewVerification("confirmed");
      dataEnvironment.activateTest({ mode: "test", testAvailable: true, userName: activated.userName, expiresAt: activated.expiresAt });
      setPreviewNotice({ tone: "success", message: "测试数据模式已开启；当前浏览器会话中的新版 BI 查询将使用本次测试 Token" });
    } catch (error) {
      const problem = asAdminError(error, "测试数据模式开启失败");
      setPreviewVerification("unknown");
      if (problem.kind === "login_required") handleAccessError(problem);
      else setPreviewNotice({ tone: "danger", message: `${problem.message}；未切换数据环境，正式数据保持不变` });
    } finally {
      finishOperation();
    }
  };

  const deactivatePreview = async () => {
    if (operation.kind !== "idle" || access.status !== "ready") return;
    beginOperation({ kind: "preview_deactivate" });
    setPreviewNotice({ tone: "pending", message: "正在退出测试数据模式…" });
    try {
      await deactivateDataPreview(csrfToken);
      dataEnvironment.useProduction();
      setAccess((current) => current.status === "ready" ? { ...current, preview: { ...current.preview, active: false, expiresAt: null } } : current);
      setPreviewNotice({ tone: "success", message: "已切回正式数据，测试 Token 已从服务端临时会话移除" });
    } catch (error) {
      const problem = asAdminError(error, "退出测试数据模式失败");
      setPreviewNotice({ tone: "danger", message: problem.message });
    } finally {
      finishOperation();
    }
  };

  const enterExistingPreview = async () => {
    if (latest.current.operation.kind !== "idle") return;
    beginOperation({ kind: "preview_check" });
    try {
      const preview = await loadStatus();
      if (preview?.active && preview.userName && preview.expiresAt && Date.parse(preview.expiresAt) > Date.now()) {
        latest.current.dataEnvironment.activateTest({ mode: "test", testAvailable: true, userName: preview.userName, expiresAt: preview.expiresAt });
      }
    } catch (error) {
      const problem = asAdminError(error, "暂时无法确认测试数据会话");
      if (["login_required", "disabled", "insecure", "proxy_misconfigured"].includes(problem.kind)) handleAccessError(problem);
      else setPreviewNotice({ tone: "danger", message: "暂时无法确认测试数据会话，未切换数据环境", code: problem.code, requestId: problem.requestId });
    } finally { finishOperation(); }
  };

  if (access.status === "checking") {
    return <div className="v2-page" data-page={pageName}><StatePanel kind="loading" title="正在检查维护会话" description={technical ? "正在确认受保护技术验收所需的维护会话。" : "正在读取站点配置状态，不会读取或回显 Token 原文。"} /></div>;
  }

  if (access.status === "disabled") {
    return <div className="v2-page" data-page={pageName}><StatePanel kind="error" title="数据源维护尚未启用" description="服务器尚未配置独立维护密码。配置后才能进入受保护的维护页面。" code={access.error.code} /></div>;
  }

  if (access.status === "failure") {
    const insecure = access.error.kind === "insecure";
    const proxyMisconfigured = access.error.kind === "proxy_misconfigured";
    return <div className="v2-page" data-page={pageName}><StatePanel
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
    return <div className="v2-page" data-page={pageName}>
      <header className="v2-page-head"><div><span className="v2-eyebrow">{technical ? "技术工具" : "管理中心"}</span><h1>{technical ? "技术验收" : "数据源维护"}</h1><p>{technical ? "使用既有独立维护会话进行受保护联调，不修改连接凭据，不切换普通正式看板。" : "使用独立维护会话管理上游 Token，与普通 BI 登录及数据权限相互隔离。"}</p></div></header>
      {!technical && <SourceConnectionGuide />}
      <section className="v2-maintenance-login">
        <div className="v2-maintenance-login__intro"><ShieldCheck aria-hidden="true" /><div><h2>进入受保护配置</h2><p>维护会话有效期 15 天。连续输错 5 次后，当前来源会锁定 15 分钟。</p></div></div>
        <form onSubmit={login}>
          <label htmlFor="maintenance-password"><span>维护密码</span><input id="maintenance-password" type="password" autoComplete="current-password" minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} disabled={operation.kind === "login"} autoFocus /></label>
          {access.error && <div className="v2-inline-alert v2-inline-alert--danger" role="alert"><AlertTriangle aria-hidden="true" /><span>{access.error.message}{access.error.code && <small>错误代码：{access.error.code}</small>}</span></div>}
          <button type="submit" className="ui-button ui-button--primary ui-button--lg" disabled={operation.kind === "login" || password.length < 12}>{operation.kind === "login" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}{operation.kind === "login" ? "正在验证" : "进入维护页面"}</button>
        </form>
      </section>
    </div>;
  }

  const busy = operation.kind !== "idle";
  const displayedVerification = dataEnvironment.state.mode === "test" && dataEnvironment.state.status === "unconfirmed" ? "unknown" : previewVerification;
  if (technical) return <div className="v2-page" data-page={pageName}>
    <header className="v2-page-head">
      <div><span className="v2-eyebrow">技术工具</span><h1>技术验收</h1><p>经营异步与同步的受保护同参数对照，不修改连接凭据，不切换普通正式看板。</p></div>
      <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={logout} disabled={busy}>{operation.kind === "logout" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <LogOut aria-hidden="true" />}退出维护</button>
    </header>
    {pageError && <div className="v2-inline-alert v2-inline-alert--danger" role="alert"><AlertTriangle aria-hidden="true" /><span>{pageError.message}<small>退出未确认成功，请重试；在成功前服务端维护会话可能仍然有效。{pageError.code && ` 错误代码：${pageError.code}`}</small></span></div>}
    <OperatingQueryValidationPane csrfToken={csrfToken} disabled={busy && operation.kind !== "validation"}
      onBusyChange={running => { if (running) beginOperation({ kind: "validation" }); else if (latest.current.operation.kind === "validation") finishOperation(); }}
      onMaintenanceError={handleAccessError} />
  </div>;
  return <div className="v2-page" data-page="data-source-maintenance">
    <header className="v2-page-head">
      <div><span className="v2-eyebrow">管理中心</span><h1>数据源维护</h1><p>所有已登录用户均可在此维护共享凭据；保存后对全站查询生效。日常查询由 BI 后端自动携带凭证。</p></div>
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
        const currentUserName = (source?.userName ?? "").trim();
        const editingUserName = editingUserNames[site];
        const candidateUserName = (editingUserName ? userNameDrafts[site] : currentUserName).trim();
        const candidateUserNameValid = validUpstreamUserName(candidateUserName);
        return <article className="v2-source-card" key={site}>
          <header className="v2-source-card__head">
            <div className="v2-source-title"><Database aria-hidden="true" /><div><h2>{siteName(site)}</h2><span>{site === "primary" ? "主后台" : "第二后台"}</span></div></div>
            <span className={`v2-status-pill ${source?.configured ? "is-configured" : "is-unconfigured"}`}>{source?.configured ? "已配置" : "未配置"}</span>
          </header>

          <dl className="v2-source-facts">
            <div><dt>当前后台用户名</dt><dd>{currentUserName || "未配置（需先设置）"} <button type="button" className="ui-button ui-button--ghost ui-button--lg v2-source-account-action" aria-expanded={editingUserName} aria-controls={`username-editor-${site}`} disabled={busy} onClick={() => {
              const nextEditing = !editingUserName;
              setUserNameDrafts((current) => ({ ...current, [site]: source?.userName ?? "" }));
              setEditingUserNames((current) => ({ ...current, [site]: nextEditing }));
              setNotices((current) => ({ ...current, [site]: INITIAL_NOTICES[site] }));
              if (confirmingSite === site) setConfirmingSite(null);
              if (nextEditing) focusSiteFeedback(site, "userName");
            }}>{editingUserName ? "取消修改" : currentUserName ? "修改" : "设置"}</button></dd></div>
            <div><dt>当前 Token</dt><dd>{source?.tokenHint || "未配置"}</dd></div>
            <div><dt>Token 更新时间</dt><dd>{source?.configured ? formatTimestamp(source.updatedAt) : "尚未配置"}</dd></div>
            <div><dt>PID 路由范围</dt><dd>由服务器配置决定，当前接口不返回具体清单</dd></div>
          </dl>

          <div id={`probe-status-${site}`} className={`v2-probe-status is-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"} aria-live="polite" tabIndex={-1}>
            {notice.tone === "pending" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : notice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : notice.tone === "danger" ? <AlertTriangle aria-hidden="true" /> : <TestTubeDiagonal aria-hidden="true" />}
            <span><b>凭证探针</b>{notice.message}{notice.checkedAt && <small>检测时间：{formatTimestamp(notice.checkedAt)}</small>}{(notice.code || notice.requestId) && <small>{notice.code && `错误代码：${notice.code}`}{notice.code && notice.requestId && "；"}{notice.requestId && `请求 ID：${notice.requestId}`}</small>}</span>
          </div>

          <button type="button" className="ui-button ui-button--secondary ui-button--lg v2-test-current" disabled={busy || !source?.configured} onClick={() => runSiteOperation("current", site)}>{siteOperation === "current" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{siteOperation === "current" ? "正在测试" : "测试当前连接"}</button>

          <div className="v2-token-editor" id={`username-editor-${site}`}>
            {editingUserName && <>
              <label htmlFor={`username-${site}`}><span>候选后台用户名</span><input id={`username-${site}`} type="text" autoComplete="off" data-1p-ignore="true" data-lpignore="true" autoCapitalize="none" spellCheck={false} minLength={1} maxLength={256} aria-describedby={`username-help-${site}${candidateUserNameValid ? "" : ` username-error-${site}`}`} placeholder="填写与候选 Token 配套的后台用户名" value={userNameDrafts[site]} onChange={(event) => { setUserNameDrafts((current) => ({ ...current, [site]: event.target.value })); setNotices((current) => ({ ...current, [site]: INITIAL_NOTICES[site] })); if (confirmingSite === site) setConfirmingSite(null); }} disabled={busy} /></label>
              <small id={`username-help-${site}`}>只在更换后台账号时修改；保存后该站全站共用新的用户名与 Token。</small>
              {!candidateUserNameValid && <p id={`username-error-${site}`} className="v2-field-error">请输入 1～256 个字符，且不能包含控制字符</p>}
            </>}
            <label htmlFor={`token-${site}`}><span>候选 Token</span><input id={`token-${site}`} type="password" autoComplete="off" data-1p-ignore="true" data-lpignore="true" autoCapitalize="none" spellCheck={false} minLength={16} maxLength={4096} aria-describedby={`token-help-${site}${draftLength > 0 && !draftValid ? ` token-error-${site}` : ""}`} placeholder="粘贴后可先仅验证，不保存" value={drafts[site]} onChange={(event) => { setDrafts((current) => ({ ...current, [site]: event.target.value })); setNotices((current) => ({ ...current, [site]: INITIAL_NOTICES[site] })); if (confirmingSite === site) setConfirmingSite(null); }} disabled={busy} /></label>
            <small id={`token-help-${site}`}><EyeOff aria-hidden="true" />默认沿用当前后台用户名；更换账号时请先修改用户名，再提交配套 Token。</small>
            {draftLength > 0 && !draftValid && <p id={`token-error-${site}`} className="v2-field-error">Token 长度应为 16～4096 个字符</p>}
            <div className="v2-source-actions">
              <button type="button" className="ui-button ui-button--secondary ui-button--lg" disabled={busy || !draftValid || !candidateUserNameValid} onClick={() => runSiteOperation("candidate", site)}>{siteOperation === "candidate" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <TestTubeDiagonal aria-hidden="true" />}{siteOperation === "candidate" ? "正在验证" : "仅验证，不保存"}</button>
              <button id={`save-token-${site}`} type="button" className="ui-button ui-button--primary ui-button--lg" disabled={busy || !draftValid || !candidateUserNameValid} onClick={() => setConfirmingSite(site)}><Save aria-hidden="true" />验证并保存</button>
            </div>
          </div>

        </article>;
      })}
    </section>

    <section className={`v2-preview-source${access.preview.active && displayedVerification === "confirmed" ? " is-active" : ""}`} aria-labelledby="test-data-preview-title">
      <div className="v2-preview-source__head">
        <div className="v2-source-title"><TestTubeDiagonal aria-hidden="true" /><div><h2 id="test-data-preview-title">临时测试数据</h2><span>仅当前用户、当前浏览器会话生效</span></div></div>
        <span className={`v2-status-pill ${access.preview.active && displayedVerification === "confirmed" ? "is-configured" : "is-unconfigured"}`}>{displayedVerification === "checking" ? "正在确认" : displayedVerification === "unknown" ? "状态待确认" : access.preview.active ? "测试模式中" : access.preview.enabled ? "未启用" : "服务未开放"}</span>
      </div>
      {!access.preview.enabled ? <div className="v2-inline-alert" role="status"><AlertTriangle aria-hidden="true" /><span>服务器尚未开放测试数据模式。正式数据查询不受影响。</span></div> : <>
        <dl className="v2-source-facts">
          <div><dt>测试后台账号</dt><dd>{access.preview.userName}</dd></div>
          <div><dt>当前页面数据环境</dt><dd>{dataEnvironment.state.mode === "test" ? "测试数据" : "正式数据"}</dd></div>
          <div><dt>临时会话到期</dt><dd>{displayedVerification !== "confirmed" ? "待确认" : access.preview.active ? formatTimestamp(access.preview.expiresAt) : "尚未创建"}</dd></div>
          <div><dt>影响范围</dt><dd>不改正式 Token，不影响其他用户</dd></div>
        </dl>
        <div className={`v2-probe-status is-${previewNotice.tone}`} role={previewNotice.tone === "danger" ? "alert" : "status"} aria-live="polite">
          {previewNotice.tone === "pending" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : previewNotice.tone === "success" ? <CheckCircle2 aria-hidden="true" /> : previewNotice.tone === "danger" ? <AlertTriangle aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          <span><b>环境隔离</b>{previewNotice.message}{(previewNotice.code || previewNotice.requestId) && <small>{previewNotice.code && `错误代码：${previewNotice.code}`}{previewNotice.code && previewNotice.requestId && "；"}{previewNotice.requestId && `请求 ID：${previewNotice.requestId}`}</small>}</span>
        </div>
        {access.preview.active ? <div className="v2-preview-source__actions">
          {dataEnvironment.state.mode !== "test" && <button type="button" className="ui-button ui-button--primary ui-button--lg" onClick={enterExistingPreview} disabled={busy || displayedVerification === "checking"}>进入测试数据</button>}
          <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={deactivatePreview} disabled={busy}>{operation.kind === "preview_deactivate" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <LogOut aria-hidden="true" />}{operation.kind === "preview_deactivate" ? "正在退出" : "结束测试会话"}</button>
        </div> : <div className="v2-token-editor">
          <label htmlFor="preview-token"><span>测试 Token</span><input id="preview-token" type="password" autoComplete="off" data-1p-ignore="true" data-lpignore="true" autoCapitalize="none" spellCheck={false} minLength={16} maxLength={4096} placeholder="粘贴测试后台 Token" value={previewToken} onChange={(event) => { setPreviewToken(event.target.value); setPreviewNotice({ tone: "neutral", message: "测试 Token 仅用于当前登录会话，不会替换正式凭据" }); }} disabled={busy} /></label>
          <small><EyeOff aria-hidden="true" />验证通过后原文只保存在服务端内存，24 小时到期或退出后删除。</small>
          <div className="v2-preview-source__actions"><button type="button" className="ui-button ui-button--primary ui-button--lg" onClick={activatePreview} disabled={busy || previewToken.trim().length < 16 || previewToken.trim().length > 4096}>{operation.kind === "preview_activate" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <TestTubeDiagonal aria-hidden="true" />}{operation.kind === "preview_activate" ? "正在验证" : "验证并进入测试数据"}</button></div>
        </div>}
      </>}
    </section>

    {confirmingSite && <SaveConfirmationDialog site={confirmingSite} busy={operation.kind === "save"} onCancel={() => closeSaveConfirmation(confirmingSite)} onConfirm={() => runSiteOperation("save", confirmingSite)} />}

    <p className="v2-maintenance-footnote">“凭证探针通过”仅说明该站点当前 Token 与用户名可以访问指定探针接口，不代表全部 PID、全部接口或指标已经验数。</p>
  </div>;
}
