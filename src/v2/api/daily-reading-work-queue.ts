export interface DailyReadingWorkQueueOptions {
  maxActive?: number;
}

export interface DailyReadingWorkOptions {
  priority: "foreground" | "snapshot";
  signal?: AbortSignal;
}

interface QueuedWork {
  start: () => void;
}

/** Shared browser capacity for complete daily-reading requests. */
export class DailyReadingWorkQueue {
  private readonly maxActive: number;
  private readonly foreground: QueuedWork[] = [];
  private readonly snapshots: QueuedWork[] = [];
  private active = 0;
  private pumpScheduled = false;

  constructor(options: DailyReadingWorkQueueOptions = {}) {
    const maxActive = options.maxActive ?? 1;
    if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
      throw new RangeError("maxActive must be a positive safe integer");
    }
    this.maxActive = maxActive;
  }

  run<T>(work: () => Promise<T>, options: DailyReadingWorkOptions): Promise<T> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const waiting = options.priority === "foreground" ? this.foreground : this.snapshots;

    return new Promise<T>((resolve, reject) => {
      const cancelWaiting = () => {
        const index = waiting.indexOf(item);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal?.removeEventListener("abort", cancelWaiting);
        reject(signal?.reason);
        this.schedulePump();
      };
      const item: QueuedWork = { start: () => {
        signal?.removeEventListener("abort", cancelWaiting);
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        this.active++;
        const release = () => {
          this.active--;
          this.schedulePump();
        };
        try {
          Promise.resolve(work()).then(
            value => { release(); resolve(value); },
            error => { release(); reject(error); }
          );
        } catch (error) {
          release();
          reject(error);
        }
      } };
      waiting.push(item);
      signal?.addEventListener("abort", cancelWaiting, { once: true });
      this.schedulePump();
    });
  }

  private schedulePump() {
    if (this.pumpScheduled || (this.foreground.length === 0 && this.snapshots.length === 0)) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      while (this.active < this.maxActive) {
        const item = this.foreground.shift() ?? this.snapshots.shift();
        if (!item) return;
        item.start();
      }
    });
  }
}
