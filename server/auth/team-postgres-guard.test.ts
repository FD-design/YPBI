import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { PostgresAuthRepository } from './postgres-auth.repository';

test('team last-admin guard locks before row lookup and refuses removal in PostgreSQL', async () => {
  for (const action of ['role', 'status']) {
    const calls: string[] = [];
    const row = { user_id: 'id', username: 'manager', normalized_username: 'manager', display_name: null,
      role: 'maintainer', password_hash: 'not-exposed', credential_version: 1, must_change_password: false,
      status: 'active', failed_login_count: 0, failed_login_window_started_at: null, locked_until: null,
      created_at: new Date(), updated_at: new Date() };
    const transaction = Object.assign(async (parts: TemplateStringsArray) => {
      const query = parts.join('?'); calls.push(query);
      return query.includes('count(*)') ? [{ total: 1 }] : [];
    }, { unsafe: async (query: string) => { calls.push(query); return [row]; } });
    const sql = { begin: (run: (value: unknown) => unknown) => run(transaction) } as unknown as Sql;
    const repository = new PostgresAuthRepository(sql);
    const result = action === 'role'
      ? await repository.setUserRoleAndRevokeSessions('id', 1, 'reader', new Date(), true)
      : await repository.setUserStatusAndRevokeSessions('id', 1, 'active', 'disabled', new Date(), true);
    expect(result).toEqual({ outcome: 'protected' });
    expect(calls[0]).toContain('pg_advisory_xact_lock');
    expect(calls[1]).toContain('for update');
    expect(calls.some(call => call.includes('update bi_auth_users'))).toBe(false);
  }
});
