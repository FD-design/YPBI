import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  changeUserPassword,
  fetchUserSession,
  loginUser,
  logoutUser,
  type AuthenticatedSession,
  type AuthRequestError
} from "../api/auth";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "../api/authEvents";
import { internalPreviewEnabled } from "./internal-preview";

type AuthenticationState =
  | { status: "checking" }
  | { status: "anonymous" }
  | {
      status: "authenticated";
      session: AuthenticatedSession;
      authScopeSignature: string;
      authScopeKey: string;
    }
  | { status: "unavailable"; error: AuthRequestError };

interface AuthenticationContextValue {
  state: AuthenticationState;
  retry: () => void;
  login: (username: string, password: string) => Promise<AuthenticatedSession>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthenticatedSession>;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

function sessionScopeSignature(session: AuthenticatedSession) {
  const pidScope: unknown = session.user.pidScope;
  return JSON.stringify([
    session.user.subjectId,
    session.user.role,
    [...session.user.permissions].sort(),
    Array.isArray(pidScope) ? [...pidScope].sort() : pidScope
  ]);
}

function authenticatedState(
  current: AuthenticationState,
  session: AuthenticatedSession,
  nextAuthScopeKey: string
): AuthenticationState {
  const authScopeSignature = sessionScopeSignature(session);
  if (current.status === "authenticated" && current.authScopeSignature === authScopeSignature) {
    return { ...current, session };
  }
  return { status: "authenticated", session, authScopeSignature, authScopeKey: nextAuthScopeKey };
}

export function AuthenticationProvider({
  children,
  developmentPreviewSession
}: {
  children: ReactNode;
  developmentPreviewSession?: AuthenticatedSession;
}) {
  const fixedPreviewSession = internalPreviewEnabled ? developmentPreviewSession : undefined;
  const [state, setState] = useState<AuthenticationState>(() => fixedPreviewSession
    ? authenticatedState({ status: "checking" }, fixedPreviewSession, "development-design-preview")
    : { status: "checking" });
  const [refreshKey, setRefreshKey] = useState(0);
  const authEpoch = useRef(0);
  const nextAuthScopeKey = useCallback(() => `auth-scope-${++authEpoch.current}`, []);

  useEffect(() => {
    if (fixedPreviewSession) {
      setState((current) => authenticatedState(current, fixedPreviewSession, "development-design-preview"));
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: "checking" });
    fetchUserSession(controller.signal).then((session) => {
      if (!session) {
        setState({ status: "anonymous" });
        return;
      }
      const scopeKey = nextAuthScopeKey();
      setState((current) => authenticatedState(current, session, scopeKey));
    }).catch((error: AuthRequestError) => {
      if (!controller.signal.aborted) setState({ status: "unavailable", error });
    });
    return () => controller.abort();
  }, [fixedPreviewSession, nextAuthScopeKey, refreshKey]);

  useEffect(() => {
    if (fixedPreviewSession) return undefined;
    const handleAuthenticationRequired = () => setState({ status: "anonymous" });
    window.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => window.removeEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
  }, [fixedPreviewSession]);

  useEffect(() => {
    if (fixedPreviewSession) return undefined;
    if (state.status !== "authenticated") return undefined;
    let controller: AbortController | null = null;
    const revalidateVisibleSession = () => {
      if (document.visibilityState !== "visible" || controller) return;
      controller = new AbortController();
      const currentController = controller;
      fetchUserSession(currentController.signal).then((session) => {
        const scopeKey = session ? nextAuthScopeKey() : null;
        setState((current) => {
          if (current.status !== "authenticated") return current;
          return session ? authenticatedState(current, session, scopeKey!) : { status: "anonymous" };
        });
      }).catch(() => {
        // A transient revalidation failure must not erase an otherwise valid
        // session. The expiry timer and every protected API still fail closed.
      }).finally(() => {
        if (controller === currentController) controller = null;
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") revalidateVisibleSession();
    };
    window.addEventListener("focus", revalidateVisibleSession);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      controller?.abort();
      window.removeEventListener("focus", revalidateVisibleSession);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fixedPreviewSession, nextAuthScopeKey, state.status]);

  useEffect(() => {
    if (state.status !== "authenticated") return undefined;
    const remaining = new Date(state.session.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      setState({ status: "anonymous" });
      return undefined;
    }
    const timer = window.setTimeout(() => setRefreshKey((value) => value + 1), Math.min(remaining + 250, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [state]);

  const retry = useCallback(() => setRefreshKey((value) => value + 1), []);
  const login = useCallback(async (username: string, password: string) => {
    const session = await loginUser(username, password);
    const scopeKey = nextAuthScopeKey();
    setState((current) => authenticatedState(current, session, scopeKey));
    return session;
  }, [nextAuthScopeKey]);
  const logout = useCallback(async () => {
    if (fixedPreviewSession) return;
    if (state.status !== "authenticated") {
      setState({ status: "anonymous" });
      return;
    }
    await logoutUser(state.session.csrfToken);
    setState({ status: "anonymous" });
  }, [fixedPreviewSession, state]);
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (fixedPreviewSession) throw new Error("DEVELOPMENT_PREVIEW_SESSION");
    if (state.status !== "authenticated") throw new Error("AUTHENTICATION_REQUIRED");
    const session = await changeUserPassword(currentPassword, newPassword, state.session.csrfToken);
    const scopeKey = nextAuthScopeKey();
    setState((current) => authenticatedState(current, session, scopeKey));
    return session;
  }, [fixedPreviewSession, nextAuthScopeKey, state]);

  const value = useMemo(() => ({ state, retry, login, logout, changePassword }), [state, retry, login, logout, changePassword]);
  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export function useAuthentication() {
  const context = useContext(AuthenticationContext);
  if (!context) throw new Error("useAuthentication must be used inside AuthenticationProvider");
  return context;
}
