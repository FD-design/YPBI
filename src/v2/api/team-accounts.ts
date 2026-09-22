import { z } from 'zod';
import { teamListSchema, teamWriteSchema } from '../../../contracts/team-accounts';
import { notifyAuthenticationRequired } from './authEvents';

export async function teamRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/bi/v2/team/accounts${path}`, {
    ...init, credentials: 'same-origin', cache: 'no-store',
    signal: init.signal ?? AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...init.headers }
  });
  if (response.status === 401) notifyAuthenticationRequired();
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.object({ message: z.string().max(256) }) }).safeParse(body);
    throw new Error(failure.success ? failure.data.error.message : '账号服务暂时不可用');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new Error('账号服务返回格式异常');
  return result.data;
}
export { teamListSchema, teamWriteSchema };
