import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type GoalStatus = "proposed" | "active" | "locked" | "failed" | "completed";
export type EventType =
  | "check_in"
  | "failure"
  | "consequence_issued"
  | "consequence_done"
  | "note"
  | "escalation_sent";

export type Goal = {
  id: number;
  name: string;
  successCondition: string;
  failureCondition: string;
  status: GoalStatus;
  createdAt: string;
  lockedAt: string | null;
  editUnlockAt: string | null;
  checkInTime: string | null;
};

export type Event = {
  id: number;
  goalId: number | null;
  type: EventType;
  content: string;
  createdAt: string;
};

export type Contact = {
  id: number | null;
  name: string;
  phoneNumber: string;
  email: string;
  consentConfirmedAt: string | null;
};

const dataDir = path.resolve(process.env.ACCOUNTABILITY_DATA_DIR ?? ".data");
mkdirSync(dataDir, { recursive: true });

const sqlite = new DatabaseSync(
  path.join(dataDir, process.env.ACCOUNTABILITY_DB_FILE ?? "accountability.sqlite"),
);

sqlite.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    success_condition TEXT NOT NULL,
    failure_condition TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_at TEXT NOT NULL,
    locked_at TEXT,
    edit_unlock_at TEXT,
    check_in_time TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (goal_id) REFERENCES goals(id)
  );
  CREATE TABLE IF NOT EXISTS scheduler_state (
    goal_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    reminded_at TEXT,
    followed_up_at TEXT,
    failed_at TEXT,
    PRIMARY KEY (goal_id, day)
  );
  CREATE TABLE IF NOT EXISTS accountability_contact (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    consent_confirmed_at TEXT
  );
`);

export type LadderTier = {
  /** Smallest slip duration, in minutes, this rung applies to. */
  slipMinutes: number;
  consequence: string;
};

const ladderFile = path.join(dataDir, "ladder.json");

/**
 * Seeded rungs. Deliberately restriction-based — they cost something real and are
 * enforceable without causing injury. Edit them in Settings to match your own ladder.
 */
const defaultLadder: LadderTier[] = [
  { slipMinutes: 1, consequence: "Phone goes in the bag, zip closed. 10-minute silent reset posture." },
  { slipMinutes: 5, consequence: "No music for the next 6 hours — study and work in silence." },
  { slipMinutes: 15, consequence: "No canteen meal the next morning." },
];

function isLadderTier(value: unknown): value is LadderTier {
  if (!value || typeof value !== "object") return false;
  const tier = value as Record<string, unknown>;
  return (
    typeof tier.slipMinutes === "number" &&
    Number.isFinite(tier.slipMinutes) &&
    tier.slipMinutes >= 1 &&
    typeof tier.consequence === "string" &&
    tier.consequence.trim().length > 0
  );
}

const sortTiers = (tiers: LadderTier[]): LadderTier[] =>
  [...tiers].sort((a, b) => a.slipMinutes - b.slipMinutes);

if (!existsSync(ladderFile)) {
  writeFileSync(ladderFile, JSON.stringify(defaultLadder, null, 2));
}

const seedGoals = [
  {
    name: "Boundary Hold",
    successCondition: "Stated boundary holds for its full duration.",
    failureCondition: "Boundary is broken before the window ends.",
    checkInTime: "20:00",
  },
  {
    name: "Check-In Completion",
    successCondition: "Respond to the daily check-in with an honest status before the deadline.",
    failureCondition: "No response by the deadline, or the response is not an answer.",
    checkInTime: "20:00",
  },
  {
    name: "Structure Log",
    successCondition: "The day's planned blocks are logged as attempted.",
    failureCondition: "No structure log is submitted for the day.",
    checkInTime: "20:00",
  },
];

if ((sqlite.prepare("SELECT COUNT(*) AS count FROM goals").get() as { count: number }).count === 0) {
  const insert = sqlite.prepare(`
    INSERT INTO goals (name, success_condition, failure_condition, status, created_at, check_in_time)
    VALUES (?, ?, ?, 'proposed', ?, ?)
  `);
  const createdAt = new Date().toISOString();
  for (const goal of seedGoals) {
    insert.run(goal.name, goal.successCondition, goal.failureCondition, createdAt, goal.checkInTime);
  }
}

const asString = (value: unknown): string => String(value ?? "");
const asNullableString = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const normalizeCheckInTime = (value?: string | null): string | null => {
  if (!value) return null;
  if (/^\d{2}:\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(11, 16);
};

function toGoal(row: Record<string, unknown>): Goal {
  return {
    id: Number(row.id),
    name: asString(row.name),
    successCondition: asString(row.success_condition),
    failureCondition: asString(row.failure_condition),
    status: asString(row.status) as GoalStatus,
    createdAt: asString(row.created_at),
    lockedAt: asNullableString(row.locked_at),
    editUnlockAt: asNullableString(row.edit_unlock_at),
    checkInTime: asNullableString(row.check_in_time),
  };
}

function toEvent(row: Record<string, unknown>): Event {
  return {
    id: Number(row.id),
    goalId: row.goal_id === null ? null : Number(row.goal_id),
    type: asString(row.type) as EventType,
    content: asString(row.content),
    createdAt: asString(row.created_at),
  };
}

/**
 * Round-trips a real query against every table the app writes to. A store that opened
 * but is corrupt or missing a table only shows up when something tries to use it, so
 * the health endpoint exercises it rather than assuming the handle means it works.
 */
export function checkDatabase(): string {
  try {
    const integrity = sqlite.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const verdict = String(Object.values(integrity)[0] ?? "");
    if (verdict !== "ok") return `integrity_check: ${verdict}`;

    for (const table of ["goals", "events", "accountability_contact"]) {
      sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    }
    // The ladder lives beside the database as JSON; an unreadable one is just as fatal.
    if (getLadder().length === 0) return "consequence ladder is empty or unreadable";
    return "ok";
  } catch (err: unknown) {
    return err instanceof Error ? err.message : "unknown database error";
  }
}

/** The clock the scheduler compares `HH:mm` check-in times against. */
export function localTimeInfo(): { time: string; timezone: string } {
  const now = new Date();
  return {
    time: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown",
  };
}

export function getGoals(): Goal[] {
  return (sqlite.prepare("SELECT * FROM goals ORDER BY id").all() as Record<string, unknown>[]).map(toGoal);
}

export function getGoal(id: number): Goal | null {
  const row = sqlite.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? toGoal(row) : null;
}

export function createGoal(input: {
  name: string;
  successCondition: string;
  failureCondition: string;
  checkInTime?: string | null;
}): Goal {
  const createdAt = new Date().toISOString();
  const result = sqlite
    .prepare(`
      INSERT INTO goals (name, success_condition, failure_condition, status, created_at, check_in_time)
      VALUES (?, ?, ?, 'proposed', ?, ?)
    `)
    .run(input.name, input.successCondition, input.failureCondition, createdAt, normalizeCheckInTime(input.checkInTime));
  return getGoal(Number(result.lastInsertRowid)) as Goal;
}

export function canChangeGoal(goal: Goal): boolean {
  return goal.status === "proposed" || Boolean(goal.editUnlockAt && new Date(goal.editUnlockAt) <= new Date());
}

export function updateGoal(
  id: number,
  input: Partial<{
    name: string;
    successCondition: string;
    failureCondition: string;
    checkInTime: string | null;
  }>,
): Goal | null {
  const goal = getGoal(id);
  if (!goal || !canChangeGoal(goal)) return null;
  const fields: string[] = [];
  const values: (string | null)[] = [];
  const mapping = {
    name: "name",
    successCondition: "success_condition",
    failureCondition: "failure_condition",
    checkInTime: "check_in_time",
  } as const;
  for (const key of Object.keys(mapping) as (keyof typeof mapping)[]) {
    if (input[key] !== undefined) {
      fields.push(`${mapping[key]} = ?`);
      values.push(key === "checkInTime" ? normalizeCheckInTime(input[key] as string | null) : input[key] as string | null);
    }
  }
  if (fields.length > 0) {
    values.push(String(id));
    sqlite.prepare(`UPDATE goals SET ${fields.join(", ")}, edit_unlock_at = NULL WHERE id = ?`).run(...values);
  }
  return getGoal(id);
}

export function deleteGoal(id: number): boolean {
  const goal = getGoal(id);
  if (!goal || !canChangeGoal(goal)) return false;
  sqlite.prepare("DELETE FROM events WHERE goal_id = ?").run(id);
  sqlite.prepare("DELETE FROM goals WHERE id = ?").run(id);
  return true;
}

export function lockGoal(id: number): Goal | null {
  const goal = getGoal(id);
  if (!goal || goal.status !== "proposed") return null;
  const lockedAt = new Date().toISOString();
  sqlite.prepare("UPDATE goals SET status = 'active', locked_at = ? WHERE id = ?").run(lockedAt, id);
  return getGoal(id);
}

export function requestAmendment(id: number): Goal | null {
  const goal = getGoal(id);
  if (!goal || !["active", "locked"].includes(goal.status)) return null;
  const unlockAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare("UPDATE goals SET edit_unlock_at = ? WHERE id = ?").run(unlockAt, id);
  return getGoal(id);
}

export function getEvents(limit = 30): Event[] {
  return (
    sqlite
      .prepare("SELECT * FROM events ORDER BY datetime(created_at) DESC, id DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit))) as Record<string, unknown>[]
  ).map(toEvent);
}

/**
 * Events that count toward `goalId` since `since`.
 *
 * Includes events with no goal id: the daily check-in submitted from the app is one
 * submission that covers the day's goals (product spec section 6), so it is stored
 * unattached and has to satisfy every scheduled goal — otherwise the scheduler would
 * keep escalating goals the user has already checked in for.
 */
export function getEventsForGoalSince(goalId: number, since: string): Event[] {
  return (
    sqlite
      .prepare(
        "SELECT * FROM events WHERE (goal_id = ? OR goal_id IS NULL) AND created_at >= ? ORDER BY datetime(created_at) ASC, id ASC",
      )
      .all(goalId, since) as Record<string, unknown>[]
  ).map(toEvent);
}

export function countEventsSince(type: EventType, since: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) AS count FROM events WHERE type = ? AND created_at >= ?")
    .get(type, since) as { count: number };
  return Number(row.count);
}

export function createEvent(input: { goalId?: number | null; type: EventType; content: string }): Event {
  const createdAt = new Date().toISOString();
  const result = sqlite
    .prepare("INSERT INTO events (goal_id, type, content, created_at) VALUES (?, ?, ?, ?)")
    .run(input.goalId ?? null, input.type, input.content, createdAt);
  const row = sqlite.prepare("SELECT * FROM events WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  return toEvent(row);
}

export function getContact(): Contact {
  const row = sqlite.prepare("SELECT * FROM accountability_contact WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row) return { id: null, name: "", phoneNumber: "", email: "", consentConfirmedAt: null };
  return {
    id: 1,
    name: asString(row.name),
    phoneNumber: asString(row.phone_number),
    email: asString(row.email),
    consentConfirmedAt: asNullableString(row.consent_confirmed_at),
  };
}

export function updateContact(input: { name: string; phoneNumber: string; email?: string }): Contact {
  sqlite
    .prepare(`
      INSERT INTO accountability_contact (id, name, phone_number, email, consent_confirmed_at)
      VALUES (1, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, phone_number = excluded.phone_number,
        email = excluded.email, consent_confirmed_at = NULL
    `)
    .run(input.name, input.phoneNumber, input.email ?? "");
  return getContact();
}

/**
 * Returns null when no contact has been saved yet. Consent gates every outbound
 * escalation, so confirming a contact that does not exist must fail loudly rather
 * than report success for a row that was never written.
 */
export function confirmContact(): Contact | null {
  const result = sqlite
    .prepare("UPDATE accountability_contact SET consent_confirmed_at = ? WHERE id = 1")
    .run(new Date().toISOString());
  if (Number(result.changes) === 0) return null;
  return getContact();
}

export function getLadder(): LadderTier[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ladderFile, "utf8"));
    if (!Array.isArray(parsed)) return defaultLadder;

    if (parsed.every(isLadderTier)) return sortTiers(parsed);

    // Migrate the original format, an ordered array of plain strings with no duration
    // attached. Spacing is a guess, so it is written back for the user to correct.
    if (parsed.every((item) => typeof item === "string")) {
      const migrated = (parsed as string[]).map((consequence, index) => ({
        slipMinutes: [1, 5, 15, 30, 60, 120][index] ?? (index + 1) * 60,
        consequence,
      }));
      writeFileSync(ladderFile, JSON.stringify(migrated, null, 2));
      return sortTiers(migrated);
    }

    return defaultLadder;
  } catch {
    return defaultLadder;
  }
}

export function updateLadder(tiers: LadderTier[]): LadderTier[] {
  const sorted = sortTiers(tiers);
  writeFileSync(ladderFile, JSON.stringify(sorted, null, 2));
  return sorted;
}

/**
 * Backstop for ladder rungs that describe injuring yourself or a clear health hazard.
 *
 * The ladder is free text the user controls, and the rest of this system is built to
 * issue whatever it says on a timer, with no appeal. That is the right design for "no
 * canteen meal" and the wrong one for "hit yourself with a belt", so issuing is gated
 * here — the single choke point every path goes through (API, chat tool, scheduler)
 * rather than in a prompt, which can be argued with.
 *
 * Intentionally narrow and keyword-based: it is a guard against the specific failure of
 * automating self-harm, not a general classifier. A flagged rung is never issued and is
 * never handed to the model to repeat; the slip itself is still recorded in full.
 */
const INJURIOUS_PATTERNS: RegExp[] = [
  /\b(?:hit|punch|slap|beat|whip|strike|burn|cut|stab|choke|strangle|bruise)\b[^.]{0,40}(?:yourself|your\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?)|my\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?))\b/i,
  /\b(?:belt|cane|whip|blade|razor|knife|lighter)\b[^.]{0,30}(?:yourself|your\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?)|my\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?))\b/i,
  /(?:yourself|your\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?)|my\s+(?:head|hands?|face|arms?|legs?|body|balls|testicles|groin|genitals|skin|thighs?|chest|stomach|wrists?|knuckles?))[^.]{0,30}\b(?:with\s+a\s+)?(?:belt|cane|whip|blade|razor|knife|lighter)\b/i,
  /\b(?:squeeze|grab|crush|twist|kick)\b[^.]{0,30}\b(?:balls|testicles|groin|genitals)\b/i,
  /\b(?:lick|drink|swallow|eat)\b[^.]{0,40}\b(?:urinal|toilet|piss|urine|vomit|sewage|drain|feces|faeces|poop|shit)\b/i,
  /\b(?:head|face|mouth|tongue|nose)\b[^.]{0,30}\b(?:urinal|toilet|poop|feces|faeces|sewage)\b/i,
  /\b(?:starve\s+(?:yourself|myself)|self.?harm|hurt\s+(?:yourself|myself)|injure\s+(?:yourself|myself)|harm\s+(?:yourself|myself))\b/i,
];

export function isInjuriousConsequence(text: string): boolean {
  return INJURIOUS_PATTERNS.some((pattern) => pattern.test(text));
}

export const WITHHELD_CONSEQUENCE_NOTE =
  "A ladder rung applied, but it describes physical harm, so it was not issued. Replace it in Settings with a consequence that costs you something without injuring you.";

/**
 * The rung that applies to a slip of `minutes`: the highest rung whose threshold has
 * been reached. Returns null when the slip is shorter than every configured rung.
 */
export function tierForSlip(minutes: number): LadderTier | null {
  const applicable = getLadder().filter((tier) => tier.slipMinutes <= minutes);
  return applicable.length > 0 ? applicable[applicable.length - 1]! : null;
}

/**
 * Records a slip as two rows: the factual failure, and the consequence it triggers.
 * The consequence text is copied from the ladder — never composed here — so the system
 * can only ever point at something that was decided in advance.
 */
export function logSlip(input: { minutes: number; note?: string | null; goalId?: number | null }) {
  const goalId = input.goalId ?? null;
  const note = input.note?.trim();
  const tier = tierForSlip(input.minutes);

  const failureEvent = createEvent({
    goalId,
    type: "failure",
    content: note
      ? `Reported slip of ${input.minutes} minute(s): ${note}`
      : `Reported slip of ${input.minutes} minute(s).`,
  });

  const withheld = tier !== null && isInjuriousConsequence(tier.consequence);

  const consequenceEvent = createEvent({
    goalId,
    type: "consequence_issued",
    content: !tier
      ? `Slip of ${input.minutes} min is below every configured ladder rung. No consequence applies.`
      : withheld
        ? `Slip of ${input.minutes} min reaches the ${tier.slipMinutes} min rung. ${WITHHELD_CONSEQUENCE_NOTE}`
        : `Slip of ${input.minutes} min reaches the ${tier.slipMinutes} min rung: ${tier.consequence}`,
  });

  // A withheld rung is reported as null so no caller — including the model — ever
  // receives the text to repeat back.
  return { minutes: input.minutes, failureEvent, consequenceEvent, tier: withheld ? null : tier, withheld };
}

export type SchedulerState = {
  remindedAt: string | null;
  followedUpAt: string | null;
  failedAt: string | null;
};

/**
 * What the scheduler has already done for a goal on a given local day.
 *
 * This lives in the database rather than in process memory on purpose: the delivery
 * flags are the only thing stopping a restart from re-texting you for a check-in it
 * already chased. An in-memory map loses them on every restart, and on a serverless
 * host it would lose them on every single tick.
 */
export function getSchedulerState(goalId: number, day: string): SchedulerState {
  const row = sqlite
    .prepare("SELECT * FROM scheduler_state WHERE goal_id = ? AND day = ?")
    .get(goalId, day) as Record<string, unknown> | undefined;
  return {
    remindedAt: row ? asNullableString(row.reminded_at) : null,
    followedUpAt: row ? asNullableString(row.followed_up_at) : null,
    failedAt: row ? asNullableString(row.failed_at) : null,
  };
}

const SCHEDULER_COLUMNS = {
  remindedAt: "reminded_at",
  followedUpAt: "followed_up_at",
  failedAt: "failed_at",
} as const;

export function markSchedulerState(
  goalId: number,
  day: string,
  fields: Partial<Record<keyof typeof SCHEDULER_COLUMNS, boolean>>,
): void {
  const now = new Date().toISOString();
  const columns = (Object.keys(fields) as (keyof typeof SCHEDULER_COLUMNS)[]).filter(
    (key) => fields[key],
  );
  if (columns.length === 0) return;

  sqlite
    .prepare("INSERT OR IGNORE INTO scheduler_state (goal_id, day) VALUES (?, ?)")
    .run(goalId, day);
  const assignments = columns.map((key) => `${SCHEDULER_COLUMNS[key]} = ?`).join(", ");
  sqlite
    .prepare(`UPDATE scheduler_state SET ${assignments} WHERE goal_id = ? AND day = ?`)
    .run(...columns.map(() => now), goalId, day);
}

/** Keep the table from growing without bound; nothing reads past days. */
export function pruneSchedulerState(beforeDay: string): void {
  sqlite.prepare("DELETE FROM scheduler_state WHERE day < ?").run(beforeDay);
}

export function getDashboard() {
  const goals = getGoals();
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const since = dayStart.toISOString();
  const nowTime = now.toTimeString().slice(0, 5);
  const checkInsToday = countEventsSince("check_in", since);

  return {
    activeGoals: goals.filter((goal) => ["active", "locked"].includes(goal.status)).length,
    proposedGoals: goals.filter((goal) => goal.status === "proposed").length,
    // A goal is only overdue if its check-in time has passed AND nothing was logged
    // for it today — otherwise every held commitment reads as overdue all evening.
    overdueGoals: goals.filter(
      (goal) =>
        ["active", "locked"].includes(goal.status) &&
        goal.checkInTime !== null &&
        goal.checkInTime <= nowTime &&
        !getEventsForGoalSince(goal.id, since).some((event) => event.type === "check_in"),
    ).length,
    checkInsToday,
    recentEvents: getEvents(6),
  };
}
