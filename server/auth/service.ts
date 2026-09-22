import { randomUUID } from "node:crypto";
import { biPasswordSchema, biRoleSchema, biUsernameSchema, type BiAuthPrincipal, type BiRole } from "../../contracts/bi-auth";
import { z } from "zod";
import {
  hashPassword,
  productionScryptParameters,
  verifyPassword,
  type PasswordKdfGate,
  type ScryptParameters
} from "./password";
import type { AuthRepository, AuthenticatedSessionRecord, AuthUserRecord } from "./repository";
import { principalForUser } from "./roles";
import { createOpaqueToken, deriveCsrfToken, hashOpaqueToken, safeTokenEquals } from "./tokens";

const SESSION_TTL_MS = 12 * 60 * 60_000;
const loginFailurePolicy = { threshold: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 } as const;

export class AuthServiceError extends Error {
  constructor(public readonly code: "INVALID_CREDENTIALS" | "CURRENT_PASSWORD_INVALID" | "SESSION_RACE") {
    super(code);
  }
}

export interface AuthServiceOptions {
  csrfSecret: string | Buffer;
  now?: () => Date;
  sessionTtlMs?: number;
  scryptParameters?: ScryptParameters;
  passwordKdfGate?: PasswordKdfGate;
  dummyPasswordHash?: string;
}

export interface ResolvedAuthSession {
  record: AuthenticatedSessionRecord;
  principal: BiAuthPrincipal;
}

export class BiAuthService {
  private constructor(
    private readonly repository: AuthRepository,
    private readonly now: () => Date,
    private readonly sessionTtlMs: number,
    private readonly scryptParameters: ScryptParameters,
    private readonly passwordKdfGate: PasswordKdfGate | undefined,
    private readonly dummyPasswordHash: string,
    private readonly csrfSecret: string | Buffer
  ) {}

  static async create(repository: AuthRepository, options: AuthServiceOptions) {
    const scryptParameters = options.scryptParameters ?? productionScryptParameters;
    if (Buffer.byteLength(options.csrfSecret) < 32) throw new Error("BI CSRF secret 至少需要 32 字节");
    const dummyPasswordHash = options.dummyPasswordHash ?? await hashPassword(
      "ypbi-dummy-password-never-valid",
      scryptParameters,
      options.passwordKdfGate
    );
    return new BiAuthService(
      repository,
      options.now ?? (() => new Date()),
      options.sessionTtlMs ?? SESSION_TTL_MS,
      scryptParameters,
      options.passwordKdfGate,
      dummyPasswordHash,
      options.csrfSecret
    );
  }

  async login(username: string, password: string) {
    const normalizedUsername = normalizeUsername(username);
    const user = await this.repository.findUserByNormalizedUsername(normalizedUsername);
    const passwordMatches = await verifyPassword(
      password,
      user?.passwordHash ?? this.dummyPasswordHash,
      this.passwordKdfGate
    );
    const now = this.now();
    const locked = Boolean(user?.lockedUntil && user.lockedUntil > now);
    if (!user || user.status !== "active" || locked || !passwordMatches) {
      if (user && user.status === "active" && !locked && !passwordMatches) {
        await this.repository.recordLoginFailure(user.id, now, loginFailurePolicy);
      }
      throw new AuthServiceError("INVALID_CREDENTIALS");
    }
    await this.repository.clearLoginFailures(user.id, now);
    await this.repository.purgeExpiredSessions(now);
    const sessionToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const created = await this.repository.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      credentialVersion: user.credentialVersion,
      createdAt: now,
      expiresAt,
      revokedAt: null
    });
    if (!created) throw new AuthServiceError("SESSION_RACE");
    return {
      principal: principalForUser(user),
      sessionToken,
      csrfToken: deriveCsrfToken(sessionToken, this.csrfSecret),
      mustChangePassword: user.mustChangePassword,
      expiresAt
    };
  }

  async resolveSession(sessionToken: string | null, signal?: AbortSignal): Promise<ResolvedAuthSession | null> {
    if (!sessionToken) return null;
    const record = await this.repository.findAuthenticatedSession(hashOpaqueToken(sessionToken), this.now(), signal);
    return record ? { record, principal: principalForUser(record.user) } : null;
  }

  sessionData(sessionToken: string, session: ResolvedAuthSession) {
    return {
      user: session.principal,
      expiresAt: session.record.session.expiresAt.toISOString(),
      mustChangePassword: session.record.user.mustChangePassword,
      csrfToken: deriveCsrfToken(sessionToken, this.csrfSecret)
    };
  }

  csrfMatches(sessionToken: string, headerToken: string | undefined) {
    if (!headerToken) return false;
    return safeTokenEquals(deriveCsrfToken(sessionToken, this.csrfSecret), headerToken);
  }

  async logout(sessionToken: string | null) {
    if (sessionToken) await this.repository.revokeSession(hashOpaqueToken(sessionToken), this.now());
  }

  async changePassword(session: ResolvedAuthSession, currentPassword: string, newPassword: string) {
    const currentMatches = await verifyPassword(
      currentPassword,
      session.record.user.passwordHash,
      this.passwordKdfGate
    );
    if (!currentMatches) throw new AuthServiceError("CURRENT_PASSWORD_INVALID");
    const newHash = await hashPassword(newPassword, this.scryptParameters, this.passwordKdfGate);
    const now = this.now();
    const sessionToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const replacement = {
      id: randomUUID(),
      userId: session.record.user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      credentialVersion: session.record.user.credentialVersion + 1,
      createdAt: now,
      expiresAt,
      revokedAt: null
    };
    const changed = await this.repository.changePasswordAndReplaceSession(
      session.record.user.id,
      session.record.user.credentialVersion,
      newHash,
      replacement,
      now
    );
    if (!changed) throw new AuthServiceError("SESSION_RACE");
    const updatedUser = {
      ...session.record.user,
      passwordHash: newHash,
      credentialVersion: replacement.credentialVersion,
      mustChangePassword: false,
      updatedAt: now
    };
    return {
      principal: principalForUser(updatedUser),
      sessionToken,
      csrfToken: deriveCsrfToken(sessionToken, this.csrfSecret),
      mustChangePassword: false,
      expiresAt
    };
  }

  sessionTtlSeconds() {
    return Math.floor(this.sessionTtlMs / 1000);
  }
}

export function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("en-US");
}

export interface CreateAccountInput {
  username: string;
  displayName?: string;
  role: BiRole;
  password: string;
}

export interface AccountAdminMutationResult {
  changed: boolean;
  user: AuthUserRecord;
}

export class AccountAdminConflictError extends Error {
  readonly code = "ACCOUNT_CONCURRENT_CHANGE";

  constructor() {
    super("账号已在并发操作中发生变化，请重新执行命令");
  }
}

const createAccountSchema = z.object({
  username: biUsernameSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
  role: biRoleSchema,
  password: biPasswordSchema
}).strict();

export class BiAccountAdminService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly scryptParameters: ScryptParameters = productionScryptParameters,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listAccounts(search: string, page: number) {
    const result = await this.repository.listUsers(search, page);
    return { ...result, items: result.items.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt.toISOString(),
      pidScope: "all" as const
    })), page, pageSize: 20 as const };
  }

  async createAccount(input: CreateAccountInput) {
    const parsed = createAccountSchema.parse(input);
    const normalizedUsername = normalizeUsername(parsed.username);
    return this.repository.createUser({
      id: randomUUID(),
      username: parsed.username.trim(),
      normalizedUsername,
      displayName: parsed.displayName?.trim() || undefined,
      role: parsed.role,
      passwordHash: await hashPassword(parsed.password, this.scryptParameters),
      now: this.now()
    });
  }

  async resetPassword(username: string, newPassword: string) {
    const parsedUsername = biUsernameSchema.parse(username);
    const parsedPassword = biPasswordSchema.parse(newPassword);
    const user = await this.repository.findUserByNormalizedUsername(normalizeUsername(parsedUsername));
    if (!user) return false;
    const passwordHash = await hashPassword(parsedPassword, this.scryptParameters);
    return this.repository.resetPasswordAndRevokeSessions(
      user.id,
      user.credentialVersion,
      passwordHash,
      this.now()
    );
  }

  async disableAccount(username: string, protectLastAdmin = false) {
    const user = await this.findAccount(username);
    if (!user) return null;
    const mutation = await this.repository.setUserStatusAndRevokeSessions(
      user.id,
      user.credentialVersion,
      user.status,
      "disabled",
      this.now(),
      protectLastAdmin
    );
    return this.resolveMutation(mutation);
  }

  async enableAccount(username: string) {
    const user = await this.findAccount(username);
    if (!user) return null;
    const mutation = await this.repository.setUserStatusAndRevokeSessions(
      user.id,
      user.credentialVersion,
      user.status,
      "active",
      this.now()
    );
    return this.resolveMutation(mutation);
  }

  async setAccountRole(username: string, role: BiRole, protectLastAdmin = false) {
    const parsedRole = biRoleSchema.parse(role);
    const user = await this.findAccount(username);
    if (!user) return null;
    const mutation = await this.repository.setUserRoleAndRevokeSessions(
      user.id,
      user.credentialVersion,
      parsedRole,
      this.now(),
      protectLastAdmin
    );
    return this.resolveMutation(mutation);
  }

  private resolveMutation(mutation: Awaited<ReturnType<AuthRepository["setUserRoleAndRevokeSessions"]>>) {
    if (mutation.outcome === "protected") throw new Error("LAST_ADMIN_PROTECTED");
    if (mutation.outcome === "conflict") throw new AccountAdminConflictError();
    if (mutation.outcome === "not_found") return null;
    return {
      changed: mutation.outcome === "changed",
      user: mutation.user
    } satisfies AccountAdminMutationResult;
  }

  private async findAccount(username: string) {
    const parsedUsername = biUsernameSchema.parse(username);
    return this.repository.findUserByNormalizedUsername(normalizeUsername(parsedUsername));
  }
}
