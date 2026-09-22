import type { Sql } from "postgres";
import { biRoleSchema, type BiRole } from "../../contracts/bi-auth";
import type {
  AuthRepository,
  AuthSessionRecord,
  AuthUserMutationResult,
  AuthUserRecord,
  AuthUserStatus,
  AuthenticatedSessionRecord,
  LoginFailurePolicy,
  NewAuthUserRecord
} from "./repository";

interface UserRow {
  user_id: string;
  username: string;
  normalized_username: string;
  display_name: string | null;
  role: string;
  password_hash: string;
  credential_version: number;
  must_change_password: boolean;
  status: string;
  failed_login_count: number;
  failed_login_window_started_at: Date | null;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  token_hash: string;
  credential_version: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function roleFromDatabase(value: string): BiRole {
  const parsed = biRoleSchema.safeParse(value);
  if (!parsed.success) throw new Error("数据库包含未知 BI 角色，身份解析已停止");
  return parsed.data;
}

function statusFromDatabase(value: string): AuthUserStatus {
  if (value !== "active" && value !== "disabled") throw new Error("数据库包含未知账号状态，身份解析已停止");
  return value;
}

function mapUser(row: UserRow): AuthUserRecord {
  return {
    id: row.user_id,
    username: row.username,
    normalizedUsername: row.normalized_username,
    displayName: row.display_name ?? undefined,
    role: roleFromDatabase(row.role),
    passwordHash: row.password_hash,
    credentialVersion: row.credential_version,
    mustChangePassword: row.must_change_password,
    status: statusFromDatabase(row.status),
    failedLoginCount: row.failed_login_count,
    failedLoginWindowStartedAt: row.failed_login_window_started_at,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSession(row: SessionRow): AuthSessionRecord {
  return {
    id: row.session_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    credentialVersion: row.credential_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

const userColumns = `
  user_id, username, normalized_username, display_name, role, password_hash,
  credential_version, must_change_password, status, failed_login_count, failed_login_window_started_at,
  locked_until, created_at, updated_at
`;

async function queryWithAbort<T>(
  query: PromiseLike<T> & { cancel(): void },
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return await query;
  const cancel = () => {
    void Promise.resolve(query.cancel() as unknown).catch(() => undefined);
  };
  if (signal.aborted) {
    cancel();
    return await query;
  }
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await query;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly sql: Sql) {}

  async listUsers(search: string, page: number) {
    const filter = search.toLowerCase();
    const rows = await this.sql.unsafe<UserRow[]>(`select ${userColumns} from bi_auth_users
      where position($1 in lower(username || ' ' || coalesce(display_name, ''))) > 0
      order by created_at desc, username asc limit 20 offset $2`, [filter, (page - 1) * 20]);
    const count = await this.sql`select count(*)::int as total from bi_auth_users
      where position(${filter} in lower(username || ' ' || coalesce(display_name, ''))) > 0`;
    return { items: rows.map(mapUser), total: Number(count[0].total) };
  }

  async findUserByNormalizedUsername(normalizedUsername: string) {
    const rows = await this.sql.unsafe<UserRow[]>(
      `select ${userColumns} from bi_auth_users where normalized_username = $1`,
      [normalizedUsername]
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createUser(input: NewAuthUserRecord) {
    const rows = await this.sql.unsafe<UserRow[]>(
      `insert into bi_auth_users (
        user_id, username, normalized_username, display_name, role, password_hash, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $7)
      returning ${userColumns}`,
      [input.id, input.username, input.normalizedUsername, input.displayName ?? null, input.role, input.passwordHash, input.now]
    );
    return mapUser(rows[0]);
  }

  async recordLoginFailure(userId: string, now: Date, policy: LoginFailurePolicy) {
    const windowStart = new Date(now.getTime() - policy.windowMs);
    const lockedUntil = new Date(now.getTime() + policy.lockMs);
    await this.sql`
      update bi_auth_users
      set
        failed_login_count = case
          when failed_login_window_started_at is null or failed_login_window_started_at <= ${windowStart}
            then 1
          else least(32767, failed_login_count + 1)
        end,
        failed_login_window_started_at = case
          when failed_login_window_started_at is null or failed_login_window_started_at <= ${windowStart}
            then ${now}
          else failed_login_window_started_at
        end,
        locked_until = case
          when (case
            when failed_login_window_started_at is null or failed_login_window_started_at <= ${windowStart}
              then 1
            else failed_login_count + 1
          end) >= ${policy.threshold}
            then ${lockedUntil}
          else locked_until
        end,
        updated_at = ${now}
      where user_id = ${userId}
    `;
  }

  async clearLoginFailures(userId: string, now: Date) {
    await this.sql`
      update bi_auth_users
      set failed_login_count = 0,
          failed_login_window_started_at = null,
          locked_until = null,
          updated_at = ${now}
      where user_id = ${userId}
    `;
  }

  async createSession(session: AuthSessionRecord) {
    const rows = await this.sql<{ session_id: string }[]>`
      insert into bi_auth_sessions (
        session_id, user_id, token_hash, credential_version, created_at, expires_at
      )
      select ${session.id}, user_id, ${session.tokenHash}, credential_version,
             ${session.createdAt}, ${session.expiresAt}
      from bi_auth_users
      where user_id = ${session.userId}
        and status = 'active'
        and credential_version = ${session.credentialVersion}
      returning session_id
    `;
    return rows.length === 1;
  }

  async findAuthenticatedSession(tokenHash: string, now: Date, signal?: AbortSignal): Promise<AuthenticatedSessionRecord | null> {
    if (signal?.aborted) throw new Error("auth_query_aborted");
    const rows = await queryWithAbort(this.sql.unsafe<(SessionRow & UserRow)[]>(
      `select
        s.session_id, s.user_id, s.token_hash,
        s.credential_version, s.created_at, s.expires_at, s.revoked_at,
        u.username, u.normalized_username, u.display_name, u.role, u.password_hash,
        u.must_change_password, u.status, u.failed_login_count, u.failed_login_window_started_at,
        u.locked_until, u.created_at as user_created_at, u.updated_at
      from bi_auth_sessions s
      join bi_auth_users u on u.user_id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > $2
        and u.status = 'active'
        and u.credential_version = s.credential_version`,
      [tokenHash, now]
    ), signal);
    const row = rows[0];
    if (!row) return null;
    const userRow: UserRow = {
      ...row,
      created_at: Reflect.get(row, "user_created_at") as Date
    };
    return { session: mapSession(row), user: mapUser(userRow) };
  }

  async revokeSession(tokenHash: string, now: Date) {
    await this.sql`
      update bi_auth_sessions
      set revoked_at = coalesce(revoked_at, ${now})
      where token_hash = ${tokenHash}
    `;
  }

  async resetPasswordAndRevokeSessions(userId: string, expectedCredentialVersion: number, passwordHash: string, now: Date) {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<{ credential_version: number }[]>`
        update bi_auth_users
        set password_hash = ${passwordHash},
            credential_version = credential_version + 1,
            must_change_password = true,
            failed_login_count = 0,
            failed_login_window_started_at = null,
            locked_until = null,
            updated_at = ${now}
        where user_id = ${userId}
          and credential_version = ${expectedCredentialVersion}
        returning credential_version
      `;
      if (rows.length !== 1) return false;
      await transaction`
        update bi_auth_sessions
        set revoked_at = coalesce(revoked_at, ${now})
        where user_id = ${userId}
      `;
      return true;
    });
  }

  async changePasswordAndReplaceSession(
    userId: string,
    expectedCredentialVersion: number,
    passwordHash: string,
    replacement: AuthSessionRecord,
    now: Date
  ) {
    if (replacement.userId !== userId || replacement.credentialVersion !== expectedCredentialVersion + 1) return false;
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<{ credential_version: number }[]>`
        update bi_auth_users
        set password_hash = ${passwordHash},
            credential_version = credential_version + 1,
            must_change_password = false,
            failed_login_count = 0,
            failed_login_window_started_at = null,
            locked_until = null,
            updated_at = ${now}
        where user_id = ${userId}
          and status = 'active'
          and credential_version = ${expectedCredentialVersion}
        returning credential_version
      `;
      if (rows.length !== 1) return false;
      await transaction`
        update bi_auth_sessions
        set revoked_at = coalesce(revoked_at, ${now})
        where user_id = ${userId}
      `;
      await transaction`
        insert into bi_auth_sessions (
          session_id, user_id, token_hash, credential_version, created_at, expires_at
        ) values (
          ${replacement.id}, ${replacement.userId}, ${replacement.tokenHash},
          ${replacement.credentialVersion}, ${replacement.createdAt}, ${replacement.expiresAt}
        )
      `;
      return true;
    });
  }

  async setUserRoleAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    role: BiRole,
    now: Date,
    protectLastAdmin = false
  ) {
    return this.sql.begin(async (transaction) => {
      if (protectLastAdmin) await transaction`select pg_advisory_xact_lock(724916)`;
      const currentRows = await transaction.unsafe<UserRow[]>(
        `select ${userColumns}
         from bi_auth_users
         where user_id = $1
         for update`,
        [userId]
      );
      if (!currentRows[0]) return { outcome: "not_found" } satisfies AuthUserMutationResult;
      const current = mapUser(currentRows[0]);
      if (current.credentialVersion !== expectedCredentialVersion) {
        return { outcome: "conflict" } satisfies AuthUserMutationResult;
      }
      if (current.role === role) {
        return { outcome: "no_change", user: current } satisfies AuthUserMutationResult;
      }
      if (protectLastAdmin && current.role === "maintainer" && current.status === "active" && role !== "maintainer") {
        const count = await transaction`select count(*)::int as total from bi_auth_users where role = 'maintainer' and status = 'active'`;
        if (Number(count[0].total) <= 1) return { outcome: "protected" } satisfies AuthUserMutationResult;
      }
      const rows = await transaction.unsafe<UserRow[]>(
        `update bi_auth_users
         set role = $1,
             credential_version = credential_version + 1,
             updated_at = $2
         where user_id = $3
           and credential_version = $4
         returning ${userColumns}`,
        [role, now, userId, expectedCredentialVersion]
      );
      if (!rows[0]) return { outcome: "conflict" } satisfies AuthUserMutationResult;
      await transaction`
        update bi_auth_sessions
        set revoked_at = coalesce(revoked_at, ${now})
        where user_id = ${userId}
      `;
      return { outcome: "changed", user: mapUser(rows[0]) } satisfies AuthUserMutationResult;
    });
  }

  async setUserStatusAndRevokeSessions(
    userId: string,
    expectedCredentialVersion: number,
    expectedStatus: AuthUserStatus,
    status: AuthUserStatus,
    now: Date,
    protectLastAdmin = false
  ) {
    return this.sql.begin(async (transaction) => {
      if (protectLastAdmin) await transaction`select pg_advisory_xact_lock(724916)`;
      const currentRows = await transaction.unsafe<UserRow[]>(
        `select ${userColumns}
         from bi_auth_users
         where user_id = $1
         for update`,
        [userId]
      );
      if (!currentRows[0]) return { outcome: "not_found" } satisfies AuthUserMutationResult;
      const current = mapUser(currentRows[0]);
      if (
        current.credentialVersion !== expectedCredentialVersion
        || current.status !== expectedStatus
      ) {
        return { outcome: "conflict" } satisfies AuthUserMutationResult;
      }
      if (current.status === status) {
        return { outcome: "no_change", user: current } satisfies AuthUserMutationResult;
      }
      if (protectLastAdmin && current.role === "maintainer" && current.status === "active" && status === "disabled") {
        const count = await transaction`select count(*)::int as total from bi_auth_users where role = 'maintainer' and status = 'active'`;
        if (Number(count[0].total) <= 1) return { outcome: "protected" } satisfies AuthUserMutationResult;
      }
      const rows = await transaction.unsafe<UserRow[]>(
        `update bi_auth_users
         set status = $1::varchar,
             credential_version = credential_version + 1,
             failed_login_count = case when $1::varchar = 'active' then 0 else failed_login_count end,
             failed_login_window_started_at = case when $1::varchar = 'active' then null else failed_login_window_started_at end,
             locked_until = case when $1::varchar = 'active' then null else locked_until end,
             updated_at = $2
         where user_id = $3
           and credential_version = $4
           and status = $5
         returning ${userColumns}`,
        [status, now, userId, expectedCredentialVersion, expectedStatus]
      );
      if (!rows[0]) return { outcome: "conflict" } satisfies AuthUserMutationResult;
      await transaction`
        update bi_auth_sessions
        set revoked_at = coalesce(revoked_at, ${now})
        where user_id = ${userId}
      `;
      return { outcome: "changed", user: mapUser(rows[0]) } satisfies AuthUserMutationResult;
    });
  }

  async purgeExpiredSessions(now: Date) {
    const revokedRetention = new Date(now.getTime() - 7 * 86_400_000);
    await this.sql`
      delete from bi_auth_sessions
      where expires_at <= ${now}
         or (revoked_at is not null and revoked_at <= ${revokedRetention})
    `;
  }
}
