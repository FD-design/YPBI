import { setDefaultResultOrder } from "node:dns";
import { buildApp } from "./app";
import { loadEnv } from "./config/env";

setDefaultResultOrder("ipv4first");
const env = loadEnv();
const app = await buildApp(env);
await app.listen({ host: env.HOST, port: env.PORT });
