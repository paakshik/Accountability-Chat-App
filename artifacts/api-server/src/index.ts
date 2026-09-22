import app from "./app";
import { logger } from "./lib/logger";
import { startScheduler } from "./lib/scheduler";

// Replit's artifact runner injects PORT per service (see .replit-artifact/artifact.toml).
// Outside it — local dev, tests, a plain `node dist/index.mjs` — fall back to the same
// port the artifact config uses so the app boots without extra setup.
//
// API_PORT takes precedence so one variable moves both this server and the web app's
// dev proxy; a bare PORT would otherwise collide when both halves run from one shell.
const DEFAULT_PORT = 8080;

const rawPort = process.env["API_PORT"] ?? process.env["PORT"];
const port = rawPort ? Number(rawPort) : DEFAULT_PORT;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startScheduler();
});
