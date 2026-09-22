import { Router, type IRouter } from "express";
import {
  ConfirmContactResponse,
  CreateEventBody,
  CreateEventResponse,
  CreateGoalBody,
  CreateGoalResponse,
  GetContactResponse,
  GetDashboardResponse,
  GetGoalParams,
  GetGoalResponse,
  GetLadderResponse,
  ListEventsQueryParams,
  ListEventsResponse,
  ListGoalsResponse,
  LockGoalParams,
  LockGoalResponse,
  RequestGoalAmendmentParams,
  RequestGoalAmendmentResponse,
  SendChatMessageBody,
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
  getEvents,
  getGoal,
  getGoals,
  getLadder,
  lockGoal,
  requestAmendment,
  updateContact,
  updateGoal,
  updateLadder,
} from "../lib/accountability-store";

const router: IRouter = Router();
const notFound = (res: Parameters<IRouter["get"]>[1] extends never ? never : any) => res.status(404).json({ error: "Not found" });

router.get("/dashboard", (_req, res) => {
  res.json(GetDashboardResponse.parse(getDashboard()));
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

router.get("/ladder", (_req, res) => res.json(GetLadderResponse.parse({ tiers: getLadder() })));

router.put("/ladder", (req, res) => {
  const input = UpdateLadderBody.parse(req.body);
  return res.json(UpdateLadderResponse.parse({ tiers: updateLadder(input.tiers) }));
});

router.get("/contact", (_req, res) => res.json(GetContactResponse.parse(getContact())));

router.put("/contact", (req, res) => {
  const input = UpdateContactBody.parse(req.body);
  return res.json(UpdateContactResponse.parse(updateContact(input)));
});

router.post("/contact/confirm", (_req, res) => res.json(ConfirmContactResponse.parse(confirmContact())));

router.post("/chat", async (req, res) => {
  const input = SendChatMessageBody.parse(req.body);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "LLM provider is not configured. Add GEMINI_API_KEY to enable chat." });

  const context = JSON.stringify({ goals: getGoals(), recentEvents: getEvents(40), ladder: getLadder() });
  const system = `You are an external accountability partner, not a motivational assistant. Be factual, short, and humane. The database state below is the source of truth. You cannot change goal status, cancel escalations, invent consequences, or claim self-reports are independently verified. If asked to soften an active goal, point to the 24-hour amendment flow. When a goal fails, reference the applicable predefined ladder tier. Never use shame, humiliation, or catastrophizing. Keep responses short. Current state: ${context}`;
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: input.message }] }],
          generationConfig: { maxOutputTokens: 8192 },
        }),
      },
    );
    if (!response.ok) {
      return res.status(503).json({ error: "The accountability partner is unavailable right now." });
    }
    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const message = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") || "No response was returned.";
    return res.json(SendChatMessageResponse.parse({ message, providerConfigured: true }));
  } catch {
    return res.status(503).json({ error: "The accountability partner is unavailable right now." });
  }
});

export default router;