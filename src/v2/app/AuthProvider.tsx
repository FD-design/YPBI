import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  changeUserPassword,
  fetchUserSession,
  loginUser,
  logoutUser,
  type AuthenticatedSession,
  type AuthRequestError
} from "../api/auth";
import { V2_AUTHENTICATION_REQUIRED_EVENT } from "../api/authEvents";

type AuthenticationState =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "authenticated"; session: AuthenticatedSession }
  | { status: "unavailable"; error: AuthRequestError };

interface AuthenticationContextValue {
  state: AuthenticationState;
  retry: () => void;
  login: (username: string, password: string) => Promise<AuthenticatedSession>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthenticatedSession>;
}

const AuthenticationContext = createContext<AuthenticationContextValue | null>(null);

export function AuthenticationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthenticationState>({ status: "checking" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "checking" });
    fetchUserSession(controller.signal).then((session) => {
      setState(session ? { status: "authenticated", session } : { status: "anonymous" });
    }).catch((error: AuthRequestError) => {
      if (!controller.signal.aborted) setState({ status: "unavailable", error });
    });
    return () => controller.abort();
  }, [refreshKey]);

  useEffect(() => {
    const handleAuthenticationRequired = () => setState({ status: "anonymous" });
    window.addEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => window.removeEventListener(V2_AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
  }, []);

  useEffect(() => {
    if (state.status !== "authenticated") return undefined;
    let controller: AbortController | null = null;
    const revalidateVisibleSession = () => {
      if (document.visibilityState !== "visible" || controller) return;
      controller = new AbortController();
      const currentController = controller;
      fetchUserSession(currentController.signal).then((session) => {
        setState((current) => {
          if (current.status !== "authenticated") return current;
          return session ? { status: "authenticated", session } : { status: "anonymous" };
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
  }, [state.status]);

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
    setState({ status: "authenticated", session });
    return session;
  }, []);
  const logout = useCallback(async () => {
    if (state.status !== "authenticated") {
      setState({ status: "anonymous" });
      return;
    }
    await logoutUser(state.session.csrfToken);
    setState({ status: "anonymous" });
  }, [state]);
  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (state.status !== "authenticated") throw new Error("AUTHENTICATION_REQUIRED");
    const session = await changeUserPassword(currentPassword, newPassword, state.session.csrfToken);
    setState({ status: "authenticated", session });
    return session;
  }, [state]);

  const value = useMemo(() => ({ state, retry, login, logout, changePassword }), [state, retry, login, logout, changePassword]);
  return <AuthenticationContext.Provider value={value}>{children}</AuthenticationContext.Provider>;
}

export function useAuthentication() {
  const context = useContext(AuthenticationContext);
  if (!context) throw new Error("useAuthentication must be used inside AuthenticationProvider");
  return context;
}
