import { z } from "zod";
import type {
  IdentityProvider,
  IdentityRequestContext,
  IdentityResolution
} from "./identity-provider";

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
  const abortFromExternalSignal = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new Error("identity_request_aborted"));
    }
  };
  if (externalSignal?.aborted) abortFromExternalSignal();
  else externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error("identity_timeout"));
  }, timeoutMs);
  timer.unref();
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectForAbort = () => reject(controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("identity_lookup_aborted"));
      if (controller.signal.aborted) rejectForAbort();
      else controller.signal.addEventListener("abort", rejectForAbort, { once: true });
    });
    const rawResolution = await Promise.race([
      identityProvider.resolve({ ...providerContext, signal: controller.signal }),
      aborted
    ]);
    const parsed = identityResolutionSchema.safeParse(rawResolution);
    if (!parsed.success) throw new Error("invalid_identity_resolution");
    return parsed.data;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}
