import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MaintenanceAuth } from "./maintenance-auth";

const password = "Example-password-123";
const passwordHash = `sha256:${createHash("sha256").update(password).digest("hex")}`;
const userOne = {
  subjectId: "user-1",
  roles: ["maintainer"],
  permissions: ["bi:read", "bi:data-source-maintenance:enter"],
  securityVersion: "1"
} as const;
const userTwo = { ...userOne, subjectId: "user-2" } as const;

describe("MaintenanceAuth", () => {
  test("密码登录后签发会话，同时绑定普通用户与来源 IP", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = auth.login("127.0.0.1", userOne, password);

    expect(session.token.length).toBeGreaterThan(32);
    expect(auth.authenticate("127.0.0.1", userOne, `other=1; bi_maintenance_session=${session.token}`)).toBe(true);
    expect(auth.authenticate("127.0.0.2", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("不同普通用户不能复用其他人的维护会话", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = auth.login("127.0.0.1", userOne, password);

    expect(auth.authenticate("127.0.0.1", userTwo, `bi_maintenance_session=${session.token}`)).toBe(false);
    expect(auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("缺失安全版本或非法普通用户身份失败关闭", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const emptySubject = { ...userOne, subjectId: "" };
    const missingVersion = { ...userOne, securityVersion: "" };

    expect(() => auth.login("127.0.0.1", emptySubject, password)).toThrow("需要完整且有效的普通用户安全上下文");
    expect(() => auth.login("127.0.0.1", missingVersion, password)).toThrow("需要完整且有效的普通用户安全上下文");
    expect(auth.authenticate("127.0.0.1", missingVersion, "bi_maintenance_session=fake")).toBe(false);
  });

  test("普通账号角色、权限或 credentialVersion 变化都会使旧维护会话失效", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const changedContexts = [
      { ...userOne, roles: ["analyst"] },
      { ...userOne, permissions: ["bi:read"] },
      { ...userOne, securityVersion: "2" }
    ];

    for (const changedContext of changedContexts) {
      const session = auth.login("127.0.0.1", userOne, password);
      expect(auth.authenticate(
        "127.0.0.1",
        changedContext,
        `bi_maintenance_session=${session.token}`
      )).toBe(false);
    }
  });

  test("连续五次密码错误后锁定十五分钟", () => {
    let now = 1_000;
    const auth = new MaintenanceAuth(passwordHash, () => now);
    for (let index = 0; index < 5; index += 1) {
      expect(() => auth.login("127.0.0.1", userOne, "wrong-password")).toThrow("维护密码错误");
    }
    expect(() => auth.login("127.0.0.1", userOne, password)).toThrow("验证失败次数过多");
    now += 15 * 60_000 + 1;
    expect(auth.login("127.0.0.1", userOne, password).token.length).toBeGreaterThan(32);
  });

  test("退出后会话立即失效", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = auth.login("127.0.0.1", userOne, password);
    auth.logout(`bi_maintenance_session=${session.token}`);
    expect(auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("普通账号被停用或改密时可撤销该用户的全部维护会话", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const first = auth.login("127.0.0.1", userOne, password);
    const second = auth.login("127.0.0.2", userOne, password);
    const other = auth.login("127.0.0.3", userTwo, password);

    expect(auth.revokeSubject("user-1")).toBe(2);
    expect(auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${first.token}`)).toBe(false);
    expect(auth.authenticate("127.0.0.2", userOne, `bi_maintenance_session=${second.token}`)).toBe(false);
    expect(auth.authenticate("127.0.0.3", userTwo, `bi_maintenance_session=${other.token}`)).toBe(true);
    expect(auth.revokeSubject("user-1")).toBe(0);
  });

  test("过期会话失效并从内存中移除", () => {
    let now = 1_000;
    const auth = new MaintenanceAuth(passwordHash, () => now);
    const session = auth.login("127.0.0.1", userOne, password);
    now += 30 * 60_000 + 1;

    expect(auth.authenticate("127.0.0.1", userOne, `bi_maintenance_session=${session.token}`)).toBe(false);
  });
});
