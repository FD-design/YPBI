import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(root, "../全站埋点与指标体系");
const md = fs.readFileSync(path.join(sourceRoot, "H5全站埋点规范-协作主文档.md"), "utf8");
const html = fs.readFileSync(path.join(sourceRoot, "H5全站埋点框架-tracking.html"), "utf8");
const start = html.indexOf("const documentMeta ="), end = html.indexOf("const eventTableBody =", start);
if (start < 0 || end < 0) throw new Error("缺少可验证的事件观察版数据");
const context = vm.createContext({});
vm.runInContext(html.slice(start, end) + ";globalThis.snapshot={documentMeta,events,modules,pageRegistry};", context, { timeout: 2000 });
const { documentMeta, events, pageRegistry } = context.snapshot;
const eventTable = md.split("#### 5.8.2 逐事件触发、字段与边界")[1]?.split("#### 5.8.3")[0];
if (!eventTable) throw new Error("Markdown 权威事件表缺失");
const names = new Set();
const items = events.map(event => {
  if (!eventTable.includes("`" + event.name + "`") || !eventTable.includes(event.nameCn) || names.has(event.name)) throw new Error("事件观察版与 Markdown 不一致：" + event.name);
  names.add(event.name);
  return { id: event.name, name: event.nameCn, module: event.moduleCn, version: event.targetSchemaVersion, definitionStatus: event.versionStatusCn, definition: event.definition, trigger: event.trigger, source: event.sourceOfTruth, grain: event.grain, dedupKey: event.dedupKey, frequency: event.frequency, notTrigger: event.notTrigger ?? [], updated: event.updated, fields: (event.fields ?? []).map(field => ({ id: field.name, name: field.nameCn, type: field.type, layer: field.layer, required: field.required, range: field.range, example: field.example, enums: field.enumValues ?? [] })) };
});
const projection = { marker: "EVENT_CATALOG_DEV_AUTHORITY_PROJECTION", source: "H5全站埋点规范-协作主文档.md", sourceSha256: createHash("sha256").update(md).digest("hex"), observationSha256: createHash("sha256").update(html).digest("hex"), document: documentMeta, modules: [...new Set(items.map(item => item.module))], items };
const output = path.join(root, "src/v2/design/generated/event-catalog-preview.json");
const content = JSON.stringify(projection, null, 2) + "\n";
if (process.argv.includes("--check")) { if (fs.readFileSync(output, "utf8") !== content) throw new Error("事件预览投影已过期，请重新生成"); }
else fs.writeFileSync(output, content);
console.log(`事件权威投影：${items.length} 项；正式采集、查询与验数状态未赋值。`);
const metricMd = fs.readFileSync(path.join(sourceRoot, "全站指标体系.md"), "utf8");
const templateLine = metricMd.split("\n").find(line => line.startsWith("| 渗透率 |"));
if (!templateLine) throw new Error("缺少权威模块渗透率模板");
const template = templateLine.split("|").slice(1, -1).map(value => value.trim());
const pages = pageRegistry.filter(page => page.trackingStatus === "draft" && page.module !== "广告").map(page => {
  if (!md.includes("`" + page.id + "`") || !md.includes(page.name)) throw new Error("页面观察版与 Markdown 不一致：" + page.id);
  return { id: page.id, name: page.name, module: page.module, definition: page.definition, trackingStatus: page.trackingStatusCn };
});
const functionProjection = { marker: "FUNCTION_CATALOG_DEV_AUTHORITY_PROJECTION", source: "H5全站埋点规范-协作主文档.md", sourceSha256: projection.sourceSha256, version: documentMeta.documentVersion, templateSource: "全站指标体系.md §4.3", templateSourceSha256: createHash("sha256").update(metricMd).digest("hex"), template: { name: template[0], definition: template[1], rule: template[2], boundary: template[3] }, items: pages };
const functionOutput = path.join(root, "src/v2/design/generated/function-catalog-preview.json"), functionContent = JSON.stringify(functionProjection, null, 2) + "\n";
if (process.argv.includes("--check")) { if (fs.readFileSync(functionOutput, "utf8") !== functionContent) throw new Error("功能目录预览投影已过期，请重新生成"); }
else fs.writeFileSync(functionOutput, functionContent);
console.log(`功能目录权威投影：${pages.length} 项；渗透率模板未注册正式指标 ID。`);
