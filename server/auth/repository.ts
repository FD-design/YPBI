import type { BiRole } from "../../contracts/bi-auth";

export type AuthUserStatus = "active" | "disabled";

export interface AuthUserRecord {
  id: string;
  username: string;
  normalizedUsername: string;
  displayName?: string;
  role: BiRole;
  passwordHash: string;
  credentialVersion: number;
  mustChangePassword: boolean;
  status: AuthUserStatus;
  failedLoginCount: number;
  failedLoginWindowStartedAt: Date | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  credentialVersion: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AuthenticatedSessionRecord {
  session: AuthSessionRecord;
  user: AuthUserRecord;
}

export interface LoginFailurePolicy {
  threshold: number;
  windowMs: number;
  lockMs: number;
}

export interface NewAuthUserRecord {
  id: string;
  username: string;
  normalizedUsername: string;
  displayName?: string;
  role: BiRole;
  passwordHash: string;
  now: Date;
}

export type AuthUserMutationResult =
  | { outcome: "changed"; user: AuthUserRecord }
  | { outcome: "no_change"; user: AuthUserRecord }
  | { outcome: "conflict" }
  | { outcome: "not_found" };

export interface AuthRepository {
  findUserByNormalizedUsername(normalizedUsername: string): Promise<AuthUserRecord | null>;
  createUser(user: NewAuthUserRecord): Promise<AuthUserRecord>;
  recordLoginFailure(userId: string, now: Date, policy: LoginFailurePolicy): Promise<void>;
  clearLoginFailures(userId: string, now: Date): Promise<void>;
  createSession(session: AuthSessionRecord): Promise<boolean>;
  findAuthenticatedSession(tokenHash: string, now: Date, signal?: AbortSignal): Promise<AuthenticatedSessionRecord | null>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
  resetPasswordAndRevokeSessions(userId: string, expectedCredentialVersion: number, passwordHash: string, now: Date): Promise<boolean>;
  changePasswordAndReplaceSession(
    userId: string,
    expectedCredentialVersion: number,
    passwordHash: string,
    replacement: AuthSessionRecord,
    now: Date
  ): Promise<boolean>;
  setUserRoleAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    role: BiRole,
    now: Date
  ): Promise<AuthUserMutationResult>;
  setUserStatusAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    expectedStatus: AuthUserStatus,
    status: AuthUserStatus,
    now: Date
  ): Promise<AuthUserMutationResult>;
  purgeExpiredSessions(now: Date): Promise<void>;
}

function cloneUser(user: AuthUserRecord): AuthUserRecord {
  return {
    ...user,
    failedLoginWindowStartedAt: user.failedLoginWindowStartedAt ? new Date(user.failedLoginWindowStartedAt) : null,
    lockedUntil: user.lockedUntil ? new Date(user.lockedUntil) : null,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt)
  };
}

function cloneSession(session: AuthSessionRecord): AuthSessionRecord {
  return {
    ...session,
    createdAt: new Date(session.createdAt),
    expiresAt: new Date(session.expiresAt),
    revokedAt: session.revokedAt ? new Date(session.revokedAt) : null
  };
}

export class MemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly userIdByName = new Map<string, string>();
  private readonly sessions = new Map<string, AuthSessionRecord>();

  async findUserByNormalizedUsername(normalizedUsername: string) {
    const id = this.userIdByName.get(normalizedUsername);
    const user = id ? this.users.get(id) : undefined;
    return user ? cloneUser(user) : null;
  }

  async createUser(input: NewAuthUserRecord) {
    if (this.userIdByName.has(input.normalizedUsername)) throw new Error("AUTH_USERNAME_CONFLICT");
    const user: AuthUserRecord = {
      id: input.id,
      username: input.username,
      normalizedUsername: input.normalizedUsername,
      displayName: input.displayName,
      role: input.role,
      passwordHash: input.passwordHash,
      credentialVersion: 1,
      mustChangePassword: true,
      status: "active",
      failedLoginCount: 0,
      failedLoginWindowStartedAt: null,
      lockedUntil: null,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now)
    };
    this.users.set(user.id, user);
    this.userIdByName.set(user.normalizedUsername, user.id);
    return cloneUser(user);
  }

  async recordLoginFailure(userId: string, now: Date, policy: LoginFailurePolicy) {
    const user = this.users.get(userId);
    if (!user) return;
    const currentWindow = user.failedLoginWindowStartedAt
      && user.failedLoginWindowStartedAt.getTime() + policy.windowMs > now.getTime();
    user.failedLoginCount = currentWindow ? user.failedLoginCount + 1 : 1;
    user.failedLoginWindowStartedAt = currentWindow ? user.failedLoginWindowStartedAt : new Date(now);
    if (user.failedLoginCount >= policy.threshold) user.lockedUntil = new Date(now.getTime() + policy.lockMs);
    user.updatedAt = new Date(now);
  }

  async clearLoginFailures(userId: string, now: Date) {
    const user = this.users.get(userId);
    if (!user) return;
    user.failedLoginCount = 0;
    user.failedLoginWindowStartedAt = null;
    user.lockedUntil = null;
    user.updatedAt = new Date(now);
  }

  async createSession(session: AuthSessionRecord) {
    const user = this.users.get(session.userId);
    if (!user || user.status !== "active" || user.credentialVersion !== session.credentialVersion) return false;
    this.sessions.set(session.tokenHash, cloneSession(session));
    return true;
  }

  async findAuthenticatedSession(tokenHash: string, now: Date, signal?: AbortSignal) {
    if (signal?.aborted) throw new Error("auth_query_aborted");
    const session = this.sessions.get(tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    const user = this.users.get(session.userId);
    if (!user || user.status !== "active" || user.credentialVersion !== session.credentialVersion) return null;
    return { session: cloneSession(session), user: cloneUser(user) };
  }

  async revokeSession(tokenHash: string, now: Date) {
    const session = this.sessions.get(tokenHash);
    if (session && !session.revokedAt) session.revokedAt = new Date(now);
  }

  async resetPasswordAndRevokeSessions(userId: string, expectedCredentialVersion: number, passwordHash: string, now: Date) {
    const user = this.users.get(userId);
    if (!user || user.credentialVersion !== expectedCredentialVersion) return false;
    user.passwordHash = passwordHash;
    user.credentialVersion += 1;
    user.mustChangePassword = true;
    user.failedLoginCount = 0;
    user.failedLoginWindowStartedAt = null;
    user.lockedUntil = null;
    user.updatedAt = new Date(now);
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date(now);
    }
    return true;
  }

  async changePasswordAndReplaceSession(
    userId: string,
    expectedCredentialVersion: number,
    passwordHash: string,
    replacement: AuthSessionRecord,
    now: Date
  ) {
    const user = this.users.get(userId);
    if (!user || user.status !== "active" || user.credentialVersion !== expectedCredentialVersion) return false;
    if (replacement.userId !== userId || replacement.credentialVersion !== expectedCredentialVersion + 1) return false;
    user.passwordHash = passwordHash;
    user.credentialVersion += 1;
    user.mustChangePassword = false;
    user.failedLoginCount = 0;
    user.failedLoginWindowStartedAt = null;
    user.lockedUntil = null;
    user.updatedAt = new Date(now);
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date(now);
    }
    this.sessions.set(replacement.tokenHash, cloneSession(replacement));
    return true;
  }

  async setUserRoleAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    role: BiRole,
    now: Date
  ) {
    const user = this.users.get(userId);
    if (!user) return { outcome: "not_found" } as const;
    if (user.credentialVersion !== expectedCredentialVersion) return { outcome: "conflict" } as const;
    if (user.role === role) return { outcome: "no_change", user: cloneUser(user) } as const;
    user.role = role;
    user.credentialVersion += 1;
    user.updatedAt = new Date(now);
    this.revokeUserSessions(userId, now);
    return { outcome: "changed", user: cloneUser(user) } as const;
  }

  async setUserStatusAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    expectedStatus: AuthUserStatus,
    status: AuthUserStatus,
    now: Date
  ) {
    const user = this.users.get(userId);
    if (!user) return { outcome: "not_found" } as const;
    if (user.credentialVersion !== expectedCredentialVersion || user.status !== expectedStatus) {
      return { outcome: "conflict" } as const;
    }
    if (user.status === status) return { outcome: "no_change", user: cloneUser(user) } as const;
    user.status = status;
    user.credentialVersion += 1;
    if (status === "active") {
      user.failedLoginCount = 0;
      user.failedLoginWindowStartedAt = null;
      user.lockedUntil = null;
    }
    user.updatedAt = new Date(now);
    this.revokeUserSessions(userId, now);
    return { outcome: "changed", user: cloneUser(user) } as const;
  }

  private revokeUserSessions(userId: string, now: Date) {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = new Date(now);
    }
  }

  async purgeExpiredSessions(now: Date) {
    for (const [tokenHash, session] of this.sessions) {
      if (session.expiresAt <= now || (session.revokedAt && session.revokedAt.getTime() + 7 * 86_400_000 <= now.getTime())) {
        this.sessions.delete(tokenHash);
      }
    }
  }
}
