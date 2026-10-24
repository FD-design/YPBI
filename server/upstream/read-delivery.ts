import { AsyncLocalStorage } from "node:async_hooks";

type ReadDeliveryBoundary = <T>(start: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

const boundaryContext = new AsyncLocalStorage<ReadDeliveryBoundary>();

/** Installs the caller's delivery policy for this independent source scope. */
export function runWithReadDeliveryBoundary<T>(boundary: ReadDeliveryBoundary, read: () => Promise<T>): Promise<T> {
  return boundaryContext.run(boundary, read);
}

/** Delivers one fully validated result through the current source policy. */
export function deliverUpstreamRead<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const boundary = boundaryContext.getStore();
  return boundary ? boundary(start, signal) : start();
}
