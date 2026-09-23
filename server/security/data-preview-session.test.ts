import { describe, expect, test } from "bun:test";
import { DataPreviewSessions } from "./data-preview-session";

const context = {
  subjectId: "user-1",
  roles: ["maintainer"],
  permissions: ["bi:read", "bi:data-source-maintenance:enter"],
  securityVersion: "1"
} as const;

function cookiePair(value: string) {
  return value.split(";", 1)[0];
}

function createSession(sessions: DataPreviewSessions) {
  return sessions.create({
    ip: "127.0.0.1",
    context,
    browserSessionId: "ordinary-session-1",
    baseUrl: "https://test.example.com",
    userName: "test-user",
    token: "candidate-test-token"
  });
}

describe("DataPreviewSessions", () => {
  test("测试 Token 只保存在服务端会话且绑定用户、IP 与普通登录会话", () => {
    const sessions = new DataPreviewSessions(() => 1_000);
    const created = createSession(sessions);
    const cookie = cookiePair(sessions.sessionCookie(created.sessionId, true));
    const active = sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader: cookie });

    expect(active.status).toBe("active");
    if (active.status === "active") {
      expect(active.profile).toMatchObject({ environment: "test", baseUrl: "https://test.example.com", userName: "test-user", token: "candidate-test-token" });
      expect(active.profile.cachePartition).not.toContain("candidate-test-token");
    }
    expect(created.expiresAt).toBe(1_000 + 24 * 60 * 60_000);
    expect(sessions.sessionCookie(created.sessionId, true)).toContain("Max-Age=86400");
    expect(sessions.sessionCookie(created.sessionId, true)).not.toContain("candidate-test-token");
  });

  test("普通登录会话、用户安全版本或来源变化时失败关闭并撤销预览会话", () => {
    const sessions = new DataPreviewSessions(() => 1_000);
    const cases = [
      { ip: "127.0.0.2", context, browserSessionId: "ordinary-session-1" },
      { ip: "127.0.0.1", context, browserSessionId: "ordinary-session-2" },
      { ip: "127.0.0.1", context: { ...context, securityVersion: "2" }, browserSessionId: "ordinary-session-1" }
    ];
    for (const changed of cases) {
      const created = createSession(sessions);
      const cookieHeader = cookiePair(sessions.sessionCookie(created.sessionId, true));
      expect(sessions.resolve({ ...changed, cookieHeader }).status).toBe("invalid");
      expect(sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader }).status).toBe("invalid");
    }
  });

  test("过期、显式退出、重复 Cookie 与按用户撤销均不再返回测试凭据", () => {
    let now = 1_000;
    const sessions = new DataPreviewSessions(() => now);
    const created = createSession(sessions);
    const cookie = cookiePair(sessions.sessionCookie(created.sessionId, false));

    expect(sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader: `${cookie}; ${cookie}` }).status).toBe("missing");
    now += 24 * 60 * 60_000 - 1;
    expect(sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader: cookie }).status).toBe("active");
    now += 2;
    expect(sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader: cookie }).status).toBe("expired");

    const second = createSession(sessions);
    const secondCookie = cookiePair(sessions.sessionCookie(second.sessionId, false));
    expect(sessions.revoke(secondCookie)).toBe(true);
    expect(sessions.resolve({ ip: "127.0.0.1", context, browserSessionId: "ordinary-session-1", cookieHeader: secondCookie }).status).toBe("invalid");

    createSession(sessions);
    expect(sessions.revokeSubject("user-1")).toBe(1);
  });
});
