function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("auth_query_aborted");
}

/** Holds only pending work, never identity results or database connections. */
export class IdentityReadAdmission {
  private running = 0;
  private readonly waiting = new Set<() => void>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("身份读取并发容量必须与有效数据库连接池容量一致");
    }
  }

  run<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const abort = () => {
        this.waiting.delete(start);
        cleanup();
        reject(abortReason(signal!));
      };
      const start = () => {
        cleanup();
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }
        this.running++;
        let pending: PromiseLike<T>;
        try { pending = operation(); }
        catch (error) { pending = Promise.reject(error); }
        Promise.resolve(pending).then(value => {
          this.release();
          resolve(value);
        }, error => {
          this.release();
          reject(error);
        });
      };
      this.waiting.add(start);
      signal?.addEventListener("abort", abort, { once: true });
      this.drain();
    });
  }

  private release() {
    this.running--;
    this.drain();
  }

  private drain() {
    while (this.running < this.capacity && this.waiting.size) {
      const next = this.waiting.values().next().value!;
      this.waiting.delete(next);
      next();
    }
  }
}
