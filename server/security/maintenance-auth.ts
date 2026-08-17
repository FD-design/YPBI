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
  expiresAt: number;
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

  login(ip: string, password: string) {
    if (!this.expectedPassword) throw new Error("数据源维护功能尚未启用");
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
    this.sessions.set(token, { ip, expiresAt });
    return { token, expiresAt };
  }

  authenticate(ip: string, cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader);
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session || session.ip !== ip || session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(cookieHeader: string | undefined) {
    const token = cookieValue(cookieHeader);
    if (token) this.sessions.delete(token);
  }

  sessionCookie(token: string) {
    return `${SESSION_COOKIE}=${token}; Path=/api/bi/admin; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Strict`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; Path=/api/bi/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
  }
}
