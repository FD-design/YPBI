import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileWorkspaceStore, MemoryWorkspaceStore, createWorkspaceStore } from "./workspace.store";

const tempDirectories: string[] = [];
afterEach(async () => Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("MemoryWorkspaceStore", () => {
  test("保存版本化工作区并返回不可共享的副本", async () => {
    const store = new MemoryWorkspaceStore();
    const saved = await store.put({ schemaVersion: 1, templates: [{ id: "template-1" }], cardAssets: [{ id: "card-1" }] });
    (saved.templates[0] as { id: string }).id = "changed";
    const loaded = await store.get();
    expect(loaded?.schemaVersion).toBe(1);
    expect((loaded?.templates[0] as { id: string }).id).toBe("template-1");
    expect(loaded?.updatedAt).toBeTruthy();
  });
});

describe("FileWorkspaceStore", () => {
  test("服务重建后仍能读取已经保存的模板", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-workspace-"));
    tempDirectories.push(directory);
    const file = join(directory, "workspace.json");
    const first = await FileWorkspaceStore.connect(file);
    await first.put({ schemaVersion: 1, templates: [{ id: "custom-template" }], cardAssets: [] });
    await first.close();

    const second = await FileWorkspaceStore.connect(file);
    expect((await second.get())?.templates).toEqual([{ id: "custom-template" }]);
  });

  test("覆盖前保留上一版本备份", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-workspace-"));
    tempDirectories.push(directory);
    const file = join(directory, "workspace.json");
    const store = await FileWorkspaceStore.connect(file);
    await store.put({ schemaVersion: 1, templates: [{ id: "v1" }], cardAssets: [] });
    await store.put({ schemaVersion: 1, templates: [{ id: "v2" }], cardAssets: [] });
    const backup = JSON.parse(await readFile(`${file}.backup`, "utf8"));
    expect(backup.templates).toEqual([{ id: "v1" }]);
  });

  test("没有数据库时工厂使用磁盘存储而不是内存存储", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bi-workspace-"));
    tempDirectories.push(directory);
    const store = await createWorkspaceStore(undefined, join(directory, "workspace.json"));
    expect(store).toBeInstanceOf(FileWorkspaceStore);
  });
});
