import { z } from "zod";

export const OPERATING_QUERY_VALIDATION_PATH = "/api/bi/admin/data-sources/operating-query-jobs";

/** Maintenance-only admission does not enable the normal production dashboard. */
export const operatingQueryValidationCapabilitiesSchema = z.object({
  success: z.literal(true),
  data: z.object({
    environment: z.literal("production"),
    enabled: z.boolean(),
    groups: z.array(z.object({
      site: z.enum(["primary", "secondary"]),
      pids: z.array(z.string().min(1).max(32).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).min(1).max(20)
    }).strict()).max(256)
  }).strict().superRefine((data, ctx) => {
    const pids = data.groups.flatMap(group => group.pids);
    if (new Set(pids).size !== pids.length || (!data.enabled && data.groups.length)) {
      ctx.addIssue({ code: "custom", message: "联调平台范围无效" });
    }
  })
}).strict();

export type OperatingQueryValidationCapabilities = z.infer<typeof operatingQueryValidationCapabilitiesSchema>["data"];
