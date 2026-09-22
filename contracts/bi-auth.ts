import { z } from "zod";

export const biRoleSchema = z.enum(["reader", "analyst", "maintainer"]);
export type BiRole = z.infer<typeof biRoleSchema>;

export const biUsernameSchema = z.string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "账号只能包含英文字母、数字、点、下划线和连字符");

export const BI_PASSWORD_MIN_LENGTH = 6;
export const BI_PASSWORD_MAX_LENGTH = 256;

export const biPasswordSchema = z.string()
  .min(BI_PASSWORD_MIN_LENGTH)
  .max(BI_PASSWORD_MAX_LENGTH);

export const biLoginRequestSchema = z.object({
  username: biUsernameSchema,
  password: biPasswordSchema
}).strict();

export const biChangePasswordRequestSchema = z.object({
  currentPassword: biPasswordSchema,
  newPassword: biPasswordSchema
}).strict().refine(
  ({ currentPassword, newPassword }) => currentPassword !== newPassword,
  { path: ["newPassword"], message: "新密码不能与当前密码相同" }
);

export const biPrincipalSchema = z.object({
  subjectId: z.string().uuid(),
  username: biUsernameSchema,
  displayName: z.string().trim().min(1).max(128).optional(),
  role: biRoleSchema,
  permissions: z.array(z.string().min(1).max(128)),
  pidScope: z.literal("all")
}).strict();

export type BiAuthPrincipal = z.infer<typeof biPrincipalSchema>;

export const biSessionDataSchema = z.object({
  user: biPrincipalSchema,
  expiresAt: z.string().datetime({ offset: true }),
  mustChangePassword: z.boolean(),
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export type BiSessionData = z.infer<typeof biSessionDataSchema>;

export const biSessionSuccessSchema = z.object({
  success: z.literal(true),
  data: biSessionDataSchema
}).strict();

export type BiSessionSuccess = z.infer<typeof biSessionSuccessSchema>;

export const biAuthApiErrorCodeSchema = z.enum([
  "INVALID_AUTH_REQUEST",
  "INVALID_CREDENTIALS",
  "AUTHENTICATION_REQUIRED",
  "ORIGIN_VALIDATION_FAILED",
  "CSRF_VALIDATION_FAILED",
  "CURRENT_PASSWORD_INVALID",
  "V2_REQUEST_REJECTED",
  "HTTPS_REQUIRED",
  "AUTH_PROXY_MISCONFIGURED",
  "AUTH_SERVICE_UNAVAILABLE"
]);

export type BiAuthApiErrorCode = z.infer<typeof biAuthApiErrorCodeSchema>;

export const biAuthErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: biAuthApiErrorCodeSchema,
    message: z.string().trim().min(1).max(256),
    requestId: z.string().trim().min(1).max(256)
  }).strict()
}).strict();

export const biLogoutSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ loggedOut: z.literal(true) }).strict()
}).strict();
