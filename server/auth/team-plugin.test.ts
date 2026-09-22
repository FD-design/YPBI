import { afterEach, expect, test } from 'bun:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryAuthRepository } from './repository';
import { BiAccountAdminService, BiAuthService } from './service';
import { teamAccountPlugin } from './team-plugin';
import { LOCAL_BI_SESSION_COOKIE } from './cookies';

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const params = { N: 1024, r: 8, p: 1, keyLength: 32, saltLength: 16, maxmem: 4 * 1024 * 1024 };
async function fixture(role: 'reader' | 'maintainer' = 'maintainer', forced = false) {
  const repo = new MemoryAuthRepository();
  const accounts = new BiAccountAdminService(repo, params);
  await accounts.createAccount({ username: 'manager', password: 'test-only-initial', role });
  const auth = await BiAuthService.create(repo, { csrfSecret: 'test-only-secret-at-least-32-characters', scryptParameters: params });
  let login = await auth.login('manager', 'test-only-initial');
  if (!forced) login = await auth.changePassword((await auth.resolveSession(login.sessionToken))!, 'test-only-initial', 'test-only-changed');
  const app = Fastify(); apps.push(app);
  await app.register(teamAccountPlugin, { prefix: '/team', authService: auth, accounts, sessionCookie: LOCAL_BI_SESSION_COOKIE, expectedOrigin: 'https://bi.test' });
  const headers = { cookie: `${LOCAL_BI_SESSION_COOKIE.name}=${login.sessionToken}`, origin: 'https://bi.test', 'x-csrf-token': login.csrfToken };
  return { app, headers, accounts, auth, repo };
}
test('anonymous, reader and forced-change accounts cannot list or create accounts', async () => {
  for (const role of ['reader', 'maintainer'] as const) {
    const { app, headers } = await fixture(role, role === 'maintainer');
    expect((await app.inject({ url: '/team' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/team', headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/team', headers, payload: {} })).statusCode).toBe(403);
  }
});
test('admin creates, lists and changes accounts without exposing hashes', async () => {
  const { app, headers } = await fixture();
  const created = await app.inject({ method: 'POST', url: '/team', headers, payload: { username: 'alice', password: 'test-only-alice', role: 'reader' } });
  expect(created.statusCode).toBe(201);
  const list = await app.inject({ url: '/team?search=alice&page=1', headers });
  expect(list.json().data.total).toBe(1);
  expect(list.body).not.toContain('passwordHash');
  expect(list.body).not.toContain('scrypt');
  expect(list.json().data.items[0].mustChangePassword).toBe(true);
  expect((await app.inject({ method: 'POST', url: '/team', headers, payload: { username: 'ALICE', password: 'test-only-alice', role: 'reader' } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'PUT', url: '/team/alice', headers, payload: { action: 'role', role: 'maintainer' } })).statusCode).toBe(200);
});
test('CSRF, origin, self changes and unexpected fields are rejected', async () => {
  const { app, headers } = await fixture();
  const payload = { username: 'alice', password: 'test-only-alice', role: 'reader' };
  expect((await app.inject({ method: 'POST', url: '/team', headers: { ...headers, 'x-csrf-token': 'bad' }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/team', headers: { ...headers, origin: 'https://evil.test' }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/team', headers, payload: { ...payload, permissions: ['all'] } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: '/team/manager', headers, payload: { action: 'status', status: 'disabled' } })).statusCode).toBe(409);
});
test('role changes, disabling and password resets revoke prior sessions', async () => {
  const { app, headers, accounts, auth } = await fixture();
  await accounts.createAccount({ username: 'alice', password: 'test-only-alice', role: 'reader' });
  for (const change of [{ action: 'role', role: 'maintainer' }, { action: 'password', password: 'test-only-alice' }, { action: 'status', status: 'disabled' }]) {
    const login = await auth.login('alice', 'test-only-alice');
    expect((await app.inject({ method: 'PUT', url: '/team/alice', headers, payload: change })).statusCode).toBe(200);
    expect(await auth.resolveSession(login.sessionToken)).toBeNull();
  }
});

test('last active administrator cannot be disabled or downgraded', async () => {
  const { accounts } = await fixture();
  await expect(accounts.disableAccount('manager', true)).rejects.toThrow('LAST_ADMIN_PROTECTED');
  await expect(accounts.setAccountRole('manager', 'reader', true)).rejects.toThrow('LAST_ADMIN_PROTECTED');
  await accounts.createAccount({ username: 'otheradmin', password: 'test-only-other', role: 'maintainer' });
  expect((await accounts.disableAccount('manager', true))?.changed).toBe(true);
  await expect(accounts.setAccountRole('otheradmin', 'reader', true)).rejects.toThrow('LAST_ADMIN_PROTECTED');
});

test('list is bounded, searches literal input and validates query', async () => {
  const { app, headers, accounts } = await fixture();
  for (let i = 0; i < 22; i++) await accounts.createAccount({ username: `member${i}`, password: 'test-only-member', role: 'reader' });
  const first = await app.inject({ url: '/team?search=member', headers });
  expect(first.json().data.items.length).toBe(20);
  expect(first.json().data.total).toBe(22);
  expect((await app.inject({ url: '/team?search=member&page=2', headers })).json().data.items.length).toBe(2);
  expect((await app.inject({ url: '/team?page=-1', headers })).statusCode).toBe(400);
  expect((await app.inject({ url: '/team?search=%25', headers })).json().data.total).toBe(0);
});

test('admin mutation rate is bounded before password work', async () => {
  const { app, headers } = await fixture();
  for (let i = 0; i < 12; i++) await app.inject({ method: 'POST', url: '/team', headers, payload: {} });
  expect((await app.inject({ method: 'POST', url: '/team', headers, payload: {} })).statusCode).toBe(429);
});
