import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import { planNextWakeup } from "./scheduler.js";
import { InMemoryContactIntentStore } from "./store.js";
import type { ContactIntent } from "./types.js";

function intent(
  id: string,
  status: ContactIntent["status"] = "active",
): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id,
    status,
    subject: `Follow up ${id}`,
    reason: "A future follow-up may be useful.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: `event-${id}` }],
    notBefore: null,
    expiresAt: null,
    cancellationHints: [],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("planNextWakeup", () => {
  it("returns idle when there is no scheduled active intent", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("candidate", "candidate"),
      nextEvaluationAt: null,
      idempotencyKey: "create-candidate",
    });
    await store.createIntent({
      intent: intent("unscheduled"),
      nextEvaluationAt: null,
      idempotencyKey: "create-unscheduled",
    });

    await expect(
      planNextWakeup({
        store,
        clock: new FakeClock("2026-09-02T00:00:00.000Z"),
      }),
    ).resolves.toEqual({
      state: "idle",
      plannedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("plans only the earliest future wakeup", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("later"),
      nextEvaluationAt: "2026-09-04T12:00:00.000Z",
      idempotencyKey: "create-later",
    });
    await store.createIntent({
      intent: intent("first"),
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-first",
    });

    await expect(
      planNextWakeup({
        store,
        clock: new FakeClock("2026-09-04T08:00:00.000Z"),
      }),
    ).resolves.toEqual({
      state: "scheduled",
      plannedAt: "2026-09-04T08:00:00.000Z",
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      intentId: "first",
      waitMs: 60 * 60 * 1000,
    });
  });

  it("asks the host to run now when the earliest wakeup is overdue", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("due"),
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-due",
    });

    await expect(
      planNextWakeup({
        store,
        clock: new FakeClock("2026-09-04T09:15:00.000Z"),
      }),
    ).resolves.toEqual({
      state: "ready",
      plannedAt: "2026-09-04T09:15:00.000Z",
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      intentId: "due",
      overdueByMs: 15 * 60 * 1000,
    });
  });
});
