import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const prdPath = new URL("../docs/requirements/BI-产品需求文档.md", import.meta.url);
const taxonomyPath = new URL("../server/v2/generated/metric-definitions.json", import.meta.url);
const outputPath = new URL("../src/v2/design/generated/dashboard-directory-preview.json", import.meta.url);
const officialOutputPath = new URL("../contracts/official-dashboards.json", import.meta.url);
const tableAnchor = "正式业务看板目标清单与建设顺序已经确认：";

// Preview identities are PRD section references, not persisted dashboard object IDs.
export function deriveDirectory(markdown, taxonomy) {
  if (markdown.split(tableAnchor).length !== 2) throw new Error("Expected one official dashboard plan table");
  const block = markdown.split(tableAnchor)[1].trimStart().split(/\n\s*\n/)[0];
  const rows = block.split("\n").slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const categories = taxonomy.categories.map(({ name, order }) => ({ name, order })).sort((a, b) => a.order - b.order);
  if (!rows.length || new Set(categories.map(({ name }) => name)).size !== categories.length) throw new Error("Invalid source categories or empty plan");
  const headings = [...markdown.matchAll(/^### (5\.\d+) (.+?)（.*$/gm)];
  const names = new Set();
  const items = rows.map((cells) => {
    if (cells.length !== 5 || cells.some((cell) => !cell)) throw new Error("Invalid dashboard plan row");
    const [, categoryLabel, title, scope, admission] = cells;
    if (names.has(title)) throw new Error(`Duplicate dashboard: ${title}`);
    names.add(title);
    const matches = headings.filter(([, , name]) => name === title);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous PRD section: ${title}`);
    const category = categoryLabel === "跨分类置顶" ? null : categoryLabel;
    if (category && !categories.some(({ name }) => name === category)) throw new Error(`Unknown category: ${category}`);
    return { section: matches[0][1], title, category, scope, admission };
  });
  if (items.filter(({ category }) => category === null).length !== 1 || !items.some(({ section, category }) => section === "5.2" && category === null)) {
    throw new Error("Core overview must be the single cross-category dashboard");
  }
  return {
    source: "BI-产品需求文档.md §5.1；分类校验 metric-definitions.json",
    categories: categories.filter(({ name }) => items.some(({ category }) => category === name)).map(({ name }) => name),
    items
  };
}

export async function generate(check = false) {
  const [prd, taxonomy] = await Promise.all([readFile(prdPath, "utf8"), readFile(taxonomyPath, "utf8")]);
  const output = JSON.stringify(deriveDirectory(prd, JSON.parse(taxonomy)), null, 2) + "\n";
  for (const target of [outputPath, officialOutputPath]) {
    if (check) {
      if (await readFile(target, "utf8").catch(() => "") !== output) throw new Error("Dashboard directory is stale; run npm run dashboards:preview:generate");
    } else await writeFile(target, output);
  }
  console.log(`Dashboard directory preview ${check ? "check" : "generation"} passed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate(process.argv.includes("--check"));
}
