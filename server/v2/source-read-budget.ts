import { UpstreamError } from "../upstream/client";

/** Bounds one consumer's source reads without cancelling shared upstream work. */
export class SourceReadBudget {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private disposed = false;
  private didExpire = false;
  private readonly pendingReads = new Set<() => void>();
  private readonly onConsumerAbort = () => this.dispose();

  constructor(timeoutMs: number, private readonly consumerSignal?: AbortSignal) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("Source read timeout must be between 1 and 60000 milliseconds");
    }
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.expire(), timeoutMs);
    if (consumerSignal?.aborted) this.dispose();
    else consumerSignal?.addEventListener("abort", this.onConsumerAbort, { once: true });
  }

  get expired() { return this.didExpire; }
  get signal() { return this.controller.signal; }

  private failure() { return new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504); }

  private expire() {
    if (this.disposed || this.didExpire) return;
    this.didExpire = true;
    this.consumerSignal?.removeEventListener("abort", this.onConsumerAbort);
    this.controller.abort();
    for (const cancel of this.pendingReads) cancel();
  }

  read<T>(start: () => Promise<T>, readSignal?: AbortSignal): Promise<T> {
    if (!this.disposed && performance.now() >= this.deadline) this.expire();
    if (this.disposed || this.didExpire || readSignal?.aborted) return Promise.reject(this.failure());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (deliver: () => void) => {
        if (settled) return;
        settled = true;
        this.pendingReads.delete(onAbort);
        readSignal?.removeEventListener("abort", onAbort);
        if (!this.disposed && !this.didExpire && performance.now() >= this.deadline) this.expire();
        if (this.disposed || this.didExpire || readSignal?.aborted) reject(this.failure());
        else deliver();
      };
      const onAbort = () => finish(() => reject(this.failure()));
      this.pendingReads.add(onAbort);
      readSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Both handlers remain attached after expiry to consume late rejections.
        start().then(
          value => finish(() => resolve(value)),
          error => finish(() => reject(error))
        );
      } catch (error) { finish(() => reject(error)); }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.consumerSignal?.removeEventListener("abort", this.onConsumerAbort);
    clearTimeout(this.timer);
    this.controller.abort();
    for (const cancel of this.pendingReads) cancel();
  }
}
