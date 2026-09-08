import { describe, expect, test } from "bun:test";
import { MemoryAuthRepository } from "./repository";
import { permissionsByRole } from "./roles";
import { BiAccountAdminService, BiAuthService } from "./service";
import {
  PasswordKdfGate,
  PasswordWorkCapacityError,
  type ScryptParameters
} from "./password";

const testScryptParameters: ScryptParameters = {
  N: 2 ** 10,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 4 * 1024 * 1024
};

async function harness(
  role: "reader" | "analyst" | "maintainer" = "reader",
  passwordKdfGate?: PasswordKdfGate
) {
  let timestamp = new Date("2026-09-08T08:00:00.000Z");
  const now = () => new Date(timestamp);
  const repository = new MemoryAuthRepository();
  const accounts = new BiAccountAdminService(repository, testScryptParameters, now);
  await accounts.createAccount({
    username: "Alice",
    displayName: "Alice Zhang",
    role,
    password: "Correct-password-2026"
  });
  const service = await BiAuthService.create(repository, {
    csrfSecret: "test-only-csrf-secret-at-least-32-bytes",
    now,
    sessionTtlMs: 60_000,
    scryptParameters: testScryptParameters,
    passwordKdfGate
  });
  return {
    repository,
    accounts,
    service,
    advance(milliseconds: number) { timestamp = new Date(timestamp.getTime() + milliseconds); }
  };
}

describe("BiAuthService", () => {
  test("登录签发不透明会话并固定授予全部 PID", async () => {
    const { service } = await harness("analyst");
    const result = await service.login("  ALICE ", "Correct-password-2026");

    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.principal).toMatchObject({
      username: "Alice",
      displayName: "Alice Zhang",
      role: "analyst",
      pidScope: "all"
    });
    expect(result.mustChangePassword).toBe(true);
    expect(result.principal.permissions).toEqual(["bi:account:change-password"]);
    const resolved = await service.resolveSession(result.sessionToken);
    expect(resolved?.principal.subjectId).toBe(result.principal.subjectId);
  });

  test("账号不存在、密码错误和锁定统一拒绝", async () => {
    const { service, advance } = await harness();

    await expect(service.login("missing", "Wrong-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login("alice", "Wrong-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(service.login("alice", "Correct-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    advance(15 * 60_000 + 1);
    await expect(service.login("alice", "Correct-password-2026")).resolves.toMatchObject({ principal: { username: "Alice" } });
  });

  test("密码计算容量满载时不冒充密码错误或累计账号锁定", async () => {
    const gate = new PasswordKdfGate(1, 2);
    const { service, repository } = await harness("reader", gate);
    let release!: () => void;
    const active = gate.run(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const queuedOne = gate.run(async () => undefined);
    const queuedTwo = gate.run(async () => undefined);

    await expect(service.login("alice", "Wrong-password-2026"))
      .rejects.toBeInstanceOf(PasswordWorkCapacityError);
    expect(await repository.findUserByNormalizedUsername("alice"))
      .toMatchObject({ failedLoginCount: 0, lockedUntil: null });

    release();
    await Promise.all([active, queuedOne, queuedTwo]);
  });

  test("过期、退出、停用及 credential_version 变化都会使会话失效", async () => {
    const { service, accounts, advance } = await harness();

    const expired = await service.login("alice", "Correct-password-2026");
    advance(60_001);
    expect(await service.resolveSession(expired.sessionToken)).toBeNull();

    const loggedOut = await service.login("alice", "Correct-password-2026");
    await service.logout(loggedOut.sessionToken);
    expect(await service.resolveSession(loggedOut.sessionToken)).toBeNull();

    const reset = await service.login("alice", "Correct-password-2026");
    expect(await accounts.resetPassword("alice", "Replacement-password-2026")).toBe(true);
    expect(await service.resolveSession(reset.sessionToken)).toBeNull();
    await expect(service.login("alice", "Correct-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const disabled = await service.login("alice", "Replacement-password-2026");
    await accounts.disableAccount("alice");
    expect(await service.resolveSession(disabled.sessionToken)).toBeNull();
    await expect(service.login("alice", "Replacement-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  test("CSRF 必须同时匹配 Cookie、请求头和服务端哈希", async () => {
    const { service } = await harness();
    const login = await service.login("alice", "Correct-password-2026");
    const session = await service.resolveSession(login.sessionToken);
    expect(session).not.toBeNull();
    expect(service.csrfMatches(login.sessionToken, login.csrfToken)).toBe(true);
    expect(service.csrfMatches(login.sessionToken, "different-token-value-000000000000000000000")).toBe(false);
    expect(service.csrfMatches(login.sessionToken, undefined)).toBe(false);
  });

  test("三档权限逐级包含但不改变 PID 范围", async () => {
    expect(permissionsByRole.analyst).toEqual(expect.arrayContaining(permissionsByRole.reader));
    expect(permissionsByRole.maintainer).toEqual(expect.arrayContaining(permissionsByRole.analyst));
    for (const role of ["reader", "analyst", "maintainer"] as const) {
      const { service } = await harness(role);
      const login = await service.login("alice", "Correct-password-2026");
      expect(login.principal.pidScope).toBe("all");
      expect(login.principal.role).toBe(role);
      expect(login.principal.permissions).toEqual(["bi:account:change-password"]);
    }
  });

  test("首次改密原子撤销旧会话、签发新会话并恢复角色权限", async () => {
    const { service } = await harness("analyst");
    const first = await service.login("alice", "Correct-password-2026");
    const oldSession = await service.resolveSession(first.sessionToken);
    const changed = await service.changePassword(oldSession!, "Correct-password-2026", "Replacement-password-2026");

    expect(changed.mustChangePassword).toBe(false);
    expect(changed.principal.permissions).toEqual([...permissionsByRole.analyst]);
    expect(changed.sessionToken).not.toBe(first.sessionToken);
    expect(await service.resolveSession(first.sessionToken)).toBeNull();
    expect(await service.resolveSession(changed.sessionToken)).not.toBeNull();
  });

  test("角色变化撤销全部旧会话，新登录按新角色授权且仍可访问全部 PID", async () => {
    const { service, accounts } = await harness("reader");
    const first = await service.login("alice", "Correct-password-2026");
    const firstSession = await service.resolveSession(first.sessionToken);
    const passwordChanged = await service.changePassword(
      firstSession!,
      "Correct-password-2026",
      "Replacement-password-2026"
    );
    const second = await service.login("alice", "Replacement-password-2026");

    const roleChanged = await accounts.setAccountRole("  ALICE ", "analyst");
    expect(roleChanged).toMatchObject({ changed: true, user: { role: "analyst" } });
    expect(await service.resolveSession(passwordChanged.sessionToken)).toBeNull();
    expect(await service.resolveSession(second.sessionToken)).toBeNull();

    const relogged = await service.login("alice", "Replacement-password-2026");
    expect(relogged.principal).toMatchObject({
      role: "analyst",
      permissions: permissionsByRole.analyst,
      pidScope: "all"
    });
  });

  test("停用账号可预设角色，重新启用保留凭据并清除登录锁定", async () => {
    const { service, accounts, repository } = await harness("reader");
    const before = await repository.findUserByNormalizedUsername("alice");
    expect(before).not.toBeNull();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await repository.recordLoginFailure(before!.id, new Date("2026-09-08T08:00:00.000Z"), {
        threshold: 5,
        windowMs: 15 * 60_000,
        lockMs: 15 * 60_000
      });
    }

    expect(await accounts.disableAccount("alice")).toMatchObject({ changed: true });
    expect(await accounts.setAccountRole("alice", "maintainer")).toMatchObject({
      changed: true,
      user: { role: "maintainer", status: "disabled" }
    });
    await expect(service.login("alice", "Correct-password-2026")).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(await accounts.enableAccount("Alice")).toMatchObject({ changed: true });
    const after = await repository.findUserByNormalizedUsername("alice");
    expect(after).toMatchObject({
      role: "maintainer",
      status: "active",
      passwordHash: before!.passwordHash,
      mustChangePassword: true,
      failedLoginCount: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null
    });
    const relogged = await service.login("alice", "Correct-password-2026");
    expect(relogged.principal).toMatchObject({ role: "maintainer", pidScope: "all" });
  });

  test("重复设置相同角色或启用状态保持幂等且不撤销有效会话", async () => {
    const { service, accounts } = await harness("reader");
    const login = await service.login("alice", "Correct-password-2026");

    expect(await accounts.setAccountRole("alice", "reader")).toMatchObject({ changed: false });
    expect(await accounts.enableAccount("alice")).toMatchObject({ changed: false });
    expect(await service.resolveSession(login.sessionToken)).not.toBeNull();

    expect(await accounts.disableAccount("alice")).toMatchObject({ changed: true });
    expect(await accounts.disableAccount("alice")).toMatchObject({ changed: false });
    expect(await service.resolveSession(login.sessionToken)).toBeNull();
  });

  test("内存 Repository 使用 credential_version 防止并发角色或状态覆盖", async () => {
    const { repository } = await harness("reader");
    const initial = await repository.findUserByNormalizedUsername("alice");
    expect(initial).not.toBeNull();

    const firstRoleChange = await repository.setUserRoleAndRevokeSessions(
      initial!.id,
      initial!.credentialVersion,
      "analyst",
      new Date("2026-09-08T08:01:00.000Z")
    );
    expect(firstRoleChange.outcome).toBe("changed");
    if (firstRoleChange.outcome !== "changed") throw new Error("角色变更应成功");
    expect(firstRoleChange.user.credentialVersion).toBe(initial!.credentialVersion + 1);
    expect(await repository.setUserRoleAndRevokeSessions(
      initial!.id,
      initial!.credentialVersion,
      "maintainer",
      new Date("2026-09-08T08:01:01.000Z")
    )).toMatchObject({ outcome: "conflict" });

    const firstStatusChange = await repository.setUserStatusAndRevokeSessions(
      initial!.id,
      firstRoleChange.user.credentialVersion,
      "active",
      "disabled",
      new Date("2026-09-08T08:02:00.000Z")
    );
    expect(firstStatusChange.outcome).toBe("changed");
    if (firstStatusChange.outcome !== "changed") throw new Error("状态变更应成功");
    expect(firstStatusChange.user.credentialVersion).toBe(firstRoleChange.user.credentialVersion + 1);
    expect(await repository.setUserStatusAndRevokeSessions(
      initial!.id,
      firstRoleChange.user.credentialVersion,
      "active",
      "disabled",
      new Date("2026-09-08T08:02:01.000Z")
    )).toMatchObject({ outcome: "conflict" });

    expect(await repository.findUserByNormalizedUsername("alice")).toMatchObject({
      role: "analyst",
      status: "disabled",
      credentialVersion: firstRoleChange.user.credentialVersion + 1
    });
  });
});
