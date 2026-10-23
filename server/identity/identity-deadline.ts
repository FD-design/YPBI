import { freezeIdentityLookupFailure } from "./identity-lookup-diagnostics";

/** Enforces the request budget even when the event loop delays its timer. */
export class IdentityDeadline {
  readonly startedAt = performance.now();
  private readonly expiresAt: number;

  constructor(
    private readonly controller: AbortController,
    timeoutMs: number,
    private readonly timeoutMessage: string
  ) {
    this.expiresAt = this.startedAt + timeoutMs;
  }

  expire() {
    if (this.controller.signal.aborted) return;
    freezeIdentityLookupFailure(this.controller.signal, "deadline_exceeded");
    this.controller.abort(new Error(this.timeoutMessage));
  }

  throwIfAbortedOrExpired() {
    this.controller.signal.throwIfAborted();
    if (performance.now() >= this.expiresAt) this.expire();
    this.controller.signal.throwIfAborted();
  }
}
