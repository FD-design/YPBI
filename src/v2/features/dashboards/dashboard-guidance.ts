import entries from "../../generated/dashboard-guidance.json";

/** Copy is generated from the PRD. Explicit keys disambiguate reused panel titles. */
export function dashboardGuidance(title: string, key?: string) {
  if (key === "") return undefined;
  if (key) return entries.find(entry => entry.key === key)?.description;
  const matches = entries.filter(entry => entry.title === title);
  return matches.length === 1 ? matches[0].description : undefined;
}
