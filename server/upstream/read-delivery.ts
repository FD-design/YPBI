import { AsyncLocalStorage } from "node:async_hooks";

type ReadDeliveryBoundary = <T>(start: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
type ReadDeliveryExpiryScope = "source" | "unit";

const boundaryContext = new AsyncLocalStorage<{ boundary: ReadDeliveryBoundary; expiryScope: ReadDeliveryExpiryScope }>();

/** Installs the caller's delivery policy for this independent source scope. */
export function runWithReadDeliveryBoundary<T>(boundary: ReadDeliveryBoundary, read: () => Promise<T>,
  options: { expiryScope?: ReadDeliveryExpiryScope } = {}): Promise<T> {
  return boundaryContext.run({ boundary, expiryScope: options.expiryScope ?? "source" }, read);
}

/** A caller may own either one source window or independent execution units. */
export function currentReadDeliveryExpiryScope(): ReadDeliveryExpiryScope {
  return boundaryContext.getStore()?.expiryScope ?? "source";
}

/** Delivers one fully validated result through the current source policy. */
export function deliverUpstreamRead<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const boundary = boundaryContext.getStore()?.boundary;
  return boundary ? boundary(start, signal) : start();
}
