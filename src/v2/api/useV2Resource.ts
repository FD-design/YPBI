import { useCallback, useEffect, useRef, useState } from "react";
import { V2RequestError, type V2FailureKind } from "./client";

export type V2ResourceState<T> =
  | { status: "loading" }
  | { status: "failure"; kind: V2FailureKind; message: string; code: string; requestId?: string }
  | { status: "success"; data: T; refreshing: boolean; refreshError: { message: string; code: string; requestId?: string } | null };

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
  const [state, setState] = useState<V2ResourceState<T>>({ status: "loading" });
  const resolvedKey = useRef<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    const canPreserve = resolvedKey.current === requestKey;
    setState((current) => canPreserve && current.status === "success"
      ? { ...current, refreshing: true, refreshError: null }
      : { status: "loading" });

    loadRef.current(controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      resolvedKey.current = requestKey;
      setState({ status: "success", data, refreshing: false, refreshError: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const failure = normalizeFailure(error);
      setState((current) => canPreserve && current.status === "success" && failure.kind === "error"
        ? { ...current, refreshing: false, refreshError: { message: failure.message, code: failure.code, requestId: failure.requestId } }
        : { status: "failure", kind: failure.kind, message: failure.message, code: failure.code, requestId: failure.requestId });
    });
    return () => controller.abort();
  }, [attempt, requestKey]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  return { state, retry };
}
