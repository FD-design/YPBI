import type { DashboardTemplate } from "../types";

function recency(value?: string) {
  if (value === "刚刚") return Number.POSITIVE_INFINITY;
  const timestamp = value ? Date.parse(value.replace(" ", "T")) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeTemplatesByRecency(remote: DashboardTemplate[], local: DashboardTemplate[]) {
  const localById = new Map(local.map((template) => [template.id, template]));
  const merged = remote.map((remoteTemplate) => {
    const localTemplate = localById.get(remoteTemplate.id);
    if (!localTemplate) return remoteTemplate;
    localById.delete(remoteTemplate.id);
    return recency(localTemplate.updatedAt) > recency(remoteTemplate.updatedAt) ? localTemplate : remoteTemplate;
  });
  return [...merged, ...local.filter((template) => localById.has(template.id))];
}
