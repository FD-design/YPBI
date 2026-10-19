import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { PostgresAuthRepository } from "./postgres-auth.repository";
import { beginIdentityLookupDiagnostics, freezeIdentityLookupFailure } from "../identity/identity-lookup-diagnostics";

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
    let released = 0;
    let started: () => void = () => undefined;
    const queryStarted = new Promise<void>(resolve => { started = resolve; });
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
    const unsafe = () => { started(); return pending; };
    const connection = { unsafe, release: () => { released++; } };
    const sql = { unsafe, reserve: async () => connection } as unknown as Sql;
    const repository = new PostgresAuthRepository(sql);
    const controller = new AbortController();
    beginIdentityLookupDiagnostics(controller.signal, 3000);

    const lookup = repository.findAuthenticatedSession(
      "a".repeat(64),
      new Date("2026-09-08T08:00:00.000Z"),
      controller.signal
    );
    await queryStarted;
    const frozen = freezeIdentityLookupFailure(controller.signal, "deadline_exceeded");
    expect(frozen.phase).toBe("query");
    controller.abort();

    await expect(lookup).rejects.toThrow("query cancelled");
    expect(cancelled).toBe(true);
    expect(released).toBe(1);
    expect(freezeIdentityLookupFailure(controller.signal)).toBe(frozen);
  });

  test("冷连接等待取消后立即拒绝，晚到连接只归还而不执行身份SQL", async () => {
    let grant: (connection: unknown) => void = () => undefined;
    let reads = 0;
    let released = 0;
    const connection = { unsafe: () => { reads++; return Promise.resolve([]); }, release: () => { released++; } };
    const reserved = new Promise(resolve => { grant = resolve; });
    const sql = { unsafe: connection.unsafe, reserve: () => reserved } as unknown as Sql;
    const repository = new PostgresAuthRepository(sql);
    const controller = new AbortController();
    beginIdentityLookupDiagnostics(controller.signal, 3000);
    const lookup = repository.findAuthenticatedSession("a".repeat(64), new Date(), controller.signal);
    const frozen = freezeIdentityLookupFailure(controller.signal, "deadline_exceeded");
    expect(frozen.phase).toBe("acquire");
    controller.abort(new Error("request cancelled"));
    await expect(lookup).rejects.toThrow("request cancelled");
    expect(reads).toBe(0);
    grant(connection);
    await reserved;
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(released).toBe(1);
    expect(freezeIdentityLookupFailure(controller.signal)).toBe(frozen);
  });

  test("取消后连接获取失败不会启动SQL或产生未处理拒绝", async () => {
    let fail: (error: Error) => void = () => undefined;
    let reads = 0;
    const reserved = new Promise((_resolve, reject) => { fail = reject; });
    const sql = { unsafe: async () => { reads++; return []; }, reserve: () => reserved } as unknown as Sql;
    const controller = new AbortController();
    const lookup = new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), controller.signal);
    controller.abort(new Error("lookup cancelled"));
    await expect(lookup).rejects.toThrow("lookup cancelled");
    fail(new Error("connection unavailable"));
    await Promise.resolve();
    expect(reads).toBe(0);
  });

  test("已取消的身份请求不获取数据库连接", async () => {
    let acquired = 0;
    const sql = { reserve: async () => { acquired++; } } as unknown as Sql;
    const controller = new AbortController();
    controller.abort();
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), controller.signal)).rejects.toThrow();
    expect(acquired).toBe(0);
  });

  test("身份SQL错误后归还专用连接，保留原错误", async () => {
    let released = 0;
    const failure = new Error("statement failed");
    const unsafe = () => Promise.reject(failure);
    const sql = { unsafe, reserve: async () => ({ unsafe, release: () => { released++; } }) } as unknown as Sql;
    const signal = new AbortController().signal;
    beginIdentityLookupDiagnostics(signal, 3000);
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), signal)).rejects.toBe(failure);
    expect(released).toBe(1);
    expect(freezeIdentityLookupFailure(signal)).toMatchObject({ failureCode: "storage_unavailable", phase: "query", storageFailureCode: "unknown" });
  });

  test("就绪连接保留会话到期、撤销、账号状态及权限版本过滤，成功后只归还一次", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const tokenHash = "b".repeat(64);
    let released = 0;
    const calls: CapturedUnsafeCall[] = [];
    const row = { ...userRow({ must_change_password: false }), session_id: "session-test", token_hash: tokenHash,
      user_created_at: now, expires_at: new Date(now.getTime() + 60_000), revoked_at: null };
    const connection = {
      unsafe: async (query: string, values: unknown[]) => { calls.push({ query, values }); return [row]; },
      release: () => { released++; }
    };
    const sql = { reserve: async () => connection, unsafe: () => { throw new Error("unreserved lookup"); } } as unknown as Sql;
    const result = await new PostgresAuthRepository(sql).findAuthenticatedSession(tokenHash, now);
    expect(result?.session.id).toBe("session-test");
    expect(result?.user.role).toBe("reader");
    expect(calls).toHaveLength(1);
    for (const clause of ["s.token_hash = $1", "s.revoked_at is null", "s.expires_at > $2", "u.status = 'active'", "u.credential_version = s.credential_version"]) {
      expect(calls[0].query).toContain(clause);
    }
    expect(calls[0].values).toEqual([tokenHash, now]);
    expect(released).toBe(1);
  });

  test("查询成功但账号数据非法时仍归还连接且不授予身份", async () => {
    let released = 0;
    const row = { ...userRow({ role: "invalid-role" }), session_id: "session-test", token_hash: "c".repeat(64),
      user_created_at: new Date(), expires_at: new Date(), revoked_at: null };
    const sql = { reserve: async () => ({ unsafe: async () => [row], release: () => { released++; } }) } as unknown as Sql;
    const signal = new AbortController().signal;
    beginIdentityLookupDiagnostics(signal, 3000);
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("c".repeat(64), new Date(), signal)).rejects.toThrow("未知 BI 角色");
    expect(released).toBe(1);
    expect(freezeIdentityLookupFailure(signal)).toMatchObject({ failureCode: "storage_unavailable", phase: "map", storageFailureCode: "unknown" });
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
