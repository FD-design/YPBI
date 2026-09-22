import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MaintenanceSecurityContext } from "./maintenance-auth";
import type { UpstreamRequestProfile } from "../upstream/request-profile";

const PREVIEW_COOKIE = "ypbi_data_preview";
const SESSION_TTL_MS = 30 * 60_000;
const MAX_PREVIEW_SESSIONS = 500;

interface PreviewSession {
  ip: string;
  subjectId: string;
  securityFingerprint: Buffer;
  browserSessionFingerprint: Buffer;
  expiresAt: number;
  profile: UpstreamRequestProfile;
}

export type DataPreviewResolution =
  | { status: "active"; expiresAt: number; profile: UpstreamRequestProfile }
  | { status: "missing" | "invalid" | "expired" };

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function secureEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalValues(values: readonly string[], maximumItems: number, maximumLength: number) {
  if (!Array.isArray(values) || values.length > maximumItems) return null;
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value || value.length > maximumLength || value.trim() !== value) return null;
    normalized.push(value);
  }
  return [...new Set(normalized)].sort();
}

function bindSecurityContext(context: MaintenanceSecurityContext) {
  if (
    !context
    || typeof context.subjectId !== "string"
    || !context.subjectId
    || context.subjectId.length > 256
    || context.subjectId.trim() !== context.subjectId
    || typeof context.securityVersion !== "string"
    || !context.securityVersion
    || context.securityVersion.length > 128
    || context.securityVersion.trim() !== context.securityVersion
  ) return null;
  const roles = canonicalValues(context.roles, 64, 64);
  const permissions = canonicalValues(context.permissions, 64, 128);
  if (!roles || !permissions) return null;
  return {
    subjectId: context.subjectId,
    fingerprint: digest(JSON.stringify([context.subjectId, context.securityVersion, roles, permissions]))
  };
}

function cookieValue(cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const values = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${PREVIEW_COOKIE}=`))
    .map((item) => item.slice(PREVIEW_COOKIE.length + 1));
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0] ?? "") ? values[0] : null;
}

export class DataPreviewSessions {
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune() {
    const now = this.now();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId);
    }
    while (this.sessions.size >= MAX_PREVIEW_SESSIONS) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (typeof oldestSessionId !== "string") break;
      this.sessions.delete(oldestSessionId);
    }
  }

  create(input: {
    ip: string;
    context: MaintenanceSecurityContext;
    browserSessionId: string;
    baseUrl: string;
    userName: string;
    token: string;
  }) {
    const securityContext = bindSecurityContext(input.context);
    if (!securityContext || !input.browserSessionId) {
      throw new Error("测试数据会话需要完整且有效的普通用户安全上下文");
    }
    this.prune();
    const sessionId = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(sessionId, {
      ip: input.ip,
      subjectId: securityContext.subjectId,
      securityFingerprint: securityContext.fingerprint,
      browserSessionFingerprint: digest(input.browserSessionId),
      expiresAt,
      profile: {
        environment: "test",
        baseUrl: input.baseUrl,
        userName: input.userName,
        token: input.token,
        cachePartition: digest(sessionId).toString("hex")
      }
    });
    return { sessionId, expiresAt };
  }

  resolve(input: {
    ip: string;
    context: MaintenanceSecurityContext;
    browserSessionId: string;
    cookieHeader: string | undefined;
  }): DataPreviewResolution {
    const sessionId = cookieValue(input.cookieHeader);
    if (!sessionId) return { status: "missing" };
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "invalid" };
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId);
      return { status: "expired" };
    }
    const securityContext = bindSecurityContext(input.context);
    const valid = Boolean(
      securityContext
      && input.browserSessionId
      && session.ip === input.ip
      && session.subjectId === securityContext?.subjectId
      && secureEqual(session.securityFingerprint, securityContext.fingerprint)
      && secureEqual(session.browserSessionFingerprint, digest(input.browserSessionId))
    );
    if (!valid) {
      this.sessions.delete(sessionId);
      return { status: "invalid" };
    }
    return { status: "active", expiresAt: session.expiresAt, profile: session.profile };
  }

  revoke(cookieHeader: string | undefined) {
    const sessionId = cookieValue(cookieHeader);
    if (!sessionId) return false;
    return this.sessions.delete(sessionId);
  }

  revokeSubject(subjectId: string) {
    let revoked = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.subjectId !== subjectId) continue;
      this.sessions.delete(sessionId);
      revoked += 1;
    }
    return revoked;
  }

  sessionCookie(sessionId: string, secure: boolean) {
    return `${PREVIEW_COOKIE}=${sessionId}; Path=/api/bi; Max-Age=${SESSION_TTL_MS / 1000}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
  }

  clearCookie(secure: boolean) {
    return `${PREVIEW_COOKIE}=; Path=/api/bi; Max-Age=0; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict`;
  }
}
