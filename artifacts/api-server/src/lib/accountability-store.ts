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
  CREATE TABLE IF NOT EXISTS accountability_contact (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    consent_confirmed_at TEXT
  );
`);

const ladderFile = path.join(dataDir, "ladder.json");
const defaultLadder = [
  "Tier 1 — Log the miss and complete the next check-in.",
  "Tier 2 — Complete the predefined repair action.",
  "Tier 3 — Notify the agreed accountability contact.",
];

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

export function getEventsForGoalSince(goalId: number, since: string): Event[] {
  return (
    sqlite
      .prepare("SELECT * FROM events WHERE goal_id = ? AND created_at >= ? ORDER BY datetime(created_at) ASC, id ASC")
      .all(goalId, since) as Record<string, unknown>[]
  ).map(toEvent);
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

export function confirmContact(): Contact {
  sqlite
    .prepare("UPDATE accountability_contact SET consent_confirmed_at = ? WHERE id = 1")
    .run(new Date().toISOString());
  return getContact();
}

export function getLadder(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ladderFile, "utf8"));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : defaultLadder;
  } catch {
    return defaultLadder;
  }
}

export function updateLadder(tiers: string[]): string[] {
  writeFileSync(ladderFile, JSON.stringify(tiers, null, 2));
  return tiers;
}

export function getDashboard() {
  const goals = getGoals();
  const today = new Date().toISOString().slice(0, 10);
  const recentEvents = getEvents(6);
  return {
    activeGoals: goals.filter((goal) => ["active", "locked"].includes(goal.status)).length,
    proposedGoals: goals.filter((goal) => goal.status === "proposed").length,
    overdueGoals: goals.filter(
      (goal) => goal.status === "active" && goal.checkInTime && goal.checkInTime < new Date().toTimeString().slice(0, 5),
    ).length,
    checkInsToday: recentEvents.filter(
      (event) => event.type === "check_in" && event.createdAt.startsWith(today),
    ).length,
    recentEvents,
  };
}