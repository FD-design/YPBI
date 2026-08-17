import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MaintenanceAuth } from "./maintenance-auth";

const password = "Example-password-123";
const passwordHash = `sha256:${createHash("sha256").update(password).digest("hex")}`;

describe("MaintenanceAuth", () => {
  test("密码登录后签发会话，接口只校验会话", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = auth.login("127.0.0.1", password);

    expect(session.token.length).toBeGreaterThan(32);
    expect(auth.authenticate("127.0.0.1", `other=1; bi_maintenance_session=${session.token}`)).toBe(true);
    expect(auth.authenticate("127.0.0.2", `bi_maintenance_session=${session.token}`)).toBe(false);
  });

  test("连续五次密码错误后锁定十五分钟", () => {
    let now = 1_000;
    const auth = new MaintenanceAuth(passwordHash, () => now);
    for (let index = 0; index < 5; index += 1) {
      expect(() => auth.login("127.0.0.1", "wrong-password")).toThrow("维护密码错误");
    }
    expect(() => auth.login("127.0.0.1", password)).toThrow("验证失败次数过多");
    now += 15 * 60_000 + 1;
    expect(auth.login("127.0.0.1", password).token.length).toBeGreaterThan(32);
  });

  test("退出后会话立即失效", () => {
    const auth = new MaintenanceAuth(passwordHash, () => 1_000);
    const session = auth.login("127.0.0.1", password);
    auth.logout(`bi_maintenance_session=${session.token}`);
    expect(auth.authenticate("127.0.0.1", `bi_maintenance_session=${session.token}`)).toBe(false);
  });
});
