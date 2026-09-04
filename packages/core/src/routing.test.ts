import { describe, expect, it } from "vitest";

import {
  InvalidRelevanceRouteError,
  requestRelevantEvaluations,
  routeConversationEvents,
} from "./routing.js";
import { InMemoryContactIntentStore } from "./store.js";
import type { ContactIntent, ConversationEvent } from "./types.js";

function intent(
  id: string,
  status: ContactIntent["status"] = "active",
): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id,
    status,
    subject: `Follow up ${id}`,
    reason: "A future outcome may be worth following up.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: `origin-${id}` }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-10T00:00:00.000Z",
    cancellationHints: ["The outcome already happened"],
    priority: 0.8,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function event(id: string): ConversationEvent {
  return {
    id,
    conversationId: "conversation-1",
    actor: "user",
    occurredAt: "2026-09-03T12:00:00.000Z",
    content: "我已经找到实习了，不去双选会了。",
  };
}

describe("routeConversationEvents", () => {
  it("does no routing work without active intents", async () => {
    let calls = 0;
    const result = await routeConversationEvents({
      intents: [intent("candidate", "candidate")],
      events: [event("update")],
      now: "2026-09-03T13:00:00.000Z",
      router: {
        async selectRelevant() {
          calls += 1;
          return [];
        },
      },
    });

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      routerCalled: false,
      activeIntentCount: 0,
      eventCount: 1,
      selections: [],
    });
  });

  it("returns validated bundles without exposing mutable inputs", async () => {
    const active = intent("job-fair");
    const update = event("found-internship");
    const result = await routeConversationEvents({
      intents: [active, intent("candidate", "candidate")],
      events: [update],
      now: "2026-09-03T13:00:00.000Z",
      router: {
        async selectRelevant(input) {
          input.intents[0]!.subject = "router mutation";
          return [{
            intentId: "job-fair",
            eventIds: ["found-internship"],
            effect: "cancel",
            reason: "The new event invalidates the planned follow-up.",
            confidence: 0.99,
          }];
        },
      },
    });

    expect(active.subject).toBe("Follow up job-fair");
    expect(result.routed).toHaveLength(1);
    expect(result.routed[0]).toMatchObject({
      intent: { id: "job-fair", subject: "Follow up job-fair" },
      events: [{ id: "found-internship" }],
      selection: { effect: "cancel", confidence: 0.99 },
    });
  });

  it("rejects hallucinated evidence and duplicate selections", async () => {
    const base = {
      intents: [intent("job-fair")],
      events: [event("found-internship")],
      now: "2026-09-03T13:00:00.000Z",
    };
    await expect(
      routeConversationEvents({
        ...base,
        router: {
          async selectRelevant() {
            return [{
              intentId: "job-fair",
              eventIds: ["invented-event"],
              effect: "cancel" as const,
              reason: "Invalid evidence.",
              confidence: 1,
            }];
          },
        },
      }),
    ).rejects.toThrow(InvalidRelevanceRouteError);

    await expect(
      routeConversationEvents({
        ...base,
        router: {
          async selectRelevant() {
            const selection = {
              intentId: "job-fair",
              eventIds: ["found-internship"],
              effect: "reevaluate" as const,
              reason: "The event may change relevance.",
              confidence: 0.8,
            };
            return [selection, selection];
          },
        },
      }),
    ).rejects.toThrow(InvalidRelevanceRouteError);
  });

  it("rejects future events before calling the router", async () => {
    let calls = 0;
    await expect(
      routeConversationEvents({
        intents: [intent("job-fair")],
        events: [
          {
            ...event("future"),
            occurredAt: "2026-09-04T00:00:00.000Z",
          },
        ],
        now: "2026-09-03T13:00:00.000Z",
        router: {
          async selectRelevant() {
            calls += 1;
            return [];
          },
        },
      }),
    ).rejects.toThrow(InvalidRelevanceRouteError);
    expect(calls).toBe(0);
  });

  it("persists routed work and replays the same route run idempotently", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-job-fair",
    });
    const input = {
      store,
      events: [event("found-internship")],
      now: "2026-09-03T13:00:00.000Z",
      routeRunId: "conversation-batch-1",
      policyVersion: "route-0.1",
      router: {
        async selectRelevant() {
          return [{
            intentId: "job-fair",
            eventIds: ["found-internship"],
            effect: "cancel" as const,
            reason: "The new event invalidates the planned follow-up.",
            confidence: 0.99,
          }];
        },
      },
    };

    const first = await requestRelevantEvaluations(input);
    const replay = await requestRelevantEvaluations(input);

    expect(first.requests[0]?.persistence.outcome).toBe("requested");
    expect(replay.requests[0]?.persistence.outcome).toBe("duplicate");
    expect((await store.getIntent(value.id))?.nextEvaluationAt).toBe(
      "2026-09-03T13:00:00.000Z",
    );
    expect((await store.getIntent(value.id))?.revision).toBe(2);
  });
});
