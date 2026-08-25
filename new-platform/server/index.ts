import { buildApp } from "./app";
import { loadEnv } from "./config";

const env = loadEnv();
const app = await buildApp(env);
await app.listen({ host: env.HOST, port: env.PORT });
