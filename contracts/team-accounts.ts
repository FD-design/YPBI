import { z } from 'zod';
import { biPasswordSchema, biRoleSchema, biUsernameSchema } from './bi-auth';

export const teamRoleSchema = z.enum(['reader', 'maintainer']);
export const teamCreateSchema = z.object({
  username: biUsernameSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
  password: biPasswordSchema,
  role: teamRoleSchema
}).strict();
export const teamChangeSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('role'), role: teamRoleSchema }).strict(),
  z.object({ action: z.literal('status'), status: z.enum(['active', 'disabled']) }).strict(),
  z.object({ action: z.literal('password'), password: biPasswordSchema }).strict()
]);
export const teamQuerySchema = z.object({
  search: z.string().trim().max(128).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1)
}).strict();
export const teamAccountSchema = z.object({
  id: z.string().uuid(), username: biUsernameSchema, displayName: z.string().optional(),
  role: biRoleSchema, status: z.enum(['active', 'disabled']), mustChangePassword: z.boolean(),
  createdAt: z.string().datetime(), pidScope: z.literal('all')
}).strict();
export type TeamAccount = z.infer<typeof teamAccountSchema>;
export const teamListSchema = z.object({ success: z.literal(true), data: z.object({
  items: z.array(teamAccountSchema), total: z.number().int().nonnegative(), page: z.number(), pageSize: z.literal(20)
}) });
export const teamWriteSchema = z.object({ success: z.literal(true), data: z.object({ saved: z.literal(true) }) });
