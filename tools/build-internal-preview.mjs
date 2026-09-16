import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCommand, ["run", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_INTERNAL_DASHBOARD_PREVIEW_ENABLED: "true"
  }
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
