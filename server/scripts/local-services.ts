import { spawnSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { createPostgresAuthModule } from "../auth";

// Local-only provisioning: no production environment or existing cluster is used.
const project = resolve(import.meta.dir, "../..");
const directory = resolve(project, "data/local-services");
const cluster = resolve(directory, "postgres");
const socket = resolve(directory, "socket");
const envFile = resolve(project, ".env.backend-local");
const stateFile = resolve(directory, "control.json");
const command = process.argv[2] ?? "start";
if (!["start", "stop", "provision"].includes(command)) throw new Error("使用 start、stop 或 provision");
if (command === "start" && !existsSync(stateFile)) throw new Error("本地账号库尚未初始化，请先执行 provision 并保存返回的一次性登录信息。");
mkdirSync(directory, { recursive:true, mode:0o700 });
chmodSync(directory, 0o700);
mkdirSync(socket, { recursive:true, mode:0o700 });
function run(program: string, args: string[], allowFailure=false) {
  const result=spawnSync(program,args,{encoding:"utf8",stdio:"pipe"});
  if(result.status!==0&&!allowFailure) throw new Error(`${program}执行失败；请检查本地PostgreSQL状态。`);
  return result.status===0;
}
const pgctl="/opt/homebrew/bin/pg_ctl";
if(command==="stop") {
  if(existsSync(resolve(cluster,"PG_VERSION"))) run(pgctl,["-D",cluster,"-m","fast","stop"]);
  console.log("独立本地账号库已停止；数据保留。");
  process.exit(0);
}
const fresh=!existsSync(stateFile);
if(fresh&&existsSync(envFile)) throw new Error("本地配置已存在，停止以避免覆盖。");
const secret=()=>randomBytes(32).toString("base64url");
const state=fresh?{admin:secret(),application:secret(),csrf:secret()}:JSON.parse(readFileSync(stateFile,"utf8"));
if(fresh)writeFileSync(stateFile,JSON.stringify(state),{mode:0o600,flag:"wx"});
if(!existsSync(resolve(cluster,"PG_VERSION"))) {
  const passwordFile=resolve(directory,"postgres-password");
  if(!existsSync(passwordFile))writeFileSync(passwordFile,state.admin,{mode:0o600,flag:"wx"});
  run("/opt/homebrew/bin/initdb",["-D",cluster,"-L","/opt/homebrew/opt/postgresql@17/share/postgresql","--username=ypbi_local_admin","--auth=scram-sha-256","--encoding=UTF8","--locale=C",`--pwfile=${passwordFile}`]);
}
if(!run(pgctl,["-D",cluster,"status"],true))run(pgctl,["-D",cluster,"-l",resolve(directory,"postgres.log"),"-o",`-h 127.0.0.1 -p 55432 -k '${socket}'`,"-w","start"]);
const admin=postgres({host:"127.0.0.1",port:55432,user:"ypbi_local_admin",password:state.admin,database:"postgres",max:1});
try {
  if(!(await admin`select 1 from pg_roles where rolname='ypbi_local_app'`).length)await admin.unsafe(`CREATE ROLE ypbi_local_app LOGIN PASSWORD '${state.application}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  if(!(await admin`select 1 from pg_database where datname='ypbi_local_auth'`).length)await admin.unsafe("CREATE DATABASE ypbi_local_auth OWNER ypbi_local_app");
} finally {await admin.end();}
const databaseUrl=`postgres://ypbi_local_app:${state.application}@127.0.0.1:55432/ypbi_local_auth`;
let maintenancePassword: string | undefined;
if(!existsSync(envFile)) {
  maintenancePassword=secret();
  const settings={NODE_ENV:"development",HOST:"127.0.0.1",PORT:"3000",BI_IDENTITY_MODE:"local",BI_AUTH_DATABASE_URL:databaseUrl,BI_AUTH_CSRF_SECRET:state.csrf,BI_PUBLIC_ORIGIN:"http://127.0.0.1:5173",TOKEN_MAINTENANCE_KEY:`sha256:${createHash("sha256").update(maintenancePassword).digest("hex")}`,UPSTREAM_CREDENTIALS_FILE:"./data/local-services/upstream-credentials.json",WORKSPACE_FILE:"./data/local-services/workspace.json"};
  writeFileSync(envFile,Object.entries(settings).map(([key,value])=>`${key}=${value}`).join("\n")+"\n",{mode:0o600,flag:"wx"});
}
const auth=await createPostgresAuthModule(databaseUrl,{csrfSecret:state.csrf});
try {
  if(command==="provision") {
    if(existsSync(resolve(directory,"provisioned"))) throw new Error("本地账号已创建；账号变更请使用既有交互式账号命令。");
    const password=secret();
    await auth.accountAdminService.createAccount({username:"liyujing",displayName:"liyujing",role:"maintainer",password});
    writeFileSync(resolve(directory,"provisioned"),"liyujing",{mode:0o600,flag:"wx"});
    // Provisioning returns one-time credentials only to its interactive caller, never server logs.
    console.log(JSON.stringify({username:"liyujing",initialPassword:password,maintenancePassword}));
  } else console.log("独立本地账号库已就绪。");
} finally {await auth.close();}
