import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { checkDatabase, localTimeInfo } from "../lib/accountability-store";
import { outboundMessagingStatus } from "../lib/twilio";

const router: IRouter = Router();

/**
 * Reports what the scheduler actually depends on: a readable store, the local clock it
 * compares check-in times against, and whether outbound delivery can reach a phone.
 * Returns 503 when the store is unusable so the failure is not silent.
 */
router.get("/healthz", (_req, res) => {
  const database = checkDatabase();
  const { time, timezone } = localTimeInfo();
  const healthy = database === "ok";

  const data = HealthCheckResponse.parse({
    status: healthy ? "ok" : "degraded",
    database,
    time,
    timezone,
    outboundMessaging: outboundMessagingStatus(),
  });

  res.status(healthy ? 200 : 503).json(data);
});

export default router;
