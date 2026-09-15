import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Sql } from "postgres";
import { authMigrations, runAuthMigrations } from "./runner";

describe("auth migrations", () => {
  test("迁移有序且账号库只保存会话令牌哈希", async () => {
    expect(authMigrations.map(({ version }) => version)).toEqual([1]);
    const source = await readFile(authMigrations[0].source, "utf8");
    expect(source).toContain("create table bi_auth_users");
    expect(source).toContain("create table bi_auth_sessions");
    expect(source).toContain("token_hash char(64)");
    expect(source).toContain("must_change_password boolean");
    expect(source).not.toMatch(/\bsession_token\b/);
    expect(source).not.toMatch(/\bcsrf_token\b/);
    expect(source).not.toMatch(/\bcreate table if not exists bi_auth_/);
  });

  test("迁移锁和全部 DDL 在同一个事务连接中执行", async () => {
    const statements: string[] = [];
    const transaction = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.reduce((result, part, index) => result + part + (index < values.length ? "?" : ""), "");
        statements.push(statement);
        if (statement.includes("pg_try_advisory_xact_lock")) return [{ acquired: true }];
        return [];
      },
      {
        unsafe: async (source: string) => {
          statements.push(source);
          return [];
        }
      }
    );
    const sql = {
      begin: async (operation: (reservedTransaction: typeof transaction) => Promise<unknown>) => operation(transaction)
    } as unknown as Sql;

    await runAuthMigrations(sql);

    expect(statements[0]).toContain("set_config('statement_timeout'");
    expect(statements[1]).toContain("pg_try_advisory_xact_lock");
    expect(statements.some((statement) => statement.includes("create table bi_auth_users"))).toBe(true);
    expect(statements.at(-1)).toContain("insert into bi_schema_migrations");
  });

  test("迁移锁无法取得时按有界等待失败，不永久阻塞启动", async () => {
    let currentTime = 0;
    let attempts = 0;
    const transaction = Object.assign(
      async (strings: TemplateStringsArray) => {
        const statement = strings.join("");
        if (statement.includes("pg_try_advisory_xact_lock")) {
          attempts += 1;
          return [{ acquired: false }];
        }
        return [];
      },
      { unsafe: async () => [] }
    );
    const sql = {
      begin: async (operation: (reservedTransaction: typeof transaction) => Promise<unknown>) => operation(transaction)
    } as unknown as Sql;

    await expect(runAuthMigrations(sql, {
      advisoryLockWaitMs: 20,
      advisoryLockRetryMs: 5,
      now: () => currentTime,
      sleep: async (milliseconds) => { currentTime += milliseconds; }
    })).rejects.toThrow("migration 锁等待超时");
    expect(attempts).toBe(5);
  });
});
