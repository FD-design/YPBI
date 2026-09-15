import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";

interface CapturedUnsafeCall {
  query: string;
  values: unknown[];
}

interface CapturedTemplateCall {
  query: string;
  values: unknown[];
}

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "00000000-0000-4000-8000-000000000001",
    username: "Alice",
    normalized_username: "alice",
    display_name: "Alice Zhang",
    role: "reader",
    password_hash: "scrypt$test",
    credential_version: 1,
    must_change_password: true,
    status: "active",
    failed_login_count: 0,
    failed_login_window_started_at: null,
    locked_until: null,
    created_at: new Date("2026-09-08T08:00:00.000Z"),
    updated_at: new Date("2026-09-08T08:00:00.000Z"),
    ...overrides
  };
}

function transactionHarness(unsafeResponses: unknown[][], revokeError?: Error) {
  const unsafeCalls: CapturedUnsafeCall[] = [];
  const templateCalls: CapturedTemplateCall[] = [];
  let rolledBack = false;
  let unsafeIndex = 0;
  const transaction = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      templateCalls.push({ query: strings.join("?"), values });
      if (revokeError) return Promise.reject(revokeError);
      return Promise.resolve([]);
    },
    {
      unsafe: async (query: string, values: unknown[]) => {
        unsafeCalls.push({ query, values });
        return unsafeResponses[unsafeIndex++] ?? [];
      }
    }
  );
  const sql = {
    begin: async (callback: (transactionSql: Sql) => Promise<unknown>) => {
      try {
        return await callback(transaction as unknown as Sql);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    }
  } as unknown as Sql;
  return {
    sql,
    unsafeCalls,
    templateCalls,
    rolledBack: () => rolledBack
  };
}

describe("PostgresAuthRepository 账号权限维护", () => {
  test("身份查询收到 AbortSignal 后取消底层 PostgreSQL query", async () => {
    let cancelled = false;
    let rejectQuery: (error: Error) => void = () => undefined;
    const pending = Object.assign(
      new Promise<never>((_resolve, reject) => { rejectQuery = reject; }),
      {
        cancel: () => {
          cancelled = true;
          rejectQuery(new Error("query cancelled"));
        }
      }
    );
    const sql = { unsafe: () => pending } as unknown as Sql;
    const repository = new PostgresAuthRepository(sql);
    const controller = new AbortController();

    const lookup = repository.findAuthenticatedSession(
      "a".repeat(64),
      new Date("2026-09-08T08:00:00.000Z"),
      controller.signal
    );
    controller.abort();

    await expect(lookup).rejects.toThrow("query cancelled");
    expect(cancelled).toBe(true);
  });

  test("角色变化使用 credential_version CAS，并在同一事务撤销全部会话", async () => {
    const harness = transactionHarness([
      [userRow({ role: "reader", credential_version: 1 })],
      [userRow({ role: "analyst", credential_version: 2 })]
    ]);
    const repository = new PostgresAuthRepository(harness.sql);
    const now = new Date("2026-09-08T08:10:00.000Z");

    const updated = await repository.setUserRoleAndRevokeSessions(
      "00000000-0000-4000-8000-000000000001",
      1,
      "analyst",
      now
    );

    expect(updated).toMatchObject({ outcome: "changed", user: { role: "analyst", credentialVersion: 2 } });
    expect(harness.unsafeCalls).toHaveLength(2);
    expect(harness.unsafeCalls[0].query).toContain("for update");
    expect(harness.unsafeCalls[1].query).toContain("credential_version = credential_version + 1");
    expect(harness.unsafeCalls[1].query).toContain("credential_version = $4");
    expect(harness.unsafeCalls[1].values).toEqual([
      "analyst",
      now,
      "00000000-0000-4000-8000-000000000001",
      1
    ]);
    expect(harness.templateCalls).toHaveLength(1);
    expect(harness.templateCalls[0].query).toContain("update bi_auth_sessions");
    expect(harness.templateCalls[0].values).toEqual([now, "00000000-0000-4000-8000-000000000001"]);
  });

  test("启用使用版本和原状态双重 CAS，清除登录锁并撤销全部会话", async () => {
    const harness = transactionHarness([
      [userRow({ role: "maintainer", status: "disabled", credential_version: 3 })],
      [userRow({
        role: "maintainer",
        status: "active",
        credential_version: 4,
        failed_login_count: 0,
        failed_login_window_started_at: null,
        locked_until: null
      })]
    ]);
    const repository = new PostgresAuthRepository(harness.sql);
    const now = new Date("2026-09-08T08:20:00.000Z");

    const updated = await repository.setUserStatusAndRevokeSessions(
      "00000000-0000-4000-8000-000000000001",
      3,
      "disabled",
      "active",
      now
    );

    expect(updated).toMatchObject({ outcome: "changed", user: { status: "active", role: "maintainer", credentialVersion: 4 } });
    expect(harness.unsafeCalls[0].query).toContain("for update");
    expect(harness.unsafeCalls[1].query).toContain("set status = $1::varchar");
    expect(harness.unsafeCalls[1].query).toContain("failed_login_count = case when $1::varchar = 'active' then 0");
    expect(harness.unsafeCalls[1].query).toContain("and status = $5");
    expect(harness.unsafeCalls[1].values).toEqual([
      "active",
      now,
      "00000000-0000-4000-8000-000000000001",
      3,
      "disabled"
    ]);
    expect(harness.templateCalls).toHaveLength(1);
  });

  test("CAS 未命中时不撤销会话，避免覆盖并发账号变更", async () => {
    const harness = transactionHarness([[userRow({ role: "analyst", credential_version: 2 })]]);
    const repository = new PostgresAuthRepository(harness.sql);

    expect(await repository.setUserRoleAndRevokeSessions(
      "00000000-0000-4000-8000-000000000001",
      1,
      "analyst",
      new Date("2026-09-08T08:30:00.000Z")
    )).toMatchObject({ outcome: "conflict" });
    expect(harness.templateCalls).toHaveLength(0);
  });

  test("同值操作在持锁快照中判定无变化且不撤销会话", async () => {
    const harness = transactionHarness([[userRow({ role: "reader", credential_version: 1 })]]);
    const repository = new PostgresAuthRepository(harness.sql);

    expect(await repository.setUserRoleAndRevokeSessions(
      "00000000-0000-4000-8000-000000000001",
      1,
      "reader",
      new Date("2026-09-08T08:35:00.000Z")
    )).toMatchObject({ outcome: "no_change", user: { role: "reader", credentialVersion: 1 } });
    expect(harness.unsafeCalls).toHaveLength(1);
    expect(harness.unsafeCalls[0].query).toContain("for update");
    expect(harness.templateCalls).toHaveLength(0);
  });

  test("会话撤销失败时错误退出事务，由 postgres 驱动回滚用户更新", async () => {
    const harness = transactionHarness(
      [
        [userRow({ role: "reader", credential_version: 1 })],
        [userRow({ role: "analyst", credential_version: 2 })]
      ],
      new Error("session update failed")
    );
    const repository = new PostgresAuthRepository(harness.sql);

    await expect(repository.setUserRoleAndRevokeSessions(
      "00000000-0000-4000-8000-000000000001",
      1,
      "analyst",
      new Date("2026-09-08T08:40:00.000Z")
    )).rejects.toThrow("session update failed");
    expect(harness.rolledBack()).toBe(true);
  });
});
