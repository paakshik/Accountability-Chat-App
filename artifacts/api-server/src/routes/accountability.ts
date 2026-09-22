import { Router, type IRouter } from "express";
import {
  ConfirmContactResponse,
  CreateEventBody,
  CreateEventResponse,
  CreateGoalBody,
  CreateGoalResponse,
  GetContactResponse,
  GetDashboardResponse,
  GetDaySummaryResponse,
  GetGoalParams,
  GetGoalResponse,
  GetLadderResponse,
  ListEventsQueryParams,
  ListEventsResponse,
  ListGoalsResponse,
  LogSlipBody,
  LogSlipResponse,
  LockGoalParams,
  LockGoalResponse,
  RequestGoalAmendmentParams,
  RequestGoalAmendmentResponse,
  SendChatMessageBody,
  SendTestMessageBody,
  SendTestMessageResponse,
  SendChatMessageResponse,
  UpdateContactBody,
  UpdateContactResponse,
  UpdateGoalBody,
  UpdateGoalParams,
  UpdateGoalResponse,
  UpdateLadderBody,
  UpdateLadderResponse,
} from "@workspace/api-zod";
import {
  confirmContact,
  createEvent,
  createGoal,
  deleteGoal,
  getContact,
  getDashboard,
  getDaySummary,
  getEvents,
  getGoal,
  getGoals,
  getLadder,
  logSlip,
  lockGoal,
  requestAmendment,
  updateContact,
  updateGoal,
  updateLadder,
} from "../lib/accountability-store";
import { deliveryMode, outboundMessagingStatus, sendTest } from "../lib/twilio";
import {
  askAccountabilityPartner,
  ProviderNotConfiguredError,
  ProviderUnavailableError,
} from "../lib/accountability-partner";

const router: IRouter = Router();

router.get("/dashboard", (_req, res) => {
  res.json(GetDashboardResponse.parse(getDashboard()));
});

router.get("/day-summary", (_req, res) => {
  res.json(GetDaySummaryResponse.parse(getDaySummary()));
});

router.get("/goals", (_req, res) => {
  res.json(ListGoalsResponse.parse(getGoals()));
});

router.post("/goals", (req, res) => {
  const input = CreateGoalBody.parse(req.body);
  res.status(201).json(CreateGoalResponse.parse(createGoal(input)));
});

router.get("/goals/:id", (req, res) => {
  const params = GetGoalParams.parse({ id: Number(req.params.id) });
  const goal = getGoal(params.id);
  if (!goal) return res.status(404).json({ error: "Goal not found" });
  return res.json(GetGoalResponse.parse(goal));
});

router.patch("/goals/:id", (req, res) => {
  const params = UpdateGoalParams.parse({ id: Number(req.params.id) });
  const input = UpdateGoalBody.parse(req.body);
  const goal = updateGoal(params.id, input);
  if (!goal) return res.status(409).json({ error: "Goal is locked or still in its amendment cooldown" });
  return res.json(UpdateGoalResponse.parse(goal));
});

router.delete("/goals/:id", (req, res) => {
  const params = GetGoalParams.parse({ id: Number(req.params.id) });
  if (!deleteGoal(params.id)) return res.status(409).json({ error: "Goal cannot be deleted until it is proposed or its cooldown has ended" });
  return res.status(204).send();
});

router.post("/goals/:id/lock", (req, res) => {
  const params = LockGoalParams.parse({ id: Number(req.params.id) });
  const goal = lockGoal(params.id);
  if (!goal) return res.status(409).json({ error: "Only proposed goals can be confirmed and locked" });
  return res.json(LockGoalResponse.parse(goal));
});

router.post("/goals/:id/amend", (req, res) => {
  const params = RequestGoalAmendmentParams.parse({ id: Number(req.params.id) });
  const goal = requestAmendment(params.id);
  if (!goal) return res.status(409).json({ error: "Only active goals can enter an amendment cooldown" });
  return res.json(RequestGoalAmendmentResponse.parse(goal));
});

router.get("/events", (req, res) => {
  const query = ListEventsQueryParams.parse({ limit: req.query.limit ? Number(req.query.limit) : undefined });
  return res.json(ListEventsResponse.parse(getEvents(query.limit)));
});

router.post("/events", (req, res) => {
  const input = CreateEventBody.parse(req.body);
  return res.status(201).json(CreateEventResponse.parse(createEvent(input)));
});

router.post("/slips", (req, res) => {
  const input = LogSlipBody.parse(req.body);
  return res.status(201).json(LogSlipResponse.parse(logSlip(input)));
});

router.get("/ladder", (_req, res) => res.json(GetLadderResponse.parse({ tiers: getLadder() })));

router.put("/ladder", (req, res) => {
  const input = UpdateLadderBody.parse(req.body);
  return res.json(UpdateLadderResponse.parse({ tiers: updateLadder(input.tiers) }));
});

router.post("/selftest/message", async (req, res) => {
  const input = SendTestMessageBody.parse(req.body);
  const to = input.to?.trim() || process.env.ACCOUNTABILITY_USER_PHONE?.trim();
  const mode = deliveryMode();

  if (mode === "disabled") return res.status(503).json({ error: outboundMessagingStatus() });
  if (!to) return res.status(503).json({ error: "No destination: set ACCOUNTABILITY_USER_PHONE or pass `to`." });

  const delivered = await sendTest(to, input.channel);
  return res.json(
    SendTestMessageResponse.parse({
      delivered,
      mode,
      detail: delivered
        ? `Twilio accepted a ${input.channel} to ${to}.`
        : `Twilio did not accept the ${input.channel} to ${to}. Check the server log for the provider's reason.`,
    }),
  );
});

router.get("/contact", (_req, res) => res.json(GetContactResponse.parse(getContact())));

router.put("/contact", (req, res) => {
  const input = UpdateContactBody.parse(req.body);
  return res.json(UpdateContactResponse.parse(updateContact(input)));
});

router.post("/contact/confirm", (_req, res) => {
  const contact = confirmContact();
  if (!contact) return res.status(409).json({ error: "Save an accountability contact before confirming consent" });
  return res.json(ConfirmContactResponse.parse(contact));
});

router.post("/chat", async (req, res) => {
  const input = SendChatMessageBody.parse(req.body);
  try {
    const message = await askAccountabilityPartner(input.message, input.history ?? []);
    return res.json(SendChatMessageResponse.parse({ message, providerConfigured: true }));
  } catch (error: unknown) {
    if (
      error instanceof ProviderNotConfiguredError ||
      error instanceof ProviderUnavailableError
    ) {
      // 503 rather than a fabricated reply: the record must never carry invented text.
      return res.status(503).json({ error: error.message });
    }
    throw error;
  }
});

export default router;