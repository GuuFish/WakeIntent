import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import {
  activateIntent,
  applyDecision,
  InvalidIntentTransitionError,
} from "./lifecycle.js";
import type { ContactDecision, ContactIntent } from "./types.js";

const createdAt = "2026-09-01T00:00:00.000Z";

function candidateIntent(): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id: "intent-1",
    status: "candidate",
    subject: "Follow up on interview result",
    reason: "The user expects an interview result on Friday.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: "event-1", quote: "周五应该能收到面试结果" }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The user already shared the result", "Do not ask again"],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt,
    updatedAt: createdAt,
  };
}

function decision(action: ContactDecision["action"]): ContactDecision {
  return {
    id: `decision-${action}`,
    intentId: "intent-1",
    evaluatedAt: "2026-09-04T10:00:00.000Z",
    action,
    reason: `Test ${action}`,
    evidenceRefs: ["event-1"],
    counterEvidenceRefs: [],
    confidence: 1,
    nextEvaluationAt: action === "defer" ? "2026-09-05T10:00:00.000Z" : null,
    policyVersion: "test-policy-1",
  };
}

describe("ContactIntent lifecycle", () => {
  it("activates a candidate without mutating the original", () => {
    const original = candidateIntent();
    const active = activateIntent(original, "2026-09-01T01:00:00.000Z");

    expect(original.status).toBe("candidate");
    expect(active.status).toBe("active");
    expect(active.updatedAt).toBe("2026-09-01T01:00:00.000Z");
  });

  it.each([
    ["cancel", "cancelled"],
    ["expire", "expired"],
    ["resolve", "resolved"],
  ] as const)("maps %s to terminal status %s", (action, expectedStatus) => {
    const active = activateIntent(candidateIntent(), createdAt);
    expect(applyDecision(active, decision(action)).status).toBe(expectedStatus);
  });

  it.each(["contact", "defer", "silent"] as const)(
    "keeps the intent active after a %s decision",
    (action) => {
      const active = activateIntent(candidateIntent(), createdAt);
      expect(applyDecision(active, decision(action)).status).toBe("active");
    },
  );

  it("rejects reevaluation of a terminal intent", () => {
    const active = activateIntent(candidateIntent(), createdAt);
    const cancelled = applyDecision(active, decision("cancel"));

    expect(() => applyDecision(cancelled, decision("contact"))).toThrow(
      InvalidIntentTransitionError,
    );
  });

  it("advances time deterministically", () => {
    const clock = new FakeClock("2026-09-01T00:00:00.000Z");
    clock.advance(60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe("2026-09-01T01:00:00.000Z");
  });
});

