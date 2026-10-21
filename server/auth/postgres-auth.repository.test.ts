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
  for (const hasRow of [false, true]) test(`已提交身份查询取消后等待SQL结算，丢弃${hasRow ? "身份" : "空"}结果且不发送迟到取消`, async () => {
    let cancelled = false;
    let reads = 0;
    let settled = false;
    let started: () => void = () => undefined;
    const queryStarted = new Promise<void>(resolve => { started = resolve; });
    let finishQuery: (rows: unknown[]) => void = () => undefined;
    const pending = Object.assign(
      new Promise<unknown[]>(resolve => { finishQuery = resolve; }),
      {
        cancel: () => {
          cancelled = true;
        }
      }
    );
    const unsafe = () => { reads++; started(); return pending; };
    const sql = { unsafe } as unknown as Sql;
    const repository = new PostgresAuthRepository(sql);
    const controller = new AbortController();
    beginIdentityLookupDiagnostics(controller.signal, 3000);

    const lookup = repository.findAuthenticatedSession(
      "a".repeat(64),
      new Date("2026-09-08T08:00:00.000Z"),
      controller.signal
    ).finally(() => { settled = true; });
    await queryStarted;
    const frozen = freezeIdentityLookupFailure(controller.signal, "deadline_exceeded");
    expect(frozen.phase).toBe("query");
    const abortReason = new Error("identity deadline exceeded");
    controller.abort(abortReason);
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(settled).toBe(false);

    finishQuery(hasRow ? [{ ...userRow(), session_id: "session-test", token_hash: "a".repeat(64),
      user_created_at: new Date(), expires_at: new Date(), revoked_at: null }] : []);
    await expect(lookup).rejects.toBe(abortReason);
    expect(cancelled).toBe(false);
    expect(reads).toBe(1);
    expect(freezeIdentityLookupFailure(controller.signal)).toBe(frozen);
  });

  test("取消后SQL达到数据库语句期限保留原错误与已冻结的身份超时诊断", async () => {
    let rejectQuery: (error: Error) => void = () => undefined;
    let started: () => void = () => undefined;
    const queryStarted = new Promise<void>(resolve => { started = resolve; });
    const pending = Object.assign(new Promise<never>((_resolve, reject) => { rejectQuery = reject; }), {
      cancel: () => { throw new Error("identity must not send protocol cancellation"); }
    });
    const repository = new PostgresAuthRepository({ unsafe: () => { started(); return pending; } } as unknown as Sql);
    const controller = new AbortController();
    beginIdentityLookupDiagnostics(controller.signal, 3000);
    const lookup = repository.findAuthenticatedSession("a".repeat(64), new Date(), controller.signal);
    await queryStarted;
    const frozen = freezeIdentityLookupFailure(controller.signal, "deadline_exceeded");
    controller.abort(new Error("identity deadline exceeded"));
    const statementTimeout = Object.assign(new Error("statement deadline exceeded"), { code: "57014" });
    rejectQuery(statementTimeout);
    await expect(lookup).rejects.toBe(statementTimeout);
    expect(freezeIdentityLookupFailure(controller.signal)).toBe(frozen);
  });

  test("已提交查询取消后连接失败保留原错误且只提交一次", async () => {
    let fail: (error: Error) => void = () => undefined;
    let reads = 0;
    const pending = new Promise((_resolve, reject) => { fail = reject; });
    const sql = { unsafe: () => { reads++; return pending; } } as unknown as Sql;
    const controller = new AbortController();
    const lookup = new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), controller.signal);
    controller.abort(new Error("lookup cancelled"));
    const failure = Object.assign(new Error("connection unavailable"), { code: "CONNECTION_CLOSED" });
    fail(failure);
    await expect(lookup).rejects.toBe(failure);
    expect(reads).toBe(1);
  });

  test("已取消的身份请求不提交数据库查询", async () => {
    let reads = 0;
    const sql = { unsafe: async () => { reads++; return []; } } as unknown as Sql;
    const controller = new AbortController();
    controller.abort();
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), controller.signal)).rejects.toThrow();
    expect(reads).toBe(0);
  });

  test("身份SQL错误保留原错误与query阶段诊断", async () => {
    const failure = new Error("statement failed");
    const unsafe = () => Promise.reject(failure);
    const sql = { unsafe } as unknown as Sql;
    const signal = new AbortController().signal;
    beginIdentityLookupDiagnostics(signal, 3000);
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), signal)).rejects.toBe(failure);
    expect(freezeIdentityLookupFailure(signal)).toMatchObject({ failureCode: "storage_unavailable", phase: "query", storageFailureCode: "unknown" });
  });

  for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "57014", "55P03", "42601", "unknown"]) {
    test(`身份查询${code}错误保留且不自动重试`, async () => {
      let reads = 0;
      const failure = Object.assign(new Error("memory query failure"), { code });
      const sql = { unsafe: () => { reads++; return Promise.reject(failure); } } as unknown as Sql;
      await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date())).rejects.toBe(failure);
      expect(reads).toBe(1);
    });
  }

  test("调用方取消原因与连接错误同码时，成功结算仍拒绝身份", async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error("memory client cancellation"), { code: "ECONNRESET" });
    const sql = { unsafe: async () => { controller.abort(reason); return []; } } as unknown as Sql;
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("a".repeat(64), new Date(), controller.signal)).rejects.toBe(reason);
  });

  test("身份查询保留会话到期、撤销、账号状态及权限版本过滤且只提交一次", async () => {
    const now = new Date("2026-10-19T00:00:00Z");
    const tokenHash = "b".repeat(64);
    const calls: CapturedUnsafeCall[] = [];
    const row = { ...userRow({ must_change_password: false }), session_id: "session-test", token_hash: tokenHash,
      user_created_at: now, expires_at: new Date(now.getTime() + 60_000), revoked_at: null };
    const sql = { unsafe: async (query: string, values: unknown[]) => { calls.push({ query, values }); return [row]; } } as unknown as Sql;
    const result = await new PostgresAuthRepository(sql).findAuthenticatedSession(tokenHash, now);
    expect(result?.session.id).toBe("session-test");
    expect(result?.user.role).toBe("reader");
    expect(calls).toHaveLength(1);
    for (const clause of ["s.token_hash = $1", "s.revoked_at is null", "s.expires_at > $2", "u.status = 'active'", "u.credential_version = s.credential_version"]) {
      expect(calls[0].query).toContain(clause);
    }
    expect(calls[0].values).toEqual([tokenHash, now]);
  });

  test("查询成功但账号数据非法时不授予身份", async () => {
    const row = { ...userRow({ role: "invalid-role" }), session_id: "session-test", token_hash: "c".repeat(64),
      user_created_at: new Date(), expires_at: new Date(), revoked_at: null };
    const sql = { unsafe: async () => [row] } as unknown as Sql;
    const signal = new AbortController().signal;
    beginIdentityLookupDiagnostics(signal, 3000);
    await expect(new PostgresAuthRepository(sql).findAuthenticatedSession("c".repeat(64), new Date(), signal)).rejects.toThrow("未知 BI 角色");
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
