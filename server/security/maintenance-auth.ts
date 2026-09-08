import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "bi_maintenance_session";
const SESSION_TTL_MS = 30 * 60_000;
const LOCK_TTL_MS = 15 * 60_000;

interface AuthFailure {
  count: number;
  resetAt: number;
}

interface AuthSession {
  ip: string;
  subjectId: string;
  securityFingerprint: Buffer;
  expiresAt: number;
}

export interface MaintenanceSecurityContext {
  subjectId: string;
  roles: readonly string[];
  permissions: readonly string[];
  securityVersion: string;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function passwordMatches(expected: string, received: string) {
  const expectedDigest = expected.startsWith("sha256:")
    ? Buffer.from(expected.slice(7), "hex")
    : digest(expected);
  const receivedDigest = digest(received);
  return expectedDigest.length === receivedDigest.length && timingSafeEqual(expectedDigest, receivedDigest);
}

function cookieValue(cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const pair = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  return pair ? pair.slice(SESSION_COOKIE.length + 1) : null;
}

function validSubjectId(subjectId: unknown): subjectId is string {
  return typeof subjectId === "string"
    && subjectId.length > 0
    && subjectId.length <= 256
    && subjectId.trim() === subjectId;
}

function canonicalValues(values: readonly string[], maximumItems: number, maximumLength: number) {
  if (!Array.isArray(values) || values.length > maximumItems) return null;
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || value.length > maximumLength || value.trim() !== value) return null;
    normalized.push(value);
  }
  return [...new Set(normalized)].sort();
}

function bindSecurityContext(context: MaintenanceSecurityContext) {
  if (!context || !validSubjectId(context.subjectId)) return null;
  if (
    typeof context.securityVersion !== "string"
    || context.securityVersion.length === 0
    || context.securityVersion.length > 128
    || context.securityVersion.trim() !== context.securityVersion
  ) return null;
  const roles = canonicalValues(context.roles, 64, 64);
  const permissions = canonicalValues(context.permissions, 64, 128);
  if (!roles || !permissions) return null;
  return {
    subjectId: context.subjectId,
    fingerprint: digest(JSON.stringify([
      context.subjectId,
      context.securityVersion,
      roles,
      permissions
    ]))
  };
}

export class MaintenanceAuth {
  private readonly failures = new Map<string, AuthFailure>();
  private readonly sessions = new Map<string, AuthSession>();

  constructor(
    private readonly expectedPassword: string | undefined,
    private readonly now: () => number = Date.now
  ) {}

  enabled() {
    return Boolean(this.expectedPassword);
  }

  login(ip: string, context: MaintenanceSecurityContext, password: string) {
    if (!this.expectedPassword) throw new Error("数据源维护功能尚未启用");
    const securityContext = bindSecurityContext(context);
    if (!securityContext) throw new Error("数据源维护需要完整且有效的普通用户安全上下文");
    const now = this.now();
    const failure = this.failures.get(ip);
    if (failure && failure.resetAt > now && failure.count >= 5) throw new Error("验证失败次数过多，请 15 分钟后重试");
    if (!passwordMatches(this.expectedPassword, password)) {
      this.failures.set(ip, {
        count: failure && failure.resetAt > now ? failure.count + 1 : 1,
        resetAt: now + LOCK_TTL_MS
      });
      throw new Error("维护密码错误");
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    this.sessions.set(token, {
      ip,
      subjectId: securityContext.subjectId,
      securityFingerprint: securityContext.fingerprint,
      expiresAt
    });
    return { token, expiresAt };
  }

  authenticate(ip: string, context: MaintenanceSecurityContext, cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader);
    if (!token) return false;
    const securityContext = bindSecurityContext(context);
    const session = this.sessions.get(token);
    if (
      !securityContext
      || !session
      || session.ip !== ip
      || session.subjectId !== securityContext.subjectId
      || session.securityFingerprint.length !== securityContext.fingerprint.length
      || !timingSafeEqual(session.securityFingerprint, securityContext.fingerprint)
      || session.expiresAt <= this.now()
    ) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader);
    if (token) this.sessions.delete(token);
  }

  revokeSubject(subjectId: string) {
    if (!validSubjectId(subjectId)) return 0;
    let revoked = 0;
    for (const [token, session] of this.sessions) {
      if (session.subjectId !== subjectId) continue;
      this.sessions.delete(token);
      revoked += 1;
    }
    return revoked;
  }

  sessionCookie(token: string) {
    return `${SESSION_COOKIE}=${token}; Path=/api/bi/admin; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/api/bi/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
  }
}
