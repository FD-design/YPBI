import postgres, { type JSONValue, type Sql } from "postgres";
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WorkspaceDocument {
  schemaVersion: 1;
  templates: JSONValue[];
  cardAssets: JSONValue[];
  updatedAt: string;
}

export interface WorkspaceStore {
  get(): Promise<WorkspaceDocument | null>;
  put(document: Omit<WorkspaceDocument, "updatedAt">): Promise<WorkspaceDocument>;
  close(): Promise<void>;
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private document: WorkspaceDocument | null = null;
  async get() { return this.document ? structuredClone(this.document) : null; }
  async put(document: Omit<WorkspaceDocument, "updatedAt">) {
    this.document = { ...structuredClone(document), updatedAt: new Date().toISOString() };
    return structuredClone(this.document);
  }
  async close() {}
}

export class FileWorkspaceStore implements WorkspaceStore {
  private constructor(private readonly filePath: string) {}

  static async connect(filePath: string) {
    await mkdir(dirname(filePath), { recursive: true });
    return new FileWorkspaceStore(filePath);
  }

  async get(): Promise<WorkspaceDocument | null> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as WorkspaceDocument;
      return structuredClone(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(document: Omit<WorkspaceDocument, "updatedAt">) {
    const saved: WorkspaceDocument = {
      ...structuredClone(document),
      updatedAt: new Date().toISOString()
    };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      await copyFile(this.filePath, `${this.filePath}.backup`);
      await chmod(`${this.filePath}.backup`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(temporaryPath, JSON.stringify(saved, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
    return structuredClone(saved);
  }

  async close() {}
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  private constructor(private readonly sql: Sql) {}

  static async connect(databaseUrl: string) {
    const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, connect_timeout: 10 });
    await sql`create table if not exists bi_workspace (
      workspace_id text primary key,
      schema_version integer not null,
      document jsonb not null,
      updated_at timestamptz not null default now()
    )`;
    return new PostgresWorkspaceStore(sql);
  }

  async get() {
    const rows = await this.sql<{ document: Omit<WorkspaceDocument, "updatedAt">; updated_at: Date }[]>`select document, updated_at from bi_workspace where workspace_id = 'default'`;
    const row = rows[0];
    return row ? { ...row.document, updatedAt: row.updated_at.toISOString() } : null;
  }

  async put(document: Omit<WorkspaceDocument, "updatedAt">) {
    const [row] = await this.sql<{ updated_at: Date }[]>`insert into bi_workspace (workspace_id, schema_version, document, updated_at)
      values ('default', ${document.schemaVersion}, ${this.sql.json(document)}, now())
      on conflict (workspace_id) do update set schema_version = excluded.schema_version, document = excluded.document, updated_at = now()
      returning updated_at`;
    return { ...document, updatedAt: row.updated_at.toISOString() };
  }

  async close() { await this.sql.end(); }
}

export async function createWorkspaceStore(databaseUrl?: string, workspaceFile = "./data/workspace.json"): Promise<WorkspaceStore> {
  return databaseUrl ? PostgresWorkspaceStore.connect(databaseUrl) : FileWorkspaceStore.connect(workspaceFile);
}
