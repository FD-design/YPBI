import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { V2DataEnvironmentSuccess } from "../../../contracts/bi-v2";
import { fetchDataEnvironment, V2RequestError } from "../api/client";
import {
  currentDataEnvironmentPreference,
  initializeDataEnvironmentPreference,
  setDataEnvironmentPreference,
  type DataEnvironmentMode
} from "../api/dataEnvironmentPreference";

type EnvironmentState =
  | { status: "checking"; mode: DataEnvironmentMode; testAvailable: boolean }
  | { status: "ready"; mode: "production"; testAvailable: boolean }
  | { status: "ready"; mode: "test"; testAvailable: true; expiresAt: string; userName: string }
  | { status: "unconfirmed"; mode: "test"; testAvailable: boolean; message: string; expiresAt?: string }
  | { status: "expired"; mode: "test"; testAvailable: true; message: string };

interface DataEnvironmentContextValue {
  state: EnvironmentState;
  dataScopeKey: string;
  activateTest(data: Extract<V2DataEnvironmentSuccess["data"], { mode: "test" }>): void;
  useProduction(): void;
  refresh(): Promise<void>;
}

const DataEnvironmentContext = createContext<DataEnvironmentContextValue | null>(null);

export function DataEnvironmentProvider({ subjectId, children }: { subjectId: string; children: ReactNode }) {
  const [initialMode] = useState(() => initializeDataEnvironmentPreference(subjectId));
  const [state, setState] = useState<EnvironmentState>({ status: "checking", mode: initialMode, testAvailable: false });
  const [revision, bumpRevision] = useReducer((value: number) => value + 1, 0);
  const checkGeneration = useRef(0);
  const activeCheck = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const invalidateCheck = () => {
    checkGeneration.current++;
    activeCheck.current?.abort();
    activeCheck.current = null;
  };

  const refresh = async (signal?: AbortSignal) => {
    invalidateCheck();
    const generation = ++checkGeneration.current;
    const controller = new AbortController();
    activeCheck.current = controller;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const mode = currentDataEnvironmentPreference();
    const isCurrent = () => mounted.current && generation === checkGeneration.current && !signal?.aborted;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const data = await fetchDataEnvironment(controller.signal);
      if (!isCurrent() || controller.signal.aborted) return;
      if (data.mode !== mode) throw new Error("数据环境检查范围不一致");
      if (data.mode === "test" && Date.parse(data.expiresAt) <= Date.now()) {
        setState({ status: "expired", mode: "test", testAvailable: true, message: "测试数据会话已到期，请重新验证测试 Token" });
        return;
      }
      setState(data.mode === "test"
        ? { status: "ready", mode: "test", testAvailable: true, expiresAt: data.expiresAt, userName: data.userName }
        : { status: "ready", mode: "production", testAvailable: data.testAvailable });
    } catch (error) {
      if (!isCurrent()) return;
      if (mode === "test" && error instanceof V2RequestError && ["DATA_PREVIEW_SESSION_REQUIRED", "DATA_PREVIEW_DISABLED"].includes(error.code)) {
        setState({ status: "expired", mode: "test", testAvailable: true, message: error.message });
        return;
      }
      setState(current => mode === "test"
        ? current.status === "expired" ? current
          : { status: "unconfirmed", mode: "test", testAvailable: current.testAvailable, message: "暂时无法确认测试数据会话，请恢复网络后重新检查",
              ...("expiresAt" in current && current.expiresAt ? { expiresAt: current.expiresAt } : {}) }
        : { status: "ready", mode: "production", testAvailable: current.testAvailable });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (activeCheck.current === controller) activeCheck.current = null;
    }
  };

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const visibleCheck = () => {
      if (document.visibilityState !== "visible" || currentDataEnvironmentPreference() !== "test" || activeCheck.current) return;
      void refresh();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", visibleCheck);
      window.addEventListener("pageshow", visibleCheck);
      document.addEventListener("visibilitychange", visibleCheck);
    }
    return () => {
      mounted.current = false;
      invalidateCheck();
      controller.abort();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", visibleCheck);
        window.removeEventListener("pageshow", visibleCheck);
        document.removeEventListener("visibilitychange", visibleCheck);
      }
    };
  }, [subjectId]);

  const expiresAt = state.mode === "test" && "expiresAt" in state ? state.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_000_000)); return; }
      setState(current => current.mode === "test" && "expiresAt" in current && current.expiresAt === expiresAt
        ? { status: "expired", mode: "test", testAvailable: true, message: "测试数据会话已到期，请重新验证测试 Token" } : current);
      if (typeof document !== "undefined" && document.visibilityState === "visible" && currentDataEnvironmentPreference() === "test") void refresh();
    };
    timer = setTimeout(expire, Math.max(0, Math.min(Date.parse(expiresAt) - Date.now(), 2_147_000_000)));
    return () => clearTimeout(timer);
  }, [expiresAt]);

  const value = useMemo<DataEnvironmentContextValue>(() => ({
    state,
    dataScopeKey: `${subjectId}:${state.mode}:${revision}`,
    activateTest(data) {
      invalidateCheck();
      setDataEnvironmentPreference("test");
      setState(Date.parse(data.expiresAt) > Date.now()
        ? { status: "ready", mode: "test", testAvailable: true, expiresAt: data.expiresAt, userName: data.userName }
        : { status: "expired", mode: "test", testAvailable: true, message: "测试数据会话已到期，请重新验证测试 Token" });
      bumpRevision();
    },
    useProduction() {
      invalidateCheck();
      setDataEnvironmentPreference("production");
      setState((current) => ({ status: "ready", mode: "production", testAvailable: current.testAvailable }));
      bumpRevision();
    },
    refresh
  }), [state, revision, subjectId]);

  return <DataEnvironmentContext.Provider value={value}>{children}</DataEnvironmentContext.Provider>;
}

export function useDataEnvironment() {
  const value = useContext(DataEnvironmentContext);
  if (!value) throw new Error("useDataEnvironment must be used inside DataEnvironmentProvider");
  return value;
}
