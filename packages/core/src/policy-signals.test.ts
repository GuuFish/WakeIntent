import { describe, expect, it } from "vitest";
import { evaluateHardGates } from "./hard-gates.js";
import type { ContactIntent } from "./types.js";
import {
  applyContactPolicySignals,
  InvalidContactPolicySignalError,
  type ContactPolicySignal,
  type ContactPolicySnapshot,
} from "./policy-signals.js";

const initialSnapshot = (): ContactPolicySnapshot => ({
  state: { authorization: "granted", remainingContactBudget: 2 },
  appliedSignalIds: [],
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const dndSignal = (
  overrides: Partial<ContactPolicySignal> = {},
): ContactPolicySignal => ({
  schemaVersion: "0.1.0",
  id: "policy-1",
  kind: "set-do-not-disturb",
  evidenceRef: "event-dnd",
  occurredAt: "2026-09-03T08:00:00.000Z",
  reason: "The user asked not to be contacted this week.",
  doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
  ...overrides,
} as ContactPolicySignal);

const activeIntent = (id: string, notBefore: string): ContactIntent => ({
  schemaVersion: "0.1.0",
  id,
  status: "active",
  subject: id,
  reason: "Future follow-up",
  target: { kind: "user", id: "user" },
  evidence: [{ eventId: `${id}-source` }],
  notBefore,
  expiresAt: null,
  cancellationHints: [],
  priority: 0.5,
  interruptionCost: 0.2,
  confidence: 0.9,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("applyContactPolicySignals", () => {
  it("sets a global do-not-disturb boundary without changing budget or authorization", () => {
    const result = applyContactPolicySignals({
      snapshot: initialSnapshot(),
      signals: [dndSignal()],
      now: new Date("2026-09-03T09:00:00.000Z"),
    });

    expect(result.snapshot.state).toEqual({
      authorization: "granted",
      remainingContactBudget: 2,
      doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
    });
    expect(result.snapshot.appliedSignalIds).toEqual(["policy-1"]);
    expect(result.audits[0]).toMatchObject({
      outcome: "applied",
      evidenceRef: "event-dnd",
      before: { authorization: "granted" },
      after: { doNotDisturbUntil: "2026-09-07T00:00:00.000Z" },
    });
  });

  it("clears do-not-disturb and preserves the other policy fields", () => {
    const snapshot = initialSnapshot();
    snapshot.state.doNotDisturbUntil = "2026-09-07T00:00:00.000Z";
    const result = applyContactPolicySignals({
      snapshot,
      signals: [{
        schemaVersion: "0.1.0",
        id: "policy-clear",
        kind: "clear-do-not-disturb",
        evidenceRef: "event-clear",
        occurredAt: "2026-09-04T08:00:00.000Z",
        reason: "The user said normal contact can resume.",
      }],
      now: new Date("2026-09-04T08:00:00.000Z"),
    });

    expect(result.snapshot.state).toEqual({
      authorization: "granted",
      remainingContactBudget: 2,
    });
  });

  it("broadcasts one policy state through hard gates without per-intent routing", () => {
    const policy = applyContactPolicySignals({
      snapshot: initialSnapshot(),
      signals: [dndSignal()],
      now: new Date("2026-09-03T09:00:00.000Z"),
    }).snapshot.state;
    const intents = [
      activeIntent("job-fair", "2026-09-04T10:00:00.000Z"),
      activeIntent("parcel", "2026-09-06T12:00:00.000Z"),
    ];

    const decisions = intents.map((intent, index) =>
      evaluateHardGates(intent, {
        decisionId: `decision-${index}`,
        policyVersion: "policy-signal-0.1",
        now: new Date("2026-09-03T09:00:00.000Z"),
        userState: policy,
      }),
    );

    expect(decisions).toHaveLength(2);
    for (const result of decisions) {
      expect(result).toMatchObject({
        outcome: "decided",
        decision: {
          action: "defer",
          nextEvaluationAt: "2026-09-07T00:00:00.000Z",
        },
      });
    }
  });

  it("changes global proactive-contact authorization", () => {
    const result = applyContactPolicySignals({
      snapshot: initialSnapshot(),
      signals: [{
        schemaVersion: "0.1.0",
        id: "policy-deny",
        kind: "set-authorization",
        authorization: "denied",
        evidenceRef: "event-deny",
        occurredAt: "2026-09-03T08:00:00.000Z",
        reason: "The user withdrew proactive-contact permission.",
      }],
      now: new Date("2026-09-03T08:00:00.000Z"),
    });

    expect(result.snapshot.state.authorization).toBe("denied");
  });

  it("treats a replayed signal as an idempotent duplicate", () => {
    const first = applyContactPolicySignals({
      snapshot: initialSnapshot(),
      signals: [dndSignal()],
      now: new Date("2026-09-03T09:00:00.000Z"),
    });
    const replay = applyContactPolicySignals({
      snapshot: first.snapshot,
      signals: [dndSignal()],
      now: new Date("2026-09-03T10:00:00.000Z"),
    });

    expect(replay.snapshot).toEqual(first.snapshot);
    expect(replay.audits[0]?.outcome).toBe("duplicate");
  });

  it("records an already elapsed do-not-disturb signal without retaining stale state", () => {
    const result = applyContactPolicySignals({
      snapshot: initialSnapshot(),
      signals: [dndSignal()],
      now: new Date("2026-09-08T00:00:00.000Z"),
    });

    expect(result.snapshot.state.doNotDisturbUntil).toBeUndefined();
    expect(result.audits[0]?.outcome).toBe("expired");
  });

  it("rejects a new signal older than the snapshot", () => {
    const snapshot = initialSnapshot();
    snapshot.updatedAt = "2026-09-04T00:00:00.000Z";
    expect(() =>
      applyContactPolicySignals({
        snapshot,
        signals: [dndSignal()],
        now: new Date("2026-09-04T09:00:00.000Z"),
      }),
    ).toThrow(InvalidContactPolicySignalError);
  });

  it("rejects a do-not-disturb boundary that does not follow its source event", () => {
    expect(() =>
      applyContactPolicySignals({
        snapshot: initialSnapshot(),
        signals: [
          dndSignal({ doNotDisturbUntil: "2026-09-03T07:00:00.000Z" } as Partial<ContactPolicySignal>),
        ],
        now: new Date("2026-09-03T09:00:00.000Z"),
      }),
    ).toThrow("doNotDisturbUntil must be later than signal.occurredAt");
  });
});
