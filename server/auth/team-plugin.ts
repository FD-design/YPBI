import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { biUsernameSchema } from '../../contracts/bi-auth';
import { teamChangeSchema, teamCreateSchema, teamQuerySchema } from '../../contracts/team-accounts';
import { resolveSessionCookieConfiguration, type BiSessionCookieConfiguration } from './cookies';
import { authenticatedSession } from './plugin';
import { AccountAdminConflictError, type BiAccountAdminService, type BiAuthService, type ResolvedAuthSession } from './service';

interface Options {
  authService: BiAuthService;
  accounts: BiAccountAdminService;
  sessionCookie?: BiSessionCookieConfiguration;
  expectedOrigin?: string;
}
function fail(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ success: false, error: { code, message, requestId: request.id } });
}
export const teamAccountPlugin: FastifyPluginAsync<Options> = async (app, options) => {
  const cookie = resolveSessionCookieConfiguration(options.sessionCookie);
  const principals = new WeakMap<FastifyRequest, ResolvedAuthSession>();
  const attempts = new Map<string, { until: number; count: number }>();
  app.addHook('preHandler', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { token, session } = await authenticatedSession(request, reply, options.authService, cookie.name, 3000);
    if (!session) return fail(request, reply, 401, 'AUTHENTICATION_REQUIRED', '请先登录');
    if (session.principal.role !== 'maintainer' || session.record.user.mustChangePassword) {
      return fail(request, reply, 403, 'TEAM_ACCESS_DENIED', '仅管理员可管理团队账号');
    }
    if (request.method !== 'GET') {
      if (options.expectedOrigin && request.headers.origin !== options.expectedOrigin) return fail(request, reply, 403, 'ORIGIN_VALIDATION_FAILED', '请求来源校验失败');
      const csrf = request.headers['x-csrf-token'];
      if (!token || typeof csrf !== 'string' || !options.authService.csrfMatches(token, csrf)) return fail(request, reply, 403, 'CSRF_VALIDATION_FAILED', '安全校验失败，请刷新后重试');
      const now = Date.now();
      for (const [id, entry] of attempts) if (entry.until <= now) attempts.delete(id);
      const id = session.principal.subjectId;
      const entry = attempts.get(id) ?? { until: now + 60_000, count: 0 };
      if (entry.count >= 12 || (!attempts.has(id) && attempts.size >= 1000)) {
        reply.header('retry-after', '60');
        return fail(request, reply, 429, 'TEAM_RATE_LIMITED', '操作较频繁，请稍后重试');
      }
      attempts.set(id, { ...entry, count: entry.count + 1 });
    }
    principals.set(request, session);
  });
  app.setErrorHandler((error, request, reply) => {
    const code = (error as { code?: string }).code;
    if (code?.startsWith('FST_ERR_CTP')) return fail(request, reply, 400, 'INVALID_TEAM_REQUEST', '请求格式不合法');
    if (code === '23505' || (error instanceof Error && error.message === 'AUTH_USERNAME_CONFLICT')) return fail(request, reply, 409, 'USERNAME_EXISTS', '账号已存在');
    if (error instanceof AccountAdminConflictError) return fail(request, reply, 409, 'ACCOUNT_CONCURRENT_CHANGE', '账号已被修改，请刷新后重试');
    if (error instanceof Error && error.message === 'LAST_ADMIN_PROTECTED') return fail(request, reply, 409, 'LAST_ADMIN_PROTECTED', '至少保留一个可用管理员');
    request.log.error({ requestId: request.id, outcome: 'team_operation_failed' }, 'Team account operation failed');
    return fail(request, reply, 503, 'TEAM_SERVICE_UNAVAILABLE', '账号操作暂未完成，请刷新核对后重试');
  });
  app.get('', async (request, reply) => {
    const query = teamQuerySchema.safeParse(request.query);
    if (!query.success) return fail(request, reply, 400, 'INVALID_TEAM_REQUEST', '筛选参数不合法');
    return { success: true, data: await options.accounts.listAccounts(query.data.search, query.data.page) };
  });
  app.post('', async (request, reply) => {
    const input = teamCreateSchema.safeParse(request.body);
    if (!input.success) return fail(request, reply, 400, 'INVALID_TEAM_REQUEST', '账号、密码或角色格式不合法');
    const user = await options.accounts.createAccount(input.data);
    request.log.info({ actorId: principals.get(request)!.principal.subjectId, targetId: user.id, action: 'team_account_created' }, 'Team account changed');
    return reply.code(201).send({ success: true, data: { saved: true } });
  });
  app.put('/:username', async (request, reply) => {
    const username = biUsernameSchema.safeParse((request.params as { username?: string }).username);
    const input = teamChangeSchema.safeParse(request.body);
    if (!username.success || !input.success) return fail(request, reply, 400, 'INVALID_TEAM_REQUEST', '账号操作参数不合法');
    const actor = principals.get(request)!.principal;
    if (username.data.toLowerCase() === actor.username.toLowerCase()) return fail(request, reply, 409, 'SELF_ACCOUNT_PROTECTED', '不能在此修改自己的账号，请使用个人菜单修改密码');
    const change = input.data;
    const result = change.action === 'role' ? await options.accounts.setAccountRole(username.data, change.role, true)
      : change.action === 'password' ? await options.accounts.resetPassword(username.data, change.password)
      : change.status === 'disabled' ? await options.accounts.disableAccount(username.data, true)
      : await options.accounts.enableAccount(username.data);
    if (!result) return fail(request, reply, 404, 'ACCOUNT_NOT_FOUND', '账号不存在或已发生变化，请刷新');
    request.log.info({ actorId: actor.subjectId, targetUsername: username.data, action: `team_${change.action}` }, 'Team account changed');
    return { success: true, data: { saved: true } };
  });
};
