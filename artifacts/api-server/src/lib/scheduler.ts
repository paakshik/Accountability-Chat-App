import { logger } from "./logger";
import {
  createEvent,
  getContact,
  getEventsForGoalSince,
  getGoals,
  getLadder,
  getSchedulerState,
  isInjuriousConsequence,
  markSchedulerState,
  pruneSchedulerState,
  WITHHELD_CONSEQUENCE_NOTE,
} from "./accountability-store";
import { outboundMessagingConfigured, placeCall, sendSms } from "./twilio";

const GRACE_PERIOD_MS = 30 * 60 * 1000;
const TICK_INTERVAL_MS = 60_000;

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

  // Yesterday's rows are never read again.
  pruneSchedulerState(today);

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
    if (responded) continue;

    // `>=` rather than `===`: a tick can land a minute late, or the process can start
    // after the check-in time, and the reminder must still go out that day.
    if (nowMinutes < checkInMinutes) continue;

    const state = getSchedulerState(goal.id, today);
    const dueAt = dayStart(now).getTime() + checkInMinutes * 60_000;
    const pastGrace = now.getTime() - dueAt >= GRACE_PERIOD_MS;
    const canDeliver = outboundMessagingConfigured() && Boolean(userPhone);

    // First time we notice this goal today.
    if (!state.remindedAt) {
      // If the grace window has already elapsed — a late start, or a restart in the
      // evening — send one accurate message instead of a reminder and a follow-up
      // back to back, and record both as handled.
      const message = pastGrace
        ? `Follow-up: check-in for ${goal.name} is still due.`
        : `Check-in for ${goal.name} is due.`;

      if (canDeliver) {
        const sent = await deliver(userPhone!, message);
        logger.info(
          { goalId: goal.id, sent, collapsed: pastGrace, channel: process.env.ACCOUNTABILITY_USE_CALLS === "true" ? "call" : "sms" },
          "Check-in reminder processed",
        );
      } else {
        logger.info({ goalId: goal.id, delivery: "disabled" }, "Check-in due; user phone or Twilio number is not configured");
      }
      // Marked even when delivery is off, so a later restart does not re-chase it.
      markSchedulerState(goal.id, today, { remindedAt: true, followedUpAt: pastGrace });
    } else if (!state.followedUpAt && pastGrace) {
      if (canDeliver) {
        const sent = await deliver(userPhone!, `Follow-up: check-in for ${goal.name} is still due.`);
        logger.info({ goalId: goal.id, sent }, "Check-in follow-up processed");
      }
      markSchedulerState(goal.id, today, { followedUpAt: true });
    }

    // End of day: anything from 23:59 onward, so a delayed tick cannot skip the miss.
    if (!getSchedulerState(goal.id, today).failedAt && nowMinutes >= 23 * 60 + 59) {
      markSchedulerState(goal.id, today, { failedAt: true });

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
        const sent = await deliver(contact.phoneNumber, `${goal.name} check-in was missed on ${today}.`);
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
