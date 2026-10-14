interface RequestWorkQueueOptions {
  maxActive?: number;
  maxQueued?: number;
  timeoutError?: () => Error;
  overflowError?: () => Error;
}

interface QueuedWork {
  start: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** Shared physical-request capacity. Waiting uses the original request deadline. */
export class RequestWorkQueue {
  private readonly maxActive: number;
  private readonly maxQueued: number;
  private readonly timeoutError: () => Error;
  private readonly overflowError: () => Error;
  private readonly waiting: QueuedWork[] = [];
  private active = 0;
  private draining = false;

  constructor(options: RequestWorkQueueOptions = {}) {
    this.maxActive = positiveInteger(options.maxActive ?? 40, "maxActive");
    this.maxQueued = positiveInteger(options.maxQueued ?? 512, "maxQueued");
    this.timeoutError = options.timeoutError ?? (() => new Error("Request queue timeout"));
    this.overflowError = options.overflowError ?? (() => new Error("Request queue capacity exceeded"));
  }

  run<T>(work: (remainingMs: number) => Promise<T> | T, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    positiveInteger(timeoutMs, "timeoutMs");
    const deadline = performance.now() + timeoutMs;
    if (signal?.aborted) return Promise.reject(this.timeoutError());
    if (this.active >= this.maxActive && this.waiting.length >= this.maxQueued) {
      return Promise.reject(this.overflowError());
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueuedWork = { start: () => {
        if (item.timer !== undefined) clearTimeout(item.timer);
        signal?.removeEventListener("abort", cancelWaiting);
        const remainingMs = Math.ceil(deadline - performance.now());
        if (remainingMs <= 0 || signal?.aborted) { reject(this.timeoutError()); return; }
        this.active++;
        const release = () => { this.active--; this.drain(); };
        try {
          Promise.resolve(work(remainingMs)).then(
            value => { release(); resolve(value); },
            error => { release(); reject(error); }
          );
        } catch (error) { release(); reject(error); }
      } };
      const cancelWaiting = () => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        if (item.timer !== undefined) clearTimeout(item.timer);
        signal?.removeEventListener("abort", cancelWaiting);
        reject(this.timeoutError());
        this.drain();
      };
      if (this.active < this.maxActive && this.waiting.length === 0) item.start();
      else {
        this.waiting.push(item);
        signal?.addEventListener("abort", cancelWaiting, { once: true });
        item.timer = setTimeout(cancelWaiting, Math.max(0, Math.ceil(deadline - performance.now())));
        this.drain();
      }
    });
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.maxActive && this.waiting.length > 0) this.waiting.shift()!.start();
    } finally { this.draining = false; }
  }
}
