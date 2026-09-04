import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import {
  evaluateContactEligibilityGates,
  evaluateHardGates,
  evaluateValidityGates,
  InvalidHardGateInputError,
  type HardGateContext,
} from "./hard-gates.js";
import type { ContactIntent } from "./types.js";

function activeIntent(overrides: Partial<ContactIntent> = {}): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id: "intent-1",
    status: "active",
    subject: "Follow up on interview result",
    reason: "The user expects an interview result on Friday.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: "event-1" }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The user already shared the result"],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function gateContext(
  clock: FakeClock,
  overrides: Partial<HardGateContext> = {},
): HardGateContext {
  return {
    decisionId: "decision-1",
    policyVersion: "default-0.1",
    now: clock.now(),
    userState: { authorization: "granted", remainingContactBudget: 1 },
    ...overrides,
  };
}

function decidedAction(result: ReturnType<typeof evaluateHardGates>): string {
  if (result.outcome !== "decided") {
    throw new Error("Expected a hard-gate decision");
  }
  return result.decision.action;
}

describe("deterministic hard gates", () => {
  it("separates intent validity from current contact eligibility", () => {
    const clock = new FakeClock("2026-09-03T10:00:00.000Z");
    const intent = activeIntent();
    const context = gateContext(clock);

    expect(evaluateValidityGates(intent, context)).toEqual({
      outcome: "continue",
    });
    expect(decidedAction(evaluateContactEligibilityGates(intent, context))).toBe(
      "defer",
    );
  });

  it("lets explicit cancellation win even when the intent is expired", () => {
    const clock = new FakeClock("2026-09-12T00:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, {
        cancellation: {
          reason: "The user said not to ask again.",
          evidenceRef: "event-cancel",
        },
      }),
    );

    expect(decidedAction(result)).toBe("cancel");
    if (result.outcome === "decided") {
      expect(result.decision.counterEvidenceRefs).toEqual(["event-cancel"]);
    }
  });

  it("expires exactly at the expiry boundary", () => {
    const clock = new FakeClock("2026-09-11T09:00:00.000Z");
    expect(decidedAction(evaluateHardGates(activeIntent(), gateContext(clock)))).toBe(
      "expire",
    );
  });

  it("cancels when proactive contact permission is denied", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, { userState: { authorization: "denied" } }),
    );
    expect(decidedAction(result)).toBe("cancel");
  });

  it("stays silent when proactive contact permission is unknown", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, { userState: { authorization: "unknown" } }),
    );
    expect(decidedAction(result)).toBe("silent");
  });

  it("defers until the latest temporal blocker", () => {
    const clock = new FakeClock("2026-09-04T08:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, {
        userState: {
          authorization: "granted",
          doNotDisturbUntil: "2026-09-04T12:00:00.000Z",
          remainingContactBudget: 1,
        },
      }),
    );

    expect(decidedAction(result)).toBe("defer");
    if (result.outcome === "decided") {
      expect(result.decision.nextEvaluationAt).toBe("2026-09-04T12:00:00.000Z");
    }
  });

  it("defers until the budget resets", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, {
        userState: {
          authorization: "granted",
          remainingContactBudget: 0,
          budgetResetsAt: "2026-09-05T00:00:00.000Z",
        },
      }),
    );

    expect(decidedAction(result)).toBe("defer");
    if (result.outcome === "decided") {
      expect(result.decision.nextEvaluationAt).toBe("2026-09-05T00:00:00.000Z");
    }
  });

  it("stays silent when an exhausted budget has no reset", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    const result = evaluateHardGates(
      activeIntent(),
      gateContext(clock, {
        userState: { authorization: "granted", remainingContactBudget: 0 },
      }),
    );
    expect(decidedAction(result)).toBe("silent");
  });

  it("continues when all deterministic gates allow evaluation", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    expect(evaluateHardGates(activeIntent(), gateContext(clock))).toEqual({
      outcome: "continue",
    });
  });

  it("rejects an invalid depleted budget reset", () => {
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    expect(() =>
      evaluateHardGates(
        activeIntent(),
        gateContext(clock, {
          userState: {
            authorization: "granted",
            remainingContactBudget: 0,
            budgetResetsAt: "2026-09-04T09:00:00.000Z",
          },
        }),
      ),
    ).toThrow(InvalidHardGateInputError);
  });
});
