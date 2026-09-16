import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";

interface Migration {
  version: number;
  name: string;
  source: URL;
}

export const authMigrations: readonly Migration[] = [
  { version: 1, name: "auth_users_sessions", source: new URL("./001_auth_users_sessions.sql", import.meta.url) }
];

const migrationLockId = 1_572_024_908;

export const AUTH_MIGRATION_LIMITS = Object.freeze({
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 65_000,
  advisoryLockWaitMs: 30_000,
  advisoryLockRetryMs: 250
});

export interface AuthMigrationRunnerOptions {
  advisoryLockWaitMs?: number;
  advisoryLockRetryMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function runAuthMigrations(sql: Sql, options: AuthMigrationRunnerOptions = {}) {
  const lockWaitMs = options.advisoryLockWaitMs ?? AUTH_MIGRATION_LIMITS.advisoryLockWaitMs;
  const lockRetryMs = options.advisoryLockRetryMs ?? AUTH_MIGRATION_LIMITS.advisoryLockRetryMs;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? sleep;
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0 || !Number.isFinite(lockRetryMs) || lockRetryMs <= 0) {
    throw new Error("migration lock timeout 配置不合法");
  }
  await sql.begin(async (transaction) => {
    await transaction`
      select
        set_config('statement_timeout', ${`${AUTH_MIGRATION_LIMITS.statementTimeoutMs}ms`}, true),
        set_config('lock_timeout', ${`${AUTH_MIGRATION_LIMITS.lockTimeoutMs}ms`}, true),
        set_config('idle_in_transaction_session_timeout', ${`${AUTH_MIGRATION_LIMITS.idleInTransactionTimeoutMs}ms`}, true)
    `;
    // A transaction-scoped try-lock guarantees that checks and DDL use the same
    // reserved connection, while the explicit deadline prevents startup from
    // waiting forever behind a crashed or slow deployment.
    const lockDeadline = now() + lockWaitMs;
    while (true) {
      const lockRows = await transaction<{ acquired: boolean }[]>`
        select pg_try_advisory_xact_lock(${migrationLockId}) as acquired
      `;
      if (lockRows[0]?.acquired === true) break;
      const remaining = lockDeadline - now();
      if (remaining <= 0) throw new Error("账号数据库 migration 锁等待超时");
      await wait(Math.min(lockRetryMs, remaining));
    }
    await transaction`
      create table if not exists bi_schema_migrations (
        version integer primary key,
        name text not null,
        checksum char(64) not null,
        applied_at timestamptz not null default now()
      )
    `;
    for (const migration of authMigrations) {
      const source = await readFile(migration.source, "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const existing = await transaction<{ name: string; checksum: string }[]>`
        select name, checksum from bi_schema_migrations where version = ${migration.version}
      `;
      if (existing[0]) {
        if (existing[0].name !== migration.name || existing[0].checksum !== checksum) {
          throw new Error(`已执行的 migration ${migration.version} 与仓库内容不一致`);
        }
        continue;
      }
      await transaction.unsafe(source);
      await transaction`
        insert into bi_schema_migrations (version, name, checksum)
        values (${migration.version}, ${migration.name}, ${checksum})
      `;
    }
  });
}
