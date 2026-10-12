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

  const refresh = async (signal?: AbortSignal) => {
    const generation = ++checkGeneration.current;
    const isCurrent = () => generation === checkGeneration.current && !signal?.aborted;
    try {
      const data = await fetchDataEnvironment(signal);
      if (!isCurrent()) return;
      setState(data.mode === "test"
        ? { status: "ready", mode: "test", testAvailable: true, expiresAt: data.expiresAt, userName: data.userName }
        : { status: "ready", mode: "production", testAvailable: data.testAvailable });
    } catch (error) {
      if (!isCurrent()) return;
      if (currentDataEnvironmentPreference() === "test" && error instanceof V2RequestError && ["DATA_PREVIEW_SESSION_REQUIRED", "DATA_PREVIEW_DISABLED"].includes(error.code)) {
        setState({ status: "expired", mode: "test", testAvailable: true, message: error.message });
        return;
      }
      throw error;
    }
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const checking = refresh(controller.signal);
    const generation = checkGeneration.current;
    checking.catch(() => {
      if (active && generation === checkGeneration.current && !controller.signal.aborted) setState(initialMode === "test"
        ? { status: "expired", mode: "test", testAvailable: true, message: "暂时无法确认测试数据会话，请切回正式数据或稍后重试" }
        : { status: "ready", mode: "production", testAvailable: false });
    });
    return () => { active = false; checkGeneration.current++; controller.abort(); };
  }, [subjectId]);

  const value = useMemo<DataEnvironmentContextValue>(() => ({
    state,
    dataScopeKey: `${subjectId}:${state.mode}:${revision}`,
    activateTest(data) {
      checkGeneration.current++;
      setDataEnvironmentPreference("test");
      setState({ status: "ready", mode: "test", testAvailable: true, expiresAt: data.expiresAt, userName: data.userName });
      bumpRevision();
    },
    useProduction() {
      checkGeneration.current++;
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
