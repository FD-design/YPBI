import { UpstreamError } from "../upstream/client";

/** Bounds one consumer's source reads without cancelling shared upstream work. */
export class SourceReadBudget {
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private disposed = false;
  private didExpire = false;

  constructor(timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new RangeError("Source read timeout must be between 1 and 60000 milliseconds");
    }
    this.deadline = performance.now() + timeoutMs;
    this.timer = setTimeout(() => this.expire(), timeoutMs);
  }

  get expired() { return this.didExpire; }

  private failure() { return new UpstreamError("UPSTREAM_TIMEOUT", "后台来源读取超时", 504); }

  private expire() {
    if (this.disposed || this.didExpire) return;
    this.didExpire = true;
    this.controller.abort();
  }

  read<T>(start: () => Promise<T>): Promise<T> {
    if (!this.disposed && performance.now() >= this.deadline) this.expire();
    if (this.disposed || this.didExpire) return Promise.reject(this.failure());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const signal = this.controller.signal;
      const finish = (deliver: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        deliver();
      };
      const onAbort = () => finish(() => reject(this.failure()));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        // Both handlers remain attached after expiry to consume late rejections.
        start().then(
          value => finish(() => {
            if (this.disposed || this.didExpire || performance.now() >= this.deadline) {
              this.expire();
              reject(this.failure());
            } else resolve(value);
          }),
          error => finish(() => reject(error))
        );
      } catch (error) { finish(() => reject(error)); }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.controller.abort();
  }
}
