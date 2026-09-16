import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const source = new URL("../docs/requirements/BI-产品需求文档.md", import.meta.url);
const target = new URL("../src/v2/generated/dashboard-guidance.json", import.meta.url);

export function deriveGuidance(markdown) {
  const tables = [...markdown.matchAll(/^\| 文案键 \| 区块名称 \| 分析说明 \|\n\|[^\n]+\|\n((?:\|[^\n]+\|\n)+)/gm)];
  if (tables.length !== 1) throw new Error("Expected one authoritative dashboard guidance table");
  const keys = new Set();
  return tables[0][1].trim().split("\n").map(line => {
    const cells = line.split("|").slice(1, -1).map(cell => cell.trim().replace(/^`|`$/g, ""));
    if (cells.length !== 3 || cells.some(cell => !cell)) throw new Error("Invalid guidance row");
    const [key, title, description] = cells;
    if (!/^[a-z][a-z0-9.-]+$/.test(key) || keys.has(key)) throw new Error(`Invalid or duplicate guidance key: ${key}`);
    keys.add(key);
    return { key, title, description };
  });
}

export async function generate(check = false) {
  const output = JSON.stringify(deriveGuidance(await readFile(source, "utf8")), null, 2) + "\n";
  if (check) {
    if (await readFile(target, "utf8").catch(() => "") !== output) throw new Error("Dashboard guidance is stale; run npm run dashboards:guidance:generate");
  } else await writeFile(target, output);
  console.log(`Dashboard guidance ${check ? "check" : "generation"} passed.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate(process.argv.includes("--check"));
