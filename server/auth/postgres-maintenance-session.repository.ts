import type { Sql, TransactionSql } from "postgres";
import type { MaintenanceSessionBinding, MaintenanceSessionRepository } from "../security/maintenance-auth";

function activeOrdinarySession(sql: Sql | TransactionSql, now: Date) {
  return sql`
    ordinary_session.revoked_at is null
    and ordinary_session.expires_at > ${now}
    and ordinary_session.credential_version = auth_user.credential_version
    and auth_user.status = 'active'
    and not auth_user.must_change_password
  `;
}

export class PostgresMaintenanceSessionRepository implements MaintenanceSessionRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: MaintenanceSessionBinding & { expiresAt: Date; createdAt: Date }): Promise<boolean> {
    const { tokenHash, ordinaryTokenHash, subjectId, ip, securityFingerprint, keyTag, expiresAt, createdAt } = input;
    return this.sql.begin("isolation level read committed", async (transaction) => {
      // Logout and credential mutations take a conflicting lock on this user.
      // Read the ordinary session again after acquiring it.
      const owner = await transaction<{ user_id: string }[]>`
        select auth_user.user_id
        from bi_auth_sessions ordinary_session
        join bi_auth_users auth_user on auth_user.user_id = ordinary_session.user_id
        where ordinary_session.token_hash = ${ordinaryTokenHash}
          and auth_user.user_id::text = ${subjectId}
        for share of auth_user
      `;
      if (!owner[0]) return false;

      const inserted = await transaction<{ token_hash: string }[]>`
        insert into bi_auth_maintenance_sessions (
          token_hash, ordinary_session_id, bound_ip, security_fingerprint, key_tag, created_at, expires_at
        )
        select ${tokenHash}, ordinary_session.session_id, ${ip}::inet, ${securityFingerprint}, ${keyTag}, ${createdAt}, ${expiresAt}
        from bi_auth_sessions ordinary_session
        join bi_auth_users auth_user on auth_user.user_id = ordinary_session.user_id
        where ordinary_session.token_hash = ${ordinaryTokenHash}
          and auth_user.user_id = ${owner[0].user_id}
          and ${activeOrdinarySession(transaction, createdAt)}
        for key share of ordinary_session
        on conflict (token_hash) do nothing
        returning token_hash
      `;
      return inserted.length === 1;
    });
  }

  async authenticate(input: MaintenanceSessionBinding & { now: Date }): Promise<boolean> {
    const { tokenHash, ordinaryTokenHash, subjectId, ip, securityFingerprint, keyTag, now } = input;
    // Only the owning ordinary session can invalidate a grant on a binding
    // mismatch. A process using a different maintenance key cannot delete it.
    const rows = await this.sql<{ authenticated: boolean }[]>`
      with candidate as materialized (
        select maintenance.token_hash,
          maintenance.bound_ip = ${ip}::inet and maintenance.security_fingerprint = ${securityFingerprint} as binding_matches
        from bi_auth_maintenance_sessions maintenance
        join bi_auth_sessions ordinary_session on ordinary_session.session_id = maintenance.ordinary_session_id
        join bi_auth_users auth_user on auth_user.user_id = ordinary_session.user_id
        where maintenance.token_hash = ${tokenHash}
          and maintenance.key_tag = ${keyTag}
          and maintenance.expires_at > ${now}
          and ordinary_session.token_hash = ${ordinaryTokenHash}
          and auth_user.user_id::text = ${subjectId}
          and ${activeOrdinarySession(this.sql, now)}
      ), invalidated as (
        delete from bi_auth_maintenance_sessions maintenance
        using candidate
        where maintenance.token_hash = candidate.token_hash
          and not candidate.binding_matches
      )
      select exists (select 1 from candidate where binding_matches) as authenticated
    `;
    return rows[0]?.authenticated === true;
  }

  async revoke(tokenHash: string, ordinaryTokenHash: string): Promise<void> {
    await this.sql`
      delete from bi_auth_maintenance_sessions maintenance
      using bi_auth_sessions ordinary_session
      where maintenance.ordinary_session_id = ordinary_session.session_id
        and maintenance.token_hash = ${tokenHash}
        and ordinary_session.token_hash = ${ordinaryTokenHash}
    `;
  }

  async prune(keyTag: string | null, now: Date): Promise<void> {
    await this.sql`
      delete from bi_auth_maintenance_sessions maintenance
      where maintenance.expires_at <= ${now}
        or maintenance.key_tag is distinct from ${keyTag}::char(64)
        or not exists (
          select 1
          from bi_auth_sessions ordinary_session
          join bi_auth_users auth_user on auth_user.user_id = ordinary_session.user_id
          where ordinary_session.session_id = maintenance.ordinary_session_id
            and ${activeOrdinarySession(this.sql, now)}
        )
    `;
  }
}
