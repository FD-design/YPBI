import { z } from "zod";

export const OPERATING_EVIDENCE_VERSION = "operating-evidence/v1" as const;

/** Explicit scope for a maintenance-only business-response download. */
export const operatingEvidenceQuerySchema = z.object({
  pid: z.string().min(1).max(32).regex(/^[A-Z0-9_]+$/),
  date: z.iso.date(),
  view: z.enum(["snapshot", "day"]),
  environment: z.enum(["production", "test"])
}).strict();

export type OperatingEvidenceQuery = z.infer<typeof operatingEvidenceQuerySchema>;

export const OPERATING_EVIDENCE_BOUNDARY = {
  kind: "upstream-client-business-field-projection",
  rawHttp: false,
  cacheSemantics: "existing-upstream-client-cache-and-inflight",
  httpStatusAvailable: false,
  metricAcceptanceGranted: false
} as const;
