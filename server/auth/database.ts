import postgres, { type Sql } from "postgres";

export const AUTH_RUNTIME_DATABASE_LIMITS = Object.freeze({
  statementTimeoutMs: 2_500,
  lockTimeoutMs: 1_000,
  idleInTransactionTimeoutMs: 5_000
});

export const AUTH_MAINTENANCE_DATABASE_LIMITS = Object.freeze({
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
  idleInTransactionTimeoutMs: 65_000
});

const forbiddenConnectionParameters = new Set([
  "application_name",
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "idle_session_timeout",
  "options",
  "search_path",
  "role",
  "session_authorization",
  "default_transaction_isolation",
  "default_transaction_read_only",
  "default_transaction_deferrable",
  "timezone",
  "datestyle",
  "intervalstyle"
]);

/**
 * postgres.js applies URL query parameters after the explicit `connection`
 * object. Reject parameters that could silently replace the safety limits or
 * change the schema/session semantics relied on by auth SQL.
 */
export function validateAuthDatabaseUrl(databaseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("BI_AUTH_DATABASE_URL 必须是合法的 PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("BI_AUTH_DATABASE_URL 必须使用 postgres:// 或 postgresql://");
  }
  for (const [rawName] of parsed.searchParams) {
    const name = rawName.toLowerCase();
    if (forbiddenConnectionParameters.has(name)) {
      throw new Error(`BI_AUTH_DATABASE_URL 禁止通过查询参数覆盖账号库会话配置：${name}`);
    }
  }
  return databaseUrl;
}

/**
 * The public request path uses a small, strictly bounded pool. PostgreSQL,
 * rather than only the HTTP caller, terminates slow statements so timed-out
 * identity lookups cannot continue occupying all authentication connections.
 */
export function createAuthRuntimeDatabase(databaseUrl: string): Sql {
  return postgres(validateAuthDatabaseUrl(databaseUrl), {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "ypbi-auth-runtime",
      statement_timeout: AUTH_RUNTIME_DATABASE_LIMITS.statementTimeoutMs,
      lock_timeout: AUTH_RUNTIME_DATABASE_LIMITS.lockTimeoutMs,
      idle_in_transaction_session_timeout: AUTH_RUNTIME_DATABASE_LIMITS.idleInTransactionTimeoutMs
    }
  });
}

/**
 * Migrations and the interactive account CLI are isolated from the public
 * authentication pool. Their limits are longer, but still finite.
 */
export function createAuthMaintenanceDatabase(databaseUrl: string): Sql {
  return postgres(validateAuthDatabaseUrl(databaseUrl), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    connection: {
      application_name: "ypbi-auth-maintenance",
      statement_timeout: AUTH_MAINTENANCE_DATABASE_LIMITS.statementTimeoutMs,
      lock_timeout: AUTH_MAINTENANCE_DATABASE_LIMITS.lockTimeoutMs,
      idle_in_transaction_session_timeout: AUTH_MAINTENANCE_DATABASE_LIMITS.idleInTransactionTimeoutMs
    }
  });
}
