import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DIST_ROOT = new URL("../dist/", import.meta.url);
const INTERNAL_DASHBOARD_PREVIEW_ENABLED = process.env.VITE_INTERNAL_DASHBOARD_PREVIEW_ENABLED === "true";
const INTERNAL_DASHBOARD_PREVIEW_MARKERS = new Set([
  "ACQUISITION_PREVIEW_MARKER",
  "TOPIC_PREVIEW_MARKER",
  "EXTENDED_BOARD_DEV_ONLY",
  "FUNCTION_CATALOG_DEV_AUTHORITY_PROJECTION",
  "FUNCTION_USAGE_DEV_ONLY",
  "GLOBAL_NAVIGATION_USAGE_DEV_ONLY",
  "content-discovery-position",
  "topic-preview",
  "acquisition-preview",
  "core-overview-design-fixture",
  "固定视觉样例"
]);
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
].filter((marker) => !INTERNAL_DASHBOARD_PREVIEW_ENABLED || !INTERNAL_DASHBOARD_PREVIEW_MARKERS.has(marker));
const INTERNAL_PREVIEW_NOTICE = "页面同时包含真实数据、待验数结果和用于展示样式的演示数据";

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
let internalPreviewNoticeFound = false;
for (const file of files) {
  if (!/\.(?:html|js|css|json|map)$/.test(file.pathname)) continue;
  const contents = await readFile(file, "utf8");
  if (contents.includes(INTERNAL_PREVIEW_NOTICE)) internalPreviewNoticeFound = true;
  for (const marker of FORBIDDEN_MARKERS) {
    if (contents.includes(marker)) violations.push(`${join("dist", file.pathname.split("/dist/")[1])}: ${marker}`);
  }
}

if (INTERNAL_DASHBOARD_PREVIEW_ENABLED && !internalPreviewNoticeFound) {
  violations.push("内测构建缺少页面级真实/待验数/演示数据说明");
}

if (violations.length > 0) {
  console.error("Production bundle contains development preview artifacts:\n" + violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`${INTERNAL_DASHBOARD_PREVIEW_ENABLED ? "Authenticated internal dashboard preview" : "Production preview isolation"} passed (${files.length} files scanned).`);
}
