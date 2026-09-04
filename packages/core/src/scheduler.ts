import type { Clock } from "./clock.js";
import type { ContactIntentStore } from "./store.js";

export type WakeupPlan =
  | {
      state: "idle";
      plannedAt: string;
    }
  | {
      state: "ready";
      plannedAt: string;
      nextEvaluationAt: string;
      intentId: string;
      overdueByMs: number;
    }
  | {
      state: "scheduled";
      plannedAt: string;
      nextEvaluationAt: string;
      intentId: string;
      waitMs: number;
    };

export interface PlanNextWakeupInput {
  store: ContactIntentStore;
  clock: Clock;
}

export async function planNextWakeup(
  input: PlanNextWakeupInput,
): Promise<WakeupPlan> {
  const now = input.clock.now();
  const plannedAt = now.toISOString();
  const [next] = await input.store.listIntents({
    statuses: ["active"],
    scheduledOnly: true,
    limit: 1,
  });
  if (!next || next.nextEvaluationAt === null) {
    return { state: "idle", plannedAt };
  }

  const scheduledTime = Date.parse(next.nextEvaluationAt);
  const delta = scheduledTime - now.getTime();
  if (delta <= 0) {
    return {
      state: "ready",
      plannedAt,
      nextEvaluationAt: next.nextEvaluationAt,
      intentId: next.intent.id,
      overdueByMs: Math.abs(delta),
    };
  }
  return {
    state: "scheduled",
    plannedAt,
    nextEvaluationAt: next.nextEvaluationAt,
    intentId: next.intent.id,
    waitMs: delta,
  };
}
