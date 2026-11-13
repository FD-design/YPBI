import { useCallback, useEffect, useRef, useState } from "react";
import { V2RequestError, readV2RequestDiagnostics, type V2FailureKind, type V2RequestDiagnostics } from "./client";

type ResourceFailure = V2RequestDiagnostics & { message: string; code: string };

export type V2ResourceState<T> =
  | { status: "loading" }
  | (ResourceFailure & { status: "failure"; kind: V2FailureKind })
  | { status: "success"; data: T; refreshing: boolean; refreshError: ResourceFailure | null };

const loadingState = { status: "loading" } as const;

function normalizeFailure(error: unknown) {
  if (error instanceof V2RequestError) return error;
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return new V2RequestError(offline ? "当前网络不可用，请恢复连接后重试" : "暂时无法连接数据服务，请稍后重试", {
    kind: "error",
    code: offline ? "NETWORK_OFFLINE" : "NETWORK_ERROR",
    status: 0
  });
}

export function useV2Resource<T>(requestKey: string, load: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<{ key: string; state: V2ResourceState<T> }>({ key: requestKey, state: loadingState });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setResource(current => ({ key: requestKey, state: current.key === requestKey && current.state.status === "success"
      ? { ...current.state, refreshing: true, refreshError: null }
      : loadingState }));

    loadRef.current(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setResource(current => current.key === requestKey && !controller.signal.aborted
        ? { key: requestKey, state: { status: "success", data, refreshing: false, refreshError: null } }
        : current);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const failure = normalizeFailure(error);
      setResource(current => {
        if (current.key !== requestKey || controller.signal.aborted) return current;
        const details = { message: failure.message, ...readV2RequestDiagnostics(failure), code: failure.code };
        const state: V2ResourceState<T> = current.state.status === "success" && failure.kind === "error"
          ? { ...current.state, refreshing: false, refreshError: details }
          : { status: "failure", kind: failure.kind, ...details };
        return { key: requestKey, state };
      });
    });
    return () => controller.abort();
  }, [attempt, requestKey]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { state: resource.key === requestKey ? resource.state : loadingState, retry };
}
