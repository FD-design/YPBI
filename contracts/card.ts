import { z } from "zod";
import { analysisTypeSchema, MAX_METRICS_PER_QUERY } from "./analytics";

export const cardConfigSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  modelId: z.string().min(1),
  analysisType: analysisTypeSchema,
  metricIds: z.array(z.string()).max(MAX_METRICS_PER_QUERY),
  dimensionIds: z.array(z.string()).max(3),
  eventIds: z.array(z.string()).max(8).optional(),
  chartType: z.string(),
  dateMode: z.enum(["global", "fixed"]).default("global"),
  platformMode: z.enum(["global", "fixed", "all", "single", "compare"]).default("global"),
  platforms: z.array(z.string().trim().min(1)).max(8).optional(),
  sourceApiIds: z.array(z.string()).min(1)
});

export type CardConfig = z.infer<typeof cardConfigSchema>;
