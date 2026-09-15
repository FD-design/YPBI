import { describe, expect, test } from "bun:test";
import { MemoryAuthRepository } from "./repository";
import { BiAccountAdminService, BiAuthService } from "./service";
import { SessionIdentityProvider } from "./session-identity-provider";
import { BI_SESSION_COOKIE, LOCAL_BI_SESSION_COOKIE } from "./cookies";
import type { ScryptParameters } from "./password";

const testScryptParameters: ScryptParameters = {
  N: 2 ** 10,
  r: 8,
  p: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 4 * 1024 * 1024
};

describe("SessionIdentityProvider", () => {
  test("首次改密前只允许改密，改密后才授予角色权限且 PID 始终为 all", async () => {
    const repository = new MemoryAuthRepository();
    const accounts = new BiAccountAdminService(repository, testScryptParameters);
    await accounts.createAccount({
      username: "alice",
      role: "reader",
      password: "Correct-password-2026"
    });
    const service = await BiAuthService.create(repository, {
      csrfSecret: "test-only-csrf-secret-at-least-32-bytes",
      scryptParameters: testScryptParameters
    });
    const provider = new SessionIdentityProvider(service);
    const login = await service.login("alice", "Correct-password-2026");
    const context = (token: string) => ({
      headers: { cookie: `${BI_SESSION_COOKIE}=${token}` },
      ip: "127.0.0.1",
      signal: new AbortController().signal
    });

    const forcedChange = await provider.resolve(context(login.sessionToken));
    expect(forcedChange).toMatchObject({
      status: "authenticated",
      principal: { permissions: ["bi:account:change-password"], pidScope: "all" }
    });

    const session = await service.resolveSession(login.sessionToken);
    const changed = await service.changePassword(session!, "Correct-password-2026", "Replacement-password-2026");
    const active = await provider.resolve(context(changed.sessionToken));
    expect(active).toMatchObject({
      status: "authenticated",
      principal: { permissions: expect.arrayContaining(["bi:read"]), pidScope: "all" }
    });
  });

  test("身份解析器支持与认证路由一致的本地 Cookie 配置", async () => {
    const repository = new MemoryAuthRepository();
    const accounts = new BiAccountAdminService(repository, testScryptParameters);
    await accounts.createAccount({
      username: "alice",
      role: "reader",
      password: "Correct-password-2026"
    });
    const service = await BiAuthService.create(repository, {
      csrfSecret: "test-only-csrf-secret-at-least-32-bytes",
      scryptParameters: testScryptParameters
    });
    const provider = new SessionIdentityProvider(service, LOCAL_BI_SESSION_COOKIE);
    const login = await service.login("alice", "Correct-password-2026");

    const result = await provider.resolve({
      headers: { cookie: `${LOCAL_BI_SESSION_COOKIE.name}=${login.sessionToken}` },
      ip: "127.0.0.1",
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      status: "authenticated",
      principal: { pidScope: "all" }
    });
  });
});
