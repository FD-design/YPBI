import { z } from "zod";
import type {
  IdentityProvider,
  IdentityRequestContext,
  IdentityResolution
} from "./identity-provider";
import {
  associateIdentityLookupFailure, beginIdentityLookupDiagnostics,
  freezeIdentityLookupFailure, markIdentityLookupPhase
} from "./identity-lookup-diagnostics";
import { IdentityDeadline } from "./identity-deadline";

export const DEFAULT_IDENTITY_TIMEOUT_MS = 3_000;

const principalSchema = z.object({
  subjectId: z.string().trim().min(1).max(256),
  displayName: z.string().trim().min(1).max(256).optional(),
  roles: z.array(z.string().trim().min(1).max(64)).max(64),
  permissions: z.array(z.string().trim().min(1).max(128)).max(128),
  pidScope: z.union([
    z.literal("all"),
    z.array(z.string().trim().min(1).max(32)).max(1_000)
  ]),
  securityVersion: z.string().trim().min(1).max(64).optional()
}).strict();

const identityResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("authenticated"), principal: principalSchema }).strict(),
  z.object({ status: z.literal("unauthenticated") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().max(256).optional() }).strict()
]);

/**
 * Resolve and runtime-validate an identity result behind one timeout boundary.
 * Callers still own the product-specific status/error mapping.
 */
export async function resolveIdentity(
  identityProvider: IdentityProvider,
  context: Omit<IdentityRequestContext, "signal"> & { signal?: AbortSignal },
  timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS
): Promise<IdentityResolution> {
  const { signal: externalSignal, ...providerContext } = context;
  const controller = new AbortController();
  const deadline = new IdentityDeadline(controller, timeoutMs, "identity_timeout");
  beginIdentityLookupDiagnostics(controller.signal, timeoutMs, undefined, deadline.startedAt);
  const abortFromExternalSignal = () => {
    if (!controller.signal.aborted) {
      freezeIdentityLookupFailure(controller.signal, "client_aborted");
      controller.abort(externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new Error("identity_request_aborted"));
    }
  };
  if (externalSignal?.aborted) abortFromExternalSignal();
  else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });

  const timer = setTimeout(() => deadline.expire(), timeoutMs);
  timer.unref();
  try {
    deadline.throwIfAbortedOrExpired();
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectForAbort = () => reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("identity_lookup_aborted"));
      if (controller.signal.aborted) rejectForAbort();
      else controller.signal.addEventListener("abort", rejectForAbort, { once: true });
    });
    const rawResolution = await Promise.race([
      new Promise<IdentityResolution>(resolve => resolve(
        identityProvider.resolve({ ...providerContext, signal: controller.signal })
      )),
      aborted
    ]);
    deadline.throwIfAbortedOrExpired();
    const parsed = identityResolutionSchema.safeParse(rawResolution);
    deadline.throwIfAbortedOrExpired();
    if (!parsed.success) {
      freezeIdentityLookupFailure(controller.signal, "invalid_resolution");
      throw new Error("invalid_identity_resolution");
    }
    if (parsed.data.status === "unavailable") {
      freezeIdentityLookupFailure(controller.signal);
      associateIdentityLookupFailure(controller.signal, parsed.data);
      associateIdentityLookupFailure(controller.signal, externalSignal);
    } else markIdentityLookupPhase(controller.signal, "complete");
    return parsed.data;
  } catch (error) {
    try { deadline.throwIfAbortedOrExpired(); }
    catch (boundaryError) { error = boundaryError; }
    freezeIdentityLookupFailure(controller.signal);
    associateIdentityLookupFailure(controller.signal, error);
    associateIdentityLookupFailure(controller.signal, externalSignal);
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}
