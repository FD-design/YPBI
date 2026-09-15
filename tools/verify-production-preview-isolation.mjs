import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIST_ROOT = new URL("../dist/", import.meta.url);
const FORBIDDEN_MARKERS = [
  "review-tools",
  "查看完整图表体验",
  "PERSONAL_WORKSPACE_DEV_ONLY",
  "personal-workspace-preview",
  "design.preview",
  "developmentDesignPreviewSessionToken",
  "V1_CHART_STATES_PREVIEW_MARKER",
  "ACQUISITION_PREVIEW_MARKER",
  "TOPIC_PREVIEW_MARKER",
  "EXTENDED_BOARD_DEV_ONLY",
  "EVENT_CATALOG_DEV_AUTHORITY_PROJECTION",
  "FUNCTION_CATALOG_DEV_AUTHORITY_PROJECTION",
  "FUNCTION_USAGE_DEV_ONLY",
  "GLOBAL_NAVIGATION_USAGE_DEV_ONLY",
  "version-performance__audience",
  "content-discovery-position",
  "catalog-preview-notice",
  "topic-preview",
  "acquisition-preview",
  "core-overview-design-fixture",
  "v1-chart-states-fixture",
  "dashboard-directory-preview",
  "BI-产品需求文档.md §5.1；分类校验 metric-definitions.json",
  "固定视觉样例"
];

async function filesBelow(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directoryUrl);
    return entry.isDirectory() ? filesBelow(child) : [child];
  }));
  return nested.flat();
}

const files = await filesBelow(DIST_ROOT);
const violations = [];
for (const file of files) {
  if (!/\.(?:html|js|css|json|map)$/.test(file.pathname)) continue;
  const contents = await readFile(file, "utf8");
  for (const marker of FORBIDDEN_MARKERS) {
    if (contents.includes(marker)) violations.push(`${join("dist", file.pathname.split("/dist/")[1])}: ${marker}`);
  }
}

if (violations.length > 0) {
  console.error("Production bundle contains development preview artifacts:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Production preview isolation passed (${files.length} files scanned).`);
}
