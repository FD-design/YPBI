import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MaintenanceAuth, MaintenanceSessionStoreError } from "./maintenance-auth";

const password = "Example-password-123";
const passwordHash = `sha256:${createHash("sha256").update(password).digest("hex")}`;
const userOne = {
  subjectId: "user-1",
  roles: ["maintainer"],
  permissions: ["bi:read", "bi:data-source-maintenance:enter"],
  securityVersion: "1"
} as const;
const userTwo = { ...userOne, subjectId: "user-2" } as const;

describe("MaintenanceAuth", async () => {
  test("密码登录后签发会话，同时绑定普通用户与来源 IP", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = await auth.login("127.0.0.1", userOne, password);

    expect(session.token.length).toBeGreaterThan(32);
    expect(session.expiresAt).toBe(1_000 + 15 * 24 * 60 * 60_000);
    expect(auth.sessionCookie(session.token)).toContain("Max-Age=1296000; HttpOnly; Secure; SameSite=Strict");
    expect(await auth.authenticate("127.0.0.1", userOne, `other=1; bi_maintenance_session=${session.token}`)).toBe(true);
    expect(await auth.authenticate("127.0.0.2", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("不同普通用户不能复用其他人的维护会话", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = await auth.login("127.0.0.1", userOne, password);

    expect(await auth.authenticate("127.0.0.1", userTwo, `bi_maintenance_session=${session.token}`)).toBe(false);
    expect(await auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("缺失安全版本或非法普通用户身份失败关闭", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const emptySubject = { ...userOne, subjectId: "" };
    const missingVersion = { ...userOne, securityVersion: "" };

    await expect(auth.login("127.0.0.1", emptySubject, password)).rejects.toThrow("需要完整且有效的普通用户安全上下文");
    await expect(auth.login("127.0.0.1", missingVersion, password)).rejects.toThrow("需要完整且有效的普通用户安全上下文");
    expect(await auth.authenticate("127.0.0.1", missingVersion, "bi_maintenance_session=fake")).toBe(false);
  });

  test("普通账号角色、权限或 credentialVersion 变化都会使旧维护会话失效", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const changedContexts = [
      { ...userOne, roles: ["analyst"] },
      { ...userOne, permissions: ["bi:read"] },
      { ...userOne, securityVersion: "2" }
    ];

    for (const changedContext of changedContexts) {
      const session = await auth.login("127.0.0.1", userOne, password);
      expect(await auth.authenticate(
        "127.0.0.1",
        changedContext,
        `bi_maintenance_session=${session.token}`
      )).toBe(false);
    }
  });

  test("连续五次密码错误后锁定十五分钟", async () => {
    let now = 1_000;
    const auth = new MaintenanceAuth(passwordHash, () => now);
    for (let index = 0; index < 5; index += 1) {
      await expect(auth.login("127.0.0.1", userOne, "wrong-password")).rejects.toThrow("维护密码错误");
    }
    await expect(auth.login("127.0.0.1", userOne, password)).rejects.toThrow("验证失败次数过多");
    now += 15 * 60_000 + 1;
    expect((await auth.login("127.0.0.1", userOne, password)).token.length).toBeGreaterThan(32);
  });

  test("退出后会话立即失效", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = await auth.login("127.0.0.1", userOne, password);
    await auth.logout(`bi_maintenance_session=${session.token}`);
    expect(await auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("普通账号被停用或改密时可撤销该用户的全部维护会话", async () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const first = await auth.login("127.0.0.1", userOne, password);
    const second = await auth.login("127.0.0.2", userOne, password);
    const other = await auth.login("127.0.0.3", userTwo, password);

    expect(auth.revokeSubject("user-1")).toBe(2);
    expect(await auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${first.token}`)).toBe(false);
    expect(await auth.authenticate("127.0.0.2", userOne, `bi_maintenance_session=${second.token}`)).toBe(false);
    expect(await auth.authenticate("127.0.0.3", userTwo, `bi_maintenance_session=${other.token}`)).toBe(true);
    expect(auth.revokeSubject("user-1")).toBe(0);
  });

  test("维护会话固定有效15天，认证不续期且精确到期", async () => {
    let now = 1_000;
    const auth = new MaintenanceAuth(passwordHash, () => now);
    const session = await auth.login("127.0.0.1", userOne, password);
    const expiresAt = 1_000 + 15 * 24 * 60 * 60_000;
    expect(session.expiresAt).toBe(expiresAt);
    for (const elapsed of [30 * 60_000 + 1, 12 * 60 * 60_000 + 1, 15 * 24 * 60 * 60_000 - 1]) {
      now = 1_000 + elapsed;
      expect(await auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(true);
      expect(session.expiresAt).toBe(expiresAt);
    }
    now = expiresAt;

    expect(await auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("维护会话存储错误不会被当成密码错误或无会话", async () => {
    const unavailable = async () => { throw new Error("storage diagnostic"); };
    const auth = new MaintenanceAuth(passwordHash, () => 1_000, {
      keyTagSecret: "test-key-tag-secret",
      repository: {
        create: unavailable,
        authenticate: unavailable,
        revoke: unavailable,
        prune: async () => {}
      }
    });
    const token = "a".repeat(43);
    const ordinaryToken = "b".repeat(43);
    const cookie = `bi_maintenance_session=${token}`;

    await expect(auth.login("127.0.0.1", userOne, password, ordinaryToken)).rejects.toBeInstanceOf(MaintenanceSessionStoreError);
    await expect(auth.authenticate("127.0.0.1", userOne, cookie, ordinaryToken)).rejects.toBeInstanceOf(MaintenanceSessionStoreError);
    await expect(auth.logout(cookie, ordinaryToken)).rejects.toBeInstanceOf(MaintenanceSessionStoreError);
  });
});
