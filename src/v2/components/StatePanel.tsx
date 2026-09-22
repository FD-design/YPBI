import { AlertTriangle, Ban, CircleUserRound, DatabaseZap, RefreshCw } from "lucide-react";
import { LoadingIndicator } from "../../components/ui/LoadingIndicator";
import type { ReactNode } from "react";
import type { V2ResourceState } from "../api/useV2Resource";
import { hideInternalReferenceCodes } from "../features/metrics/metric-presentation";

type StateKind = "loading" | "identity_unavailable" | "unauthenticated" | "forbidden" | "error" | "empty";

const ICONS = {
  identity_unavailable: DatabaseZap,
  unauthenticated: CircleUserRound,
  forbidden: Ban,
  error: AlertTriangle,
  empty: DatabaseZap
} satisfies Record<Exclude<StateKind, "loading">, typeof AlertTriangle>;

export function StatePanel({
  kind,
  title,
  description,
  code,
  requestId,
  action,
  compact = false
}: {
  kind: StateKind;
  title: string;
  description: string;
  code?: string;
  requestId?: string;
  action?: { label: string; onClick: () => void };
  compact?: boolean;
}) {
  const Icon = kind === "loading" ? null : ICONS[kind];
  return <section className={`v2-state v2-state--${kind}${compact ? " v2-state--compact" : ""}`} role={kind === "loading" ? "status" : kind === "error" ? "alert" : undefined} aria-live="polite">
    {Icon ? <Icon aria-hidden="true" /> : <LoadingIndicator />}
    <div>
      <h2>{hideInternalReferenceCodes(title)}</h2>
      <p>{hideInternalReferenceCodes(description)}</p>
      {code && <small>错误代码：{code}</small>}
      {requestId && <small>请求 ID：{requestId}</small>}
    </div>
    {action && <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={action.onClick}><RefreshCw aria-hidden="true" />{action.label}</button>}
  </section>;
}

export function RefreshNotice({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  return <div className="v2-refresh-notice" role="alert">
    <span>{children}</span>
    <button type="button" onClick={onRetry}>重试刷新</button>
  </div>;
}

export function ResourceFailurePanel({ state, onRetry }: { state: Extract<V2ResourceState<unknown>, { status: "failure" }>; onRetry: () => void }) {
  const copy = state.kind === "identity_unavailable"
    ? { title: "身份能力暂不可用", description: "指标目录和查询必须由服务端确认当前身份与数据范围。身份源恢复后可重新检查。" }
    : state.kind === "unauthenticated"
      ? { title: "需要登录", description: "当前请求没有可验证的登录身份。完成现有账号系统登录后再重试。" }
      : state.kind === "forbidden"
        ? { title: "当前范围无权访问", description: state.message }
        : { title: "暂时无法加载", description: state.message };
  return <StatePanel kind={state.kind} title={copy.title} description={copy.description} code={state.code} requestId={state.requestId} action={{ label: "重新检查", onClick: onRetry }} />;
}
