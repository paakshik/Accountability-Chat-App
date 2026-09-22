import { logger } from "./logger";
import { getGoals } from "./accountability-store";

export function runSchedulerTick() {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const dueGoals = getGoals().filter(
    (goal) =>
      ["active", "locked"].includes(goal.status) &&
      goal.checkInTime === currentTime,
  );

  for (const goal of dueGoals) {
    logger.info(
      { goalId: goal.id, goalName: goal.name, delivery: "disabled" },
      "Check-in due; outbound delivery is not configured",
    );
  }
}

export function startScheduler() {
  const timer = setInterval(runSchedulerTick, 60_000);
  timer.unref();
  logger.info("Accountability scheduler started");
}