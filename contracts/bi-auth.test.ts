import { describe, expect, test } from "bun:test";
import {
  BI_PASSWORD_MAX_LENGTH,
  BI_PASSWORD_MIN_LENGTH,
  biChangePasswordRequestSchema,
  biLoginRequestSchema
} from "./bi-auth";

describe("BI auth password contract", () => {
  test("普通账号统一接受 6～256 位密码", () => {
    expect(BI_PASSWORD_MIN_LENGTH).toBe(6);
    expect(BI_PASSWORD_MAX_LENGTH).toBe(256);
    expect(biLoginRequestSchema.safeParse({ username: "adi", password: "adi123" }).success).toBe(true);
    expect(biLoginRequestSchema.safeParse({ username: "adi", password: "adi12" }).success).toBe(false);
    expect(biLoginRequestSchema.safeParse({ username: "adi", password: "a".repeat(257) }).success).toBe(false);
  });

  test("改密继续禁止新旧密码相同", () => {
    expect(biChangePasswordRequestSchema.safeParse({
      currentPassword: "adi123",
      newPassword: "adi123"
    }).success).toBe(false);
  });
});
