import { AsyncResource } from "node:async_hooks";

export type ReadAdmissionPriority = "modern" | "legacy";
interface PendingRead {
  start: () => void;
}
interface ReadAdmissionOptions {
  maxWaiting?: number;
  cancelled: () => Error;
  overflow: () => Error;
}

/** Serial data admission; execution budgets start only after a permit is granted. */
export class ReadAdmission {
  private readonly modern: PendingRead[] = [];
  private readonly legacy: PendingRead[] = [];
  private readonly maxWaiting: number;
  private active = false;
  private scheduled = false;

  constructor(private readonly options: ReadAdmissionOptions) {
    const maxWaiting = options.maxWaiting ?? 512;
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1) throw new RangeError("maxWaiting must be a positive safe integer");
    this.maxWaiting = maxWaiting;
  }

  run<T>(work: () => Promise<T>, priority: ReadAdmissionPriority, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(this.options.cancelled());
    if (this.modern.length + this.legacy.length >= this.maxWaiting) return Promise.reject(this.options.overflow());
    const pending = priority === "modern" ? this.modern : this.legacy;
    const resource = new AsyncResource("ypbi-data-read-admission");
    return new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const index = pending.indexOf(item);
        if (index < 0) return;
        pending.splice(index, 1);
        signal?.removeEventListener("abort", cancel);
        resource.emitDestroy();
        reject(this.options.cancelled());
        this.schedule();
      };
      const item: PendingRead = { start: () => {
        signal?.removeEventListener("abort", cancel);
        if (signal?.aborted) {
          resource.emitDestroy();
          reject(this.options.cancelled());
          return;
        }
        this.active = true;
        const finish = () => {
          resource.emitDestroy();
          this.active = false;
          this.schedule();
        };
        try {
          Promise.resolve(resource.runInAsyncScope(work)).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
        } catch (error) { finish(); reject(error); }
      } };
      pending.push(item);
      signal?.addEventListener("abort", cancel, { once: true });
      this.schedule();
    });
  }

  private schedule() {
    if (this.scheduled || this.active || this.modern.length + this.legacy.length === 0) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      while (!this.active) {
        const next = this.modern.shift() ?? this.legacy.shift();
        if (!next) return;
        next.start();
      }
    });
  }
}
