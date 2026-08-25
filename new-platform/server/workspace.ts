import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const workspacePath = resolve(process.cwd(), "data/newav-workspace-v4.json");

export async function readWorkspace() {
  try { return JSON.parse(await readFile(workspacePath, "utf8")); } catch { return null; }
}

export async function writeWorkspace(value: unknown) {
  await mkdir(dirname(workspacePath), { recursive: true });
  const temp = `${workspacePath}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, workspacePath);
}
