import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readUniqueOpaqueCookie } from "../auth/cookies";
import { createOpaqueToken, hashOpaqueToken } from "../auth/tokens";

const SESSION_COOKIE = "bi_maintenance_session";
const SESSION_TTL_MS = 15 * 24 * 60 * 60_000;
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

export interface MaintenanceSessionBinding {
  tokenHash: string;
  ordinaryTokenHash: string;
  subjectId: string;
  ip: string;
  securityFingerprint: string;
  keyTag: string;
}

export interface MaintenanceSessionRepository {
  create(binding: MaintenanceSessionBinding & { createdAt: Date; expiresAt: Date }): Promise<boolean>;
  authenticate(binding: MaintenanceSessionBinding & { now: Date }): Promise<boolean>;
  revoke(tokenHash: string, ordinaryTokenHash: string): Promise<void>;
  prune(keyTag: string | null, now: Date): Promise<void>;
}

export interface PersistentMaintenanceOptions {
  repository: MaintenanceSessionRepository;
  keyTagSecret: string;
}

export class MaintenanceSessionStoreError extends Error {
  constructor() {
    super("维护会话暂时无法读取或保存，请稍后重试");
  }
}

export class MaintenanceOrdinarySessionRequiredError extends Error {
  constructor() {
    super("普通登录会话已失效，请重新登录");
  }
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

function passwordDigest(expected: string) {
  return expected.startsWith("sha256:") ? Buffer.from(expected.slice(7), "hex") : digest(expected);
}

function passwordMatches(expected: string, received: string) {
  const expectedDigest = passwordDigest(expected);
  const receivedDigest = digest(received);
  return expectedDigest.length === receivedDigest.length && timingSafeEqual(expectedDigest, receivedDigest);
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

  private readonly keyTag: string | null;

  constructor(
    private readonly expectedPassword: string | undefined,
    private readonly now: () => number = Date.now,
    private readonly persistent?: PersistentMaintenanceOptions
  ) {
    this.keyTag = persistent && expectedPassword
      ? createHmac("sha256", persistent.keyTagSecret)
          .update("ypbi-maintenance-password-v1\0")
          .update(passwordDigest(expectedPassword))
          .digest("hex")
      : null;
  }

  async initialize() {
    const repository = this.persistent?.repository;
    if (repository) await this.accessStore(() => repository.prune(this.keyTag, new Date(this.now())));
  }

  private async accessStore<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch {
      throw new MaintenanceSessionStoreError();
    }
  }

  private binding(
    token: string,
    ordinaryToken: string | null,
    ip: string,
    securityContext: NonNullable<ReturnType<typeof bindSecurityContext>>
  ): MaintenanceSessionBinding | null {
    if (!ordinaryToken || !this.keyTag) return null;
    return {
      tokenHash: hashOpaqueToken(token),
      ordinaryTokenHash: hashOpaqueToken(ordinaryToken),
      subjectId: securityContext.subjectId,
      ip,
      securityFingerprint: securityContext.fingerprint.toString("hex"),
      keyTag: this.keyTag
    };
  }

  enabled() {
    return Boolean(this.expectedPassword);
  }

  async login(ip: string, context: MaintenanceSecurityContext, password: string, ordinaryToken: string | null = null) {
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
    const token = createOpaqueToken();
    const expiresAt = now + SESSION_TTL_MS;
    const repository = this.persistent?.repository;
    if (repository) {
      const binding = this.binding(token, ordinaryToken, ip, securityContext);
      if (!binding) throw new MaintenanceOrdinarySessionRequiredError();
      const created = await this.accessStore(() => repository.create({
        ...binding,
        createdAt: new Date(now),
        expiresAt: new Date(expiresAt)
      }));
      if (!created) throw new MaintenanceOrdinarySessionRequiredError();
    } else {
      this.sessions.set(token, {
        ip,
        subjectId: securityContext.subjectId,
        securityFingerprint: securityContext.fingerprint,
        expiresAt
      });
    }
    return { token, expiresAt };
  }

  async authenticate(
    ip: string,
    context: MaintenanceSecurityContext,
    cookieHeader: string | undefined,
    ordinaryToken: string | null = null
  ) {
    const token = readUniqueOpaqueCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return false;
    const securityContext = bindSecurityContext(context);
    const repository = this.persistent?.repository;
    if (repository) {
      const binding = securityContext && this.binding(token, ordinaryToken, ip, securityContext);
      if (!binding) return false;
      return this.accessStore(() => repository.authenticate({ ...binding, now: new Date(this.now()) }));
    }
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

  async logout(cookieHeader: string | undefined, ordinaryToken: string | null = null) {
    const token = readUniqueOpaqueCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return;
    const repository = this.persistent?.repository;
    if (repository) {
      if (!ordinaryToken) throw new MaintenanceOrdinarySessionRequiredError();
      await this.accessStore(() => repository.revoke(hashOpaqueToken(token), hashOpaqueToken(ordinaryToken)));
    } else {
      this.sessions.delete(token);
    }
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
