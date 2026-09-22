import { AlertTriangle, KeyRound, LoaderCircle, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { BI_PASSWORD_MAX_LENGTH, BI_PASSWORD_MIN_LENGTH } from "../../../contracts/bi-auth";
import { AuthRequestError } from "../api/auth";
import { useAuthentication } from "../app/AuthProvider";
import { navigate, ProductLink } from "../app/router";
import { BrandLogo } from "../components/BrandLogo";

const DEFAULT_RETURN_PATH = "/data/metrics";

export function exactCurrentPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function safeReturnPath(rawValue: string | null | undefined) {
  if (!rawValue || !rawValue.startsWith("/") || rawValue.startsWith("//")) return DEFAULT_RETURN_PATH;
  try {
    const target = new URL(rawValue, window.location.origin);
    const normalizedPathname = target.pathname.length > 1 ? target.pathname.replace(/\/+$/, "") : target.pathname;
    if (target.origin !== window.location.origin || normalizedPathname === "/login") return DEFAULT_RETURN_PATH;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
}

export function loginPath(returnPath?: string) {
  return returnPath ? `/login?returnTo=${encodeURIComponent(safeReturnPath(returnPath))}` : "/login";
}

function AuthBrand() {
  return <div className="v2-auth-brand" aria-label="YPBI">
    <BrandLogo />
  </div>;
}

function ErrorMessage({ error }: { error: AuthRequestError | null }) {
  if (!error) return null;
  return <div className="v2-inline-alert v2-inline-alert--danger" role="alert">
    <AlertTriangle aria-hidden="true" />
    <span>{error.message}{error.requestId && <small>请求 ID：{error.requestId}</small>}</span>
  </div>;
}

export function AuthenticationLoadingPage() {
  return <div className="ypbi-v2 v2-auth-root"><main className="v2-auth-page" aria-live="polite"><LoaderCircle className="is-spinning v2-auth-loading" aria-hidden="true"/><p>正在确认登录状态…</p></main></div>;
}

export function AuthenticationUnavailablePage() {
  const { state, retry } = useAuthentication();
  if (state.status !== "unavailable") return null;
  return <div className="ypbi-v2 v2-auth-root"><main className="v2-auth-page"><section className="v2-auth-card">
    <AuthBrand />
    <div className="v2-auth-intro"><AlertTriangle aria-hidden="true"/><div><h1>暂时无法确认登录状态</h1><p>为避免错误开放业务数据，登录服务恢复前不会进入系统。</p></div></div>
    <ErrorMessage error={state.error}/>
    <button type="button" className="ui-button ui-button--primary ui-button--lg" onClick={retry}>重新检查</button>
    {import.meta.env.DEV && <ProductLink className="ui-button ui-button--secondary" href="/dashboards/public?design=dashboard-center">返回看板预览</ProductLink>}
  </section></main></div>;
}

export function LoginPage({ returnTo }: { returnTo: string }) {
  const { login } = useAuthentication();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthRequestError | null>(null);

  useEffect(() => {
    if (window.location.pathname !== "/login") navigate(loginPath(returnTo), { replace: true });
  }, [returnTo]);

  useEffect(() => {
    setPassword("");
    setError(null);
  }, [returnTo]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || username.trim().length < 3 || password.length < BI_PASSWORD_MIN_LENGTH) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await login(username.trim(), password);
      setPassword("");
      if (!session.mustChangePassword) navigate(returnTo, { replace: true });
    } catch (problem) {
      setPassword("");
      setError(problem instanceof AuthRequestError ? problem : new AuthRequestError("登录失败，请稍后重试", { kind: "error", code: "AUTH_LOGIN_FAILED", status: 0 }));
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="ypbi-v2 v2-auth-root"><main className="v2-auth-page"><section className="v2-auth-card" aria-labelledby="v2-login-title">
    <AuthBrand />
    <div className="v2-auth-intro"><LockKeyhole aria-hidden="true"/><div><h1 id="v2-login-title">登录 YPBI</h1><p>使用管理员为你创建的内部账号登录。</p></div></div>
    <form className="v2-auth-form" onSubmit={submit}>
      <label><span>账号</span><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={64} required autoFocus value={username} onChange={(event) => setUsername(event.target.value)} disabled={submitting}/></label>
      <label><span>密码</span><input name="password" type="password" autoComplete="current-password" minLength={BI_PASSWORD_MIN_LENGTH} maxLength={BI_PASSWORD_MAX_LENGTH} required value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting}/></label>
      <ErrorMessage error={error}/>
      <button type="submit" className="ui-button ui-button--primary ui-button--lg" disabled={submitting || username.trim().length < 3 || password.length < BI_PASSWORD_MIN_LENGTH}>{submitting ? <LoaderCircle className="is-spinning" aria-hidden="true"/> : <KeyRound aria-hidden="true"/>}{submitting ? "正在登录" : "登录"}</button>
    </form>
    <div className="v2-auth-security"><ShieldCheck aria-hidden="true"/><span>系统不会在浏览器本地保存账号密码。</span></div>
  </section></main></div>;
}

export function PasswordForm({ forced, onComplete, onCancel }: { forced: boolean; onComplete: () => void; onCancel?: () => void }) {
  const { changePassword } = useAuthentication();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthRequestError | null>(null);
  const localError = newPassword.length > 0 && newPassword.length < BI_PASSWORD_MIN_LENGTH
    ? `新密码至少需要 ${BI_PASSWORD_MIN_LENGTH} 个字符`
    : confirmation.length > 0 && newPassword !== confirmation
      ? "两次输入的新密码不一致"
      : currentPassword.length > 0 && currentPassword === newPassword
        ? "新密码不能与当前密码相同"
        : "";
  const valid = Boolean(currentPassword && newPassword.length >= BI_PASSWORD_MIN_LENGTH && newPassword === confirmation && currentPassword !== newPassword);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || !valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      onComplete();
    } catch (problem) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setError(problem instanceof AuthRequestError ? problem : new AuthRequestError("密码修改失败，请稍后重试", { kind: "error", code: "PASSWORD_CHANGE_FAILED", status: 0 }));
    } finally {
      setSubmitting(false);
    }
  };

  return <form className="v2-auth-form" onSubmit={submit}>
    <label><span>当前密码</span><input type="password" autoComplete="current-password" maxLength={BI_PASSWORD_MAX_LENGTH} required autoFocus value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={submitting}/></label>
    <label><span>新密码</span><input type="password" autoComplete="new-password" minLength={BI_PASSWORD_MIN_LENGTH} maxLength={BI_PASSWORD_MAX_LENGTH} required aria-describedby="v2-password-rule" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={submitting}/><small id="v2-password-rule">至少 {BI_PASSWORD_MIN_LENGTH} 个字符。</small></label>
    <label><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={BI_PASSWORD_MIN_LENGTH} maxLength={BI_PASSWORD_MAX_LENGTH} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={submitting}/></label>
    {localError && <p className="v2-auth-validation" role="status">{localError}</p>}
    <ErrorMessage error={error}/>
    <div className="v2-auth-form-actions">{onCancel && <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={onCancel} disabled={submitting}>取消</button>}<button type="submit" className="ui-button ui-button--primary ui-button--lg" disabled={submitting || !valid}>{submitting ? <LoaderCircle className="is-spinning" aria-hidden="true"/> : <KeyRound aria-hidden="true"/>}{submitting ? "正在更新" : forced ? "设置新密码并继续" : "更新密码"}</button></div>
  </form>;
}

export function ForcedPasswordChangePage({ returnTo }: { returnTo: string }) {
  const { logout } = useAuthentication();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<AuthRequestError | null>(null);
  const switchAccount = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (problem) {
      setLogoutError(problem instanceof AuthRequestError ? problem : new AuthRequestError("退出失败，请稍后重试", { kind: "error", code: "AUTH_LOGOUT_FAILED", status: 0 }));
    } finally {
      setLoggingOut(false);
    }
  };

  return <div className="ypbi-v2 v2-auth-root"><main className="v2-auth-page"><section className="v2-auth-card" aria-labelledby="v2-password-title">
    <AuthBrand />
    <div className="v2-auth-intro"><KeyRound aria-hidden="true"/><div><h1 id="v2-password-title">首次登录，请设置新密码</h1><p>临时密码只用于首次验证。完成修改后才能进入业务数据页面。</p></div></div>
    <PasswordForm key={returnTo} forced onComplete={() => navigate(returnTo, { replace: true })}/>
    <div className="v2-auth-switch-account">
      <span>这不是你要使用的账号？</span>
      <button type="button" className="ui-button ui-button--secondary ui-button--lg" onClick={switchAccount} disabled={loggingOut}>{loggingOut ? <LoaderCircle className="is-spinning" aria-hidden="true"/> : <LogOut aria-hidden="true"/>}{loggingOut ? "正在退出" : "退出并切换账号"}</button>
    </div>
    <ErrorMessage error={logoutError}/>
  </section></main></div>;
}
