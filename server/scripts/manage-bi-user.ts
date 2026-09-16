import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  BI_PASSWORD_MAX_LENGTH,
  BI_PASSWORD_MIN_LENGTH,
  biRoleSchema,
  biUsernameSchema
} from "../../contracts/bi-auth";
import { createAuthMaintenanceDatabase } from "../auth/database";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository";
import { BiAccountAdminService } from "../auth/service";
import { runAuthMigrations } from "../persistence/migrations/runner";

function argument(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function rejectsPasswordArgument() {
  return process.argv.some((value) => value === "--password" || value.startsWith("--password="));
}

async function hiddenPassword(prompt: string) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("密码操作必须在交互式终端执行，不能通过参数、环境变量或管道传入密码");
  }
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("操作已取消"));
        if (character === "\r" || character === "\n") {
          stdout.write("\n");
          return finish();
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (value.length < 256 && character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  }).finally(() => {
    if (stdin.isTTY && typeof stdin.setRawMode === "function") stdin.setRawMode(false);
    stdin.pause();
  });
}

async function confirmedPassword() {
  const first = await hiddenPassword(`请输入新密码（${BI_PASSWORD_MIN_LENGTH}～${BI_PASSWORD_MAX_LENGTH} 个字符，不会回显）: `);
  const second = await hiddenPassword("请再次输入新密码: ");
  if (first !== second) throw new Error("两次输入的密码不一致");
  if (first.length < BI_PASSWORD_MIN_LENGTH || first.length > BI_PASSWORD_MAX_LENGTH) {
    throw new Error(`密码长度必须为 ${BI_PASSWORD_MIN_LENGTH}～${BI_PASSWORD_MAX_LENGTH} 个字符`);
  }
  return first;
}

async function confirmExact(prompt: string, expected: string, cancelledMessage: string) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("账号状态与角色操作必须在交互式终端执行，不能通过管道自动确认");
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const confirmation = await readline.question(prompt);
    if (confirmation !== expected) throw new Error(cancelledMessage);
  } finally {
    readline.close();
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || !["create", "reset-password", "disable", "enable", "set-role"].includes(command)) {
    throw new Error("用法: bun server/scripts/manage-bi-user.ts <create|reset-password|disable|enable|set-role> --username <账号> [--display-name <姓名>] [--role <reader|analyst|maintainer>]");
  }
  if (rejectsPasswordArgument()) throw new Error("密码不能通过命令参数传入，请使用交互式密码输入");
  const databaseUrl = process.env.BI_AUTH_DATABASE_URL;
  if (!databaseUrl) throw new Error("缺少 BI_AUTH_DATABASE_URL，无法连接 YPBI 账号库");
  const username = biUsernameSchema.parse(argument("username"));
  const sql = createAuthMaintenanceDatabase(databaseUrl);
  try {
    await runAuthMigrations(sql);
    const repository = new PostgresAuthRepository(sql);
    const accounts = new BiAccountAdminService(repository);
    if (command === "create") {
      const role = biRoleSchema.parse(argument("role") ?? "reader");
      const password = await confirmedPassword();
      const user = await accounts.createAccount({
        username,
        displayName: argument("display-name"),
        role,
        password
      });
      stdout.write(`账号已创建：${user.username}（${user.role}）\n`);
      return;
    }
    if (command === "reset-password") {
      const password = await confirmedPassword();
      if (!await accounts.resetPassword(username, password)) throw new Error("账号不存在或已在并发操作中发生变化");
      stdout.write(`账号 ${username} 的密码已重置，原有会话已全部失效。\n`);
      return;
    }
    if (command === "disable") {
      await confirmExact(`输入账号 ${username} 以确认停用: `, username, "确认内容不匹配，未停用账号");
      const result = await accounts.disableAccount(username);
      if (!result) throw new Error("账号不存在");
      stdout.write(result.changed
        ? `账号 ${username} 已停用，原有会话已全部失效。\n`
        : `账号 ${username} 已处于停用状态，未做变更。\n`);
      return;
    }
    if (command === "enable") {
      await confirmExact(`输入账号 ${username} 以确认重新启用: `, username, "确认内容不匹配，未启用账号");
      const result = await accounts.enableAccount(username);
      if (!result) throw new Error("账号不存在");
      stdout.write(result.changed
        ? `账号 ${username} 已重新启用，原有会话已全部失效。\n`
        : `账号 ${username} 已处于启用状态，未做变更。\n`);
      return;
    }
    const role = biRoleSchema.parse(argument("role"));
    const expectedConfirmation = `${username}:${role}`;
    await confirmExact(
      `输入 ${expectedConfirmation} 以确认修改角色: `,
      expectedConfirmation,
      "确认内容不匹配，未修改账号角色"
    );
    const result = await accounts.setAccountRole(username, role);
    if (!result) throw new Error("账号不存在");
    stdout.write(result.changed
      ? `账号 ${username} 的角色已修改为 ${result.user.role}，原有会话已全部失效。\n`
      : `账号 ${username} 已是 ${result.user.role}，未做变更。\n`);
  } finally {
    await sql.end();
  }
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : "账号维护失败";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
