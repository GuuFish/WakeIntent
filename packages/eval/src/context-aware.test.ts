import { describe, expect, it } from "vitest";
import { ContextAwareBaseline, recentContext } from "./context-aware.js";

const events = Array.from({ length: 10 }, (_, index) => ({
  id: "event-" + index,
  conversationId: "conversation",
  actor: "user" as const,
  occurredAt: new Date(Date.UTC(2026, 8, 5, 0, index)).toISOString(),
  content: "message " + index,
}));

describe("context-aware baseline", () => {
  it("uses the same bounded recent raw context selected for both arms", () => {
    expect(recentContext(events, "2026-09-05T00:08:30.000Z").map((event) => event.id))
      .toEqual(["event-1", "event-2", "event-3", "event-4", "event-5", "event-6", "event-7", "event-8"]);
  });

  it("accepts grounded direct decisions", async () => {
    const baseline = new ContextAwareBaseline({
      async generate<T>() {
        return { decisions: [{
          action: "contact" as const,
          kind: "intent_driven" as const,
          recognition: "open" as const,
          reason: "The promised follow-up is due.",
          evidenceRefs: ["event-0"],
          nextEvaluationAt: null,
        }] } as T;
      },
    });
    await expect(baseline.decide({
      events: events.slice(0, 1),
      now: "2026-09-06T00:00:00.000Z",
      timeZone: "UTC",
      userState: { authorization: "granted" },
      deliveries: [],
    })).resolves.toHaveLength(1);
  });

  it("rejects contacts that cite no supplied evidence", async () => {
    const baseline = new ContextAwareBaseline({
      async generate<T>() {
        return { decisions: [{
          action: "contact" as const,
          kind: "spontaneous" as const,
          recognition: "none" as const,
          reason: "Say hello.",
          evidenceRefs: [],
          nextEvaluationAt: null,
        }] } as T;
      },
    });
    await expect(baseline.decide({
      events: events.slice(0, 1),
      now: "2026-09-06T00:00:00.000Z",
      timeZone: "UTC",
      userState: { authorization: "granted" },
      deliveries: [],
    })).rejects.toThrow("Ungrounded baseline contact");
  });
});
