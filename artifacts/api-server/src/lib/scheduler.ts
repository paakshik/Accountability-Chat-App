import { logger } from "./logger";
import {
  createEvent,
  getContact,
  getEvents,
  getEventsForGoalSince,
  getGoals,
  getLadder,
} from "./accountability-store";
import { outboundMessagingConfigured, placeCall, sendSms } from "./twilio";

const deliveryState = new Map<number, { dueAt: number; followUpSent: boolean; failureLogged: boolean }>();

function dayStart(now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

async function deliver(to: string, message: string) {
  if (process.env.ACCOUNTABILITY_USE_CALLS === "true") return placeCall(to, message);
  return sendSms(to, message);
}

export async function runSchedulerTick() {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const today = dayStart(now).toISOString();
  const contact = getContact();
  const userPhone = process.env.ACCOUNTABILITY_USER_PHONE;
  const dueGoals = getGoals().filter((goal) => ["active", "locked"].includes(goal.status) && goal.checkInTime);

  for (const goal of dueGoals) {
    const goalEvents = getEventsForGoalSince(goal.id, today);
    const state = deliveryState.get(goal.id);
    const isDue = goal.checkInTime === currentTime;
    if (isDue && !state) {
      const dueAt = now.getTime();
      deliveryState.set(goal.id, { dueAt, followUpSent: false, failureLogged: false });
      if (outboundMessagingConfigured() && userPhone) {
        const sent = await deliver(userPhone, `Check-in for ${goal.name} is due.`);
        logger.info({ goalId: goal.id, sent, channel: process.env.ACCOUNTABILITY_USE_CALLS === "true" ? "call" : "sms" }, "Check-in reminder processed");
      } else {
        logger.info({ goalId: goal.id, delivery: "disabled" }, "Check-in due; user phone or Twilio number is not configured");
      }
    }

    const currentState = deliveryState.get(goal.id);
    if (!currentState) continue;

    const responded = goalEvents.some((event) => event.type === "check_in");
    if (responded) {
      deliveryState.delete(goal.id);
      continue;
    }

    if (!currentState.followUpSent && now.getTime() - currentState.dueAt >= 30 * 60 * 1000) {
      currentState.followUpSent = true;
      if (outboundMessagingConfigured() && userPhone) {
        const sent = await deliver(userPhone, `Follow-up: check-in for ${goal.name} is still due.`);
        logger.info({ goalId: goal.id, sent }, "Check-in follow-up processed");
      }
    }

    if (!currentState.failureLogged && now.getHours() === 23 && now.getMinutes() === 59) {
      currentState.failureLogged = true;
      const tier = getLadder()[Math.min(getEvents(100).filter((event) => event.type === "consequence_issued").length, getLadder().length - 1)];
      createEvent({ goalId: goal.id, type: "failure", content: "No check-in response was recorded by the end of day." });
      createEvent({ goalId: goal.id, type: "consequence_issued", content: `Applicable predefined consequence: ${tier}` });
      if (contact.consentConfirmedAt && contact.phoneNumber && outboundMessagingConfigured()) {
        const sent = await deliver(contact.phoneNumber, `${goal.name} check-in was missed today.`);
        createEvent({ goalId: goal.id, type: "escalation_sent", content: `Factual escalation sent to ${contact.name}.` });
        logger.info({ goalId: goal.id, sent, contactId: contact.id }, "Accountability contact escalation processed");
      } else {
        logger.info({ goalId: goal.id, delivery: "disabled" }, "Escalation recorded but contact consent or Twilio number is missing");
      }
    }
  }
}

export function startScheduler() {
  const timer = setInterval(runSchedulerTick, 60_000);
  timer.unref();
  logger.info("Accountability scheduler started");
}