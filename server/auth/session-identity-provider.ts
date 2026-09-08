import type { IdentityProvider } from "../identity/identity-provider";
import {
  type BiSessionCookieConfiguration,
  readUniqueOpaqueCookie,
  resolveSessionCookieConfiguration
} from "./cookies";
import type { BiAuthService } from "./service";

export class SessionIdentityProvider implements IdentityProvider {
  private readonly cookieConfiguration: Readonly<BiSessionCookieConfiguration>;

  constructor(
    private readonly authService: BiAuthService,
    sessionCookie?: BiSessionCookieConfiguration
  ) {
    this.cookieConfiguration = resolveSessionCookieConfiguration(sessionCookie);
  }

  async resolve(context: Parameters<IdentityProvider["resolve"]>[0]) {
    if (context.signal.aborted) return { status: "unavailable", reason: "身份解析已取消" } as const;
    try {
      const rawCookie = context.headers.cookie;
      const cookieHeader = Array.isArray(rawCookie) ? rawCookie.join(";") : rawCookie;
      const token = readUniqueOpaqueCookie(cookieHeader, this.cookieConfiguration.name);
      const session = await this.authService.resolveSession(token, context.signal);
      if (context.signal.aborted) return { status: "unavailable", reason: "身份解析已取消" } as const;
      if (!session) return { status: "unauthenticated" } as const;
      return {
        status: "authenticated",
        principal: {
          subjectId: session.principal.subjectId,
          displayName: session.principal.displayName ?? session.principal.username,
          roles: [session.principal.role],
          permissions: session.principal.permissions,
          pidScope: "all",
          securityVersion: String(session.record.user.credentialVersion)
        }
      } as const;
    } catch {
      return { status: "unavailable", reason: "身份存储当前不可用" } as const;
    }
  }
}
