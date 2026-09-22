// Runs before `install` in every environment, so it may only use Node builtins —
// node_modules is not guaranteed to exist yet. Kept in plain JS (not TypeScript)
// for the same reason, and written without shell syntax so it works on Windows.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  rmSync(path.resolve(root, "..", lockfile), { force: true });
}

const userAgent = process.env["npm_config_user_agent"] ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error("Use pnpm instead");
  process.exit(1);
}
