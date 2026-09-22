import {
  createEvent,
  createGoal,
  getContact,
  getEvents,
  getGoal,
  getGoals,
  getDaySummary,
  getLadder,
  localTimeInfo,
  logSlip,
  type EventType,
} from "./accountability-store";
import { outboundMessagingStatus } from "./twilio";
import { logger } from "./logger";

/**
 * Chat provider: Google Gemini (generateContent).
 *
 * Deliberately a plain `fetch` rather than `@google/genai`: this is a single
 * authenticated POST with no OAuth, streaming or tokenizer use, and the SDK pulls in
 * ~37 transitive packages (google-auth-library, protobufjs, ws) plus an install script
 * that is broken in its published tarball. The REST contract used here is stable.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
// Chosen for free-tier headroom, not raw capability. The Gemini free tier caps
// generateContent at 20 requests/day *per model*, which a daily check-in app burns
// through immediately on a full flash model; the lite tier has materially more room and
// still followed every enforcement rule in testing. gemini-3.7/3.8-flash were also
// rejected for reliability — both returned transient 503 "high demand" on ~3 of 5 calls
// when measured, where 3.6-flash was 5/5.
// Override with ACCOUNTABILITY_MODEL (e.g. gemini-3.6-flash once billing is enabled).
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
// Gemini 3.x reasons before answering and those thinking tokens count against this
// ceiling, so it has to be well above the length of the reply we actually want.
const MAX_OUTPUT_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 30_000;
// Gemini returns transient 503 "high demand" spikes often enough that a single
// attempt makes chat feel broken. Retry the retryable statuses with backoff.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 600;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// How many function-call rounds to allow before giving up on a reply.
const MAX_TOOL_ROUNDS = 4;
// Enough for a propose-and-confirm exchange without resending an unbounded transcript.
const MAX_HISTORY_TURNS = 20;

/**
 * The only event types the chatbot may write. `failure`, `consequence_issued` and
 * `escalation_sent` are deliberately excluded: the spec gives those to the scheduler
 * alone, so the partner can never invent a consequence or declare a goal failed.
 */
const LOGGABLE_EVENT_TYPES = ["check_in", "note", "consequence_done"] as const;
type LoggableEventType = (typeof LOGGABLE_EVENT_TYPES)[number];

const TOOLS = {
  functionDeclarations: [
    {
      name: "log_event",
      description:
        "Record a factual event in the accountability log. Use check_in when the user reports how a commitment went, consequence_done when they report completing a predefined consequence, and note for anything else worth recording. Never use this to claim something was independently verified.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [...LOGGABLE_EVENT_TYPES],
            description: "The kind of event being recorded.",
          },
          content: {
            type: "string",
            description: "A short, factual description in the user's own terms.",
          },
          goalId: {
            type: "integer",
            description:
              "Optional id of the goal this event belongs to. Omit for the daily check-in, which covers every scheduled goal.",
          },
        },
        required: ["type", "content"],
      },
    },
    {
      name: "log_slip",
      description:
        "Record time lost to a distraction and issue the predefined consequence for it. Call this whenever the user reports wasting time. The consequence is read from the user's configured ladder — you never choose or invent one.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "integer",
            description: "How many minutes were lost. Ask if the user has not said.",
          },
          note: {
            type: "string",
            description: "Short factual description of what the time went to.",
          },
          goalId: {
            type: "integer",
            description: "Optional id of the goal this slip belongs to.",
          },
        },
        required: ["minutes"],
      },
    },
    {
      name: "close_day",
      description:
        "Close out the day and retrieve its scored summary. Call this when the user says they are ending the day, wrapping up, going to sleep, or asks how the day went. The score is computed from the stored record — you report it, you do not decide it.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      name: "propose_goal",
      description:
        "Create a new goal in the 'proposed' state after the user has agreed to its exact terms. Proposed goals are freely editable and are NOT in force: the user must confirm and lock them in the Goals screen. Never imply a proposed goal is active.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name for the commitment." },
          successCondition: {
            type: "string",
            description: "Observable condition that counts as having done it.",
          },
          failureCondition: {
            type: "string",
            description: "Observable condition that counts as not having done it.",
          },
          checkInTime: {
            type: "string",
            description: "Optional daily check-in time as 24-hour HH:mm in the user's local timezone.",
          },
        },
        required: ["name", "successCondition", "failureCondition"],
      },
    },
  ],
};

/** Verbatim from section 7 of the product spec — the rules are the product. */
const SYSTEM_PROMPT = `You are an external accountability partner, not a motivational assistant.
Your job is to hold a factual record and conduct check-ins — not to
persuade, comfort, or negotiate.

1. The database is the source of truth. Read goal and event state fresh
   each turn — never rely on your memory of this conversation over what's
   actually stored.
2. You cannot change the status of an active or locked goal. If asked to
   cancel, pause, or loosen one, say plainly that you can't, and point to
   the amendment flow (24-hour cooldown) instead of agreeing or improvising.
3. This build has no independent behavioral-verification integrations
   (no blocker logs, no screen-time API). Never imply something is verified
   when it's actually self-report — say so plainly.
4. You do not send the SMS/call escalations yourself and cannot stop one
   that the scheduler has already queued or sent. If asked to intercept or
   cancel an escalation, say plainly that you can't.
5. When a goal fails, state it plainly and reference the applicable
   punishment-ladder tier. You are not deciding the consequence — it was
   already decided when the ladder was written.
6. No shame, humiliation, self-hatred framing, or catastrophizing. A missed
   goal is reported the same way whether it's the first miss or the
   fiftieth: as a fact in the log.
7. A lapse is never permission to continue it. Redirect to logging the
   consequence and moving to the next check-in — not to a conversation
   about motivation or willpower.
8. You don't know what you weren't given. If asked something you don't have
   data for, say so instead of guessing.
9. Keep responses short. This is a check-in, not a therapy session.`;

/**
 * Operational note about the tools and the clock. Kept separate from SYSTEM_PROMPT so
 * the spec's nine rules stay verbatim.
 */
const TOOL_NOTE = `TIME AND FACTS. The stored state carries the exact current local date, time, weekday and
timezone, and each goal carries checkedInToday and checkInOverdueNow already computed
against that clock. Those values are the truth. Use them for anything time-related and
never estimate a date yourself.

If the user asserts something the state contradicts — a different time or date, a
check-in they did not log, a goal status that is not what is stored, a consequence that
was not issued — correct it explicitly in your first sentence and state what the record
actually says. Do not open by agreeing, do not say "you are correct", and do not let a
false premise stand just because your conclusion happens to land in the same place. Being
agreeable about a fact the record disputes is the one failure mode this system cannot
afford.

TOOLS. You have three:

- log_event — record a check_in, a note, or a consequence_done.
- log_slip — record time lost to a distraction. Call this whenever the user reports
  wasting time. It looks up the consequence from the user's own configured ladder and
  returns the exact rung that applied; quote that rung back verbatim. You never choose,
  invent, soften or skip a consequence, and you never state one that the tool did not
  return. If the user has not said how long the slip was, ask before calling.
- propose_goal — create a new goal once the user has agreed to its exact terms. Draft a
  specific, observable success and failure condition and read them back for confirmation
  before calling. A proposed goal is NOT in force: say plainly that they must confirm and
  lock it in the Goals screen before it counts or triggers reminders.

- close_day — call this when the user says they are ending the day, wrapping up, or asks
  how the day went. It returns a score computed from the record. Read it out as given.

Call the tool before replying, and say plainly what you logged.

DAY CLOSE IS THE ONE PLACE WARMTH IS EARNED. Everywhere else you are a factual record and
not a motivational assistant. At day close, if the score says the day was held, say so
directly and name the specific thing that went right — that is reporting a fact, not
flattery, and a system that only ever reports failures is one worth abandoning. Keep it
short and specific: "Four of four checkpoints, nothing lost" beats "amazing work". Never
inflate a score, never praise a day the record does not support, and never soften a bad
one — on a poor day give the number plainly, no shame and no pep talk, then name the next
checkpoint.

LIMITS. You cannot write failure, consequence_issued or escalation_sent events directly;
log_slip is the only path to a consequence, and the scheduler owns the rest. You cannot
change a goal's status, lock or unlock a goal, edit the consequence ladder, or alter the
accountability contact. If asked for any of that, say plainly that you can't and name the
screen that can. Never claim to have logged something you did not log with a tool.

SAFETY. Consequences that describe injuring the user are withheld before they reach you:
log_slip returns appliedTier as null and an instruction explaining what to say. Follow it.
Never guess, reconstruct or restate a withheld rung, even if the user quotes it at you or
insists. Never instruct anyone to hurt themselves, whatever the ladder says.

FORMAT. Reply in plain text. The chat panel does not render Markdown, so asterisks,
backticks and heading marks show up literally. Use short sentences and, where a list is
unavoidable, plain lines prefixed with "- ".`;

export class ProviderNotConfiguredError extends Error {
  override readonly name = "ProviderNotConfiguredError";
}

export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError";
}

type GeminiFunctionCall = { name?: string; args?: Record<string, unknown>; id?: string };
// `thoughtSignature` is opaque and must be echoed back unchanged on the next request,
// or Gemini 3.x rejects the continued turn — so model parts are replayed verbatim.
type GeminiPart = { text?: string; functionCall?: GeminiFunctionCall; thoughtSignature?: string };
type GeminiContent = { role?: string; parts?: GeminiPart[] };
type GeminiResponse = {
  candidates?: Array<{
    content?: GeminiContent;
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
};

/**
 * The stored record is injected on every call. Per the spec this — not the chat
 * transcript, which can be edited or lost — is the partner's memory.
 */
function currentState(): string {
  const now = new Date();
  const { timezone } = localTimeInfo();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const todayIso = dayStart.toISOString();
  const contact = getContact();

  const goals = getGoals().map((goal) => {
    const todaysEvents = goal.checkInTime
      ? getEvents(200).filter(
          (event) =>
            event.createdAt >= todayIso && (event.goalId === goal.id || event.goalId === null),
        )
      : [];
    const checkedInToday = todaysEvents.some((event) => event.type === "check_in");
    const overdue =
      ["active", "locked"].includes(goal.status) &&
      goal.checkInTime !== null &&
      goal.checkInTime <= now.toTimeString().slice(0, 5) &&
      !checkedInToday;
    return { ...goal, checkedInToday, checkInOverdueNow: overdue };
  });

  return JSON.stringify({
    // Explicit wall-clock context: the partner must reason about deadlines from the
    // same clock the scheduler uses, not guess a date from the conversation.
    now: {
      iso: now.toISOString(),
      local: now.toString(),
      localTime: now.toTimeString().slice(0, 5),
      localDate: `${dayStart.getFullYear()}-${String(dayStart.getMonth() + 1).padStart(2, "0")}-${String(dayStart.getDate()).padStart(2, "0")}`,
      weekday: new Intl.DateTimeFormat("en", { weekday: "long" }).format(now),
      timezone,
    },
    goals,
    eventsToday: getEvents(200).filter((event) => event.createdAt >= todayIso),
    recentEvents: getEvents(40),
    consequenceLadder: getLadder(),
    accountabilityContact: {
      configured: contact.id !== null,
      name: contact.name || null,
      consentConfirmedAt: contact.consentConfirmedAt,
    },
    outboundMessaging: outboundMessagingStatus(),
  });
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new ProviderNotConfiguredError(
      "LLM provider is not configured. Add GEMINI_API_KEY to enable chat.",
    );
  }
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(model: string, key: string, contents: GeminiContent[]): Promise<GeminiResponse> {
  let lastError: ProviderUnavailableError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${API_ROOT}/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          // Header rather than a `?key=` query param so the key stays out of logs.
          "x-goog-api-key": key,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              { text: SYSTEM_PROMPT },
              { text: TOOL_NOTE },
              { text: `Current stored state: ${currentState()}` },
            ],
          },
          contents,
          tools: [TOOLS],
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      lastError = new ProviderUnavailableError(
        `Could not reach the accountability partner: ${err instanceof Error ? err.message : "network error"}.`,
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    }

    let payload: GeminiResponse;
    try {
      payload = (await response.json()) as GeminiResponse;
    } catch {
      throw new ProviderUnavailableError(
        `The accountability partner returned an unreadable response (HTTP ${response.status}).`,
      );
    }

    if (response.ok) return payload;

    const detail = payload.error?.message ?? response.statusText;

    // A bad key will never succeed on retry — fail fast and say why.
    if (response.status === 401 || response.status === 403) {
      throw new ProviderNotConfiguredError(
        `GEMINI_API_KEY was rejected by the provider: ${detail}`,
      );
    }
    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new ProviderUnavailableError(
        `The accountability partner is unavailable right now (HTTP ${response.status}: ${detail}).`,
      );
    }

    lastError = new ProviderUnavailableError(
      response.status === 429
        ? "The accountability partner is rate limited right now. Try again shortly."
        : `The accountability partner is unavailable right now (HTTP ${response.status}: ${detail}).`,
    );
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * attempt);
  }

  throw lastError ?? new ProviderUnavailableError("The accountability partner is unavailable right now.");
}

/** Runs one `log_event` call against the store and returns what to report back. */
function runLogEvent(args: Record<string, unknown>): Record<string, unknown> {
  const type = String(args["type"] ?? "");
  const content = String(args["content"] ?? "").trim();

  if (!LOGGABLE_EVENT_TYPES.includes(type as LoggableEventType)) {
    return {
      status: "rejected",
      reason: `"${type}" is not a type you may write. Allowed: ${LOGGABLE_EVENT_TYPES.join(", ")}.`,
    };
  }
  if (!content) {
    return { status: "rejected", reason: "content must not be empty" };
  }

  let goalId: number | null = null;
  const rawGoalId = args["goalId"];
  if (rawGoalId !== undefined && rawGoalId !== null) {
    const parsed = Number(rawGoalId);
    if (!Number.isInteger(parsed) || !getGoal(parsed)) {
      return { status: "rejected", reason: `goalId ${String(rawGoalId)} does not exist` };
    }
    goalId = parsed;
  }

  const event = createEvent({ goalId, type: type as EventType, content });
  logger.info({ eventId: event.id, type: event.type, goalId: event.goalId }, "Chat logged an event");
  return { status: "recorded", eventId: event.id, createdAt: event.createdAt };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function runLogSlip(args: Record<string, unknown>): Record<string, unknown> {
  const minutes = Number(args["minutes"]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return { status: "rejected", reason: "minutes must be a whole number between 1 and 1440" };
  }

  const rawGoalId = args["goalId"];
  let goalId: number | null = null;
  if (rawGoalId !== undefined && rawGoalId !== null) {
    const parsed = Number(rawGoalId);
    if (!Number.isInteger(parsed) || !getGoal(parsed)) {
      return { status: "rejected", reason: `goalId ${String(rawGoalId)} does not exist` };
    }
    goalId = parsed;
  }

  const note = typeof args["note"] === "string" ? args["note"] : null;
  const result = logSlip({ minutes, note, goalId });
  logger.info(
    { minutes, tier: result.tier?.slipMinutes ?? null, withheld: result.withheld },
    "Chat logged a slip",
  );

  return {
    status: "recorded",
    minutes: result.minutes,
    failureEventId: result.failureEvent.id,
    consequenceEventId: result.consequenceEvent.id,
    // Echo the exact rung so the reply quotes the user's own ladder, not a paraphrase.
    // A withheld rung arrives as null, so there is no harmful text here to repeat.
    appliedTier: result.tier
      ? { slipMinutes: result.tier.slipMinutes, consequence: result.tier.consequence }
      : null,
    instruction: result.withheld
      ? "A rung applied but was withheld because it describes physical harm. Tell the user the slip is recorded, that you will not pass on that rung, and that they should replace it in Settings with one that costs them something without injuring them. Do not guess or restate what it said."
      : result.tier
        ? undefined
        : "The slip is below every configured rung; no consequence applies.",
  };
}

function runProposeGoal(args: Record<string, unknown>): Record<string, unknown> {
  const name = String(args["name"] ?? "").trim();
  const successCondition = String(args["successCondition"] ?? "").trim();
  const failureCondition = String(args["failureCondition"] ?? "").trim();

  if (!name || !successCondition || !failureCondition) {
    return {
      status: "rejected",
      reason: "name, successCondition and failureCondition are all required and must be non-empty",
    };
  }

  const rawTime = args["checkInTime"];
  let checkInTime: string | null = null;
  if (typeof rawTime === "string" && rawTime.trim()) {
    if (!HHMM.test(rawTime.trim())) {
      return { status: "rejected", reason: `checkInTime must be 24-hour HH:mm, got "${rawTime}"` };
    }
    checkInTime = rawTime.trim();
  }

  // A vague follow-up ("yes, create it") once made the model re-propose every seeded
  // goal. Refuse a name that already exists so ambiguity cannot duplicate the record.
  const clash = getGoals().find(
    (existing) => existing.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    return {
      status: "rejected",
      reason: `A goal named "${clash.name}" already exists (id ${clash.id}, ${clash.status}). Ask the user whether they meant that one, or pick a distinct name.`,
    };
  }

  const goal = createGoal({ name, successCondition, failureCondition, checkInTime });
  logger.info({ goalId: goal.id, name: goal.name }, "Chat proposed a goal");

  return {
    status: "proposed",
    goalId: goal.id,
    goalStatus: goal.status,
    checkInTime: goal.checkInTime,
    reminder: "This goal is PROPOSED, not active. The user must confirm and lock it in the Goals screen before it is in force or gets reminders.",
  };
}

function runCloseDay(): Record<string, unknown> {
  const summary = getDaySummary();
  logger.info({ score: summary.score, band: summary.band }, "Chat closed the day");
  return {
    status: "computed",
    ...summary,
    instruction:
      "Report this score and these facts as they are. Do not recompute, round, inflate or soften it. If the day was held, say so plainly and name the specific thing that went right — that acknowledgement is earned and you may give it. If it was not, state it as a fact in the log, with no shame framing and no pep talk. End by naming the next checkpoint.",
  };
}

function runTool(name: string | undefined, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "close_day":
      return runCloseDay();
    case "log_event":
      return runLogEvent(args);
    case "log_slip":
      return runLogSlip(args);
    case "propose_goal":
      return runProposeGoal(args);
    default:
      return { status: "rejected", reason: `unknown tool ${String(name)}` };
  }
}

export type ChatTurn = { role: "user" | "partner"; text: string };

export async function askAccountabilityPartner(
  message: string,
  history: ChatTurn[] = [],
): Promise<string> {
  const key = apiKey();
  const model = process.env.ACCOUNTABILITY_MODEL || DEFAULT_MODEL;
  // Prior turns give conversational continuity so follow-ups like "yes, create it"
  // resolve. Facts still come from the freshly injected state, which the system prompt
  // ranks above anything said in the conversation.
  const contents: GeminiContent[] = [
    ...history
      .filter((turn) => turn.text.trim())
      .slice(-MAX_HISTORY_TURNS)
      .map((turn) => ({
        role: turn.role === "partner" ? "model" : "user",
        parts: [{ text: turn.text }],
      })),
    { role: "user", parts: [{ text: message }] },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const payload = await callGemini(model, key, contents);

    if (payload.promptFeedback?.blockReason) {
      throw new ProviderUnavailableError(
        `The accountability partner declined to answer that message (${payload.promptFeedback.blockReason}).`,
      );
    }

    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const calls = parts
      .map((part) => part.functionCall)
      .filter((call): call is GeminiFunctionCall => Boolean(call?.name));

    if (calls.length > 0) {
      // Replay the model turn verbatim so thought signatures survive the round trip,
      // then answer every call in a single turn.
      contents.push({ role: candidate?.content?.role ?? "model", parts });
      contents.push({
        role: "user",
        parts: calls.map((call) => ({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: runTool(call.name, call.args ?? {}),
          },
        })) as GeminiPart[],
      });
      continue;
    }

    const text = parts
      .map((part) => part.text ?? "")
      .join("")
      .trim();

    if (text) return text;

    // MAX_TOKENS here means thinking consumed the whole budget before any answer.
    throw new ProviderUnavailableError(
      `The accountability partner returned an empty response (${candidate?.finishReason ?? "no candidate"}).`,
    );
  }

  throw new ProviderUnavailableError(
    "The accountability partner kept calling tools without answering. Try rephrasing.",
  );
}
