import { logger } from "./logger";
import {
  createEvent,
  getContact,
  getEventsForGoalSince,
  getGoals,
  getLadder,
  isInjuriousConsequence,
  WITHHELD_CONSEQUENCE_NOTE,
} from "./accountability-store";
import { outboundMessagingConfigured, placeCall, sendSms } from "./twilio";

const GRACE_PERIOD_MS = 30 * 60 * 1000;
const TICK_INTERVAL_MS = 60_000;

type DeliveryState = {
  /** Local calendar day (YYYY-MM-DD) this state belongs to. */
  day: string;
  dueAt: number;
  followUpSent: boolean;
  failureLogged: boolean;
};

const deliveryState = new Map<number, DeliveryState>();

function dayStart(now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** Local calendar day key — `toISOString()` would shift the day for non-UTC zones. */
function dayKey(now: Date) {
  const start = dayStart(now);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
}

/** Minutes since local midnight, for an `HH:mm` string or a Date. */
function minutesOfDay(value: string | Date): number | null {
  if (value instanceof Date) return value.getHours() * 60 + value.getMinutes();
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function deliver(to: string, message: string) {
  if (process.env.ACCOUNTABILITY_USE_CALLS === "true") return placeCall(to, message);
  return sendSms(to, message);
}

export async function runSchedulerTick() {
  const now = new Date();
  const today = dayKey(now);
  const sinceIso = dayStart(now).toISOString();
  const nowMinutes = minutesOfDay(now)!;
  const contact = getContact();
  const userPhone = process.env.ACCOUNTABILITY_USER_PHONE;
  const dueGoals = getGoals().filter(
    (goal) => ["active", "locked"].includes(goal.status) && goal.checkInTime,
  );

  for (const goal of dueGoals) {
    const checkInMinutes = minutesOfDay(goal.checkInTime!);
    if (checkInMinutes === null) {
      logger.warn({ goalId: goal.id, checkInTime: goal.checkInTime }, "Skipping goal with unparseable check-in time");
      continue;
    }

    // A check-in logged from the app carries no goal id (one submission covers the
    // day's goals, per the product spec), so a null goalId counts for every goal.
    const responded = getEventsForGoalSince(goal.id, sinceIso).some(
      (event) => event.type === "check_in",
    );

    const existing = deliveryState.get(goal.id);
    // Drop yesterday's state so a long-running process starts each day clean.
    const state = existing && existing.day === today ? existing : undefined;
    if (existing && !state) deliveryState.delete(goal.id);

    if (responded) {
      deliveryState.delete(goal.id);
      continue;
    }

    // `>=` rather than `===`: a tick can land a minute late, or the process can start
    // after the check-in time, and the reminder must still go out that day.
    const isDue = nowMinutes >= checkInMinutes;
    if (!isDue) continue;

    if (!state) {
      // Anchor the grace window to the scheduled time, not to when this tick ran.
      const dueAt = dayStart(now).getTime() + checkInMinutes * 60_000;
      deliveryState.set(goal.id, { day: today, dueAt, followUpSent: false, failureLogged: false });
      if (outboundMessagingConfigured() && userPhone) {
        const sent = await deliver(userPhone, `Check-in for ${goal.name} is due.`);
        logger.info(
          { goalId: goal.id, sent, channel: process.env.ACCOUNTABILITY_USE_CALLS === "true" ? "call" : "sms" },
          "Check-in reminder processed",
        );
      } else {
        logger.info({ goalId: goal.id, delivery: "disabled" }, "Check-in due; user phone or Twilio number is not configured");
      }
    }

    const currentState = deliveryState.get(goal.id)!;

    if (!currentState.followUpSent && now.getTime() - currentState.dueAt >= GRACE_PERIOD_MS) {
      currentState.followUpSent = true;
      if (outboundMessagingConfigured() && userPhone) {
        const sent = await deliver(userPhone, `Follow-up: check-in for ${goal.name} is still due.`);
        logger.info({ goalId: goal.id, sent }, "Check-in follow-up processed");
      }
    }

    // End of day: anything from 23:59 onward, so a delayed tick cannot skip the miss.
    if (!currentState.failureLogged && nowMinutes >= 23 * 60 + 59) {
      currentState.failureLogged = true;
      // A whole day with no check-in is the largest slip the ladder can describe, so it
      // takes the top configured rung rather than a running count of past consequences.
      const ladder = getLadder();
      const topTier = ladder.length > 0 ? ladder[ladder.length - 1]! : null;
      // Same gate as a reported slip: never issue a rung that describes self-harm.
      const tier = topTier && isInjuriousConsequence(topTier.consequence) ? null : topTier;
      const withheld = topTier !== null && tier === null;
      createEvent({ goalId: goal.id, type: "failure", content: "No check-in response was recorded by the end of day." });
      createEvent({
        goalId: goal.id,
        type: "consequence_issued",
        content: tier
          ? `Missed check-in reaches the ${tier.slipMinutes} min rung: ${tier.consequence}`
          : withheld
            ? `Missed check-in reaches the ${topTier!.slipMinutes} min rung. ${WITHHELD_CONSEQUENCE_NOTE}`
            : "Missed check-in, but no consequence ladder is configured.",
      });
      if (contact.consentConfirmedAt && contact.phoneNumber && outboundMessagingConfigured()) {
        const sent = await deliver(
          contact.phoneNumber,
          `${goal.name} check-in was missed on ${today}.`,
        );
        createEvent({ goalId: goal.id, type: "escalation_sent", content: `Factual escalation sent to ${contact.name}.` });
        logger.info({ goalId: goal.id, sent, contactId: contact.id }, "Accountability contact escalation processed");
      } else {
        logger.info({ goalId: goal.id, delivery: "disabled" }, "Escalation recorded but contact consent or Twilio number is missing");
      }
    }
  }
}

export function startScheduler() {
  const timer = setInterval(() => {
    // An unhandled rejection here would take the whole process down, and the scheduler
    // is the one part of this system that must keep running unattended.
    void runSchedulerTick().catch((err: unknown) => {
      logger.error({ err }, "Scheduler tick failed");
    });
  }, TICK_INTERVAL_MS);
  timer.unref();
  logger.info("Accountability scheduler started");
}
