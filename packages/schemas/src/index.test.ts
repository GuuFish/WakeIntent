import { describe, expect, it } from "vitest";

import {
  validateContactIntent,
  validateContactIntentActivation,
  validateContactIntentEvaluationFailure,
  validateContactIntentEvaluationRequest,
  validateContactPolicySignal,
  validateConversationEvent,
  validateDecision,
} from "./index.js";

const validIntent = {
  schemaVersion: "0.1.0",
  id: "intent-1",
  status: "candidate",
  subject: "Follow up on interview result",
  reason: "The user expects an interview result on Friday.",
  target: { kind: "user", id: "user-1" },
  evidence: [{ eventId: "event-1", quote: "周五应该能收到面试结果" }],
  notBefore: "2026-09-04T09:00:00.000Z",
  expiresAt: "2026-09-11T09:00:00.000Z",
  cancellationHints: ["The user already shared the result"],
  priority: 0.7,
  interruptionCost: 0.3,
  confidence: 0.9,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("public JSON Schemas", () => {
  it("accepts a valid ContactIntent", () => {
    expect(validateContactIntent(validIntent)).toEqual({ valid: true, errors: [] });
  });

  it("rejects a ContactIntent without evidence", () => {
    const result = validateContactIntent({ ...validIntent, evidence: [] });
    expect(result.valid).toBe(false);
  });

  it("accepts an auditable candidate activation", () => {
    expect(
      validateContactIntentActivation({
        id: "activation-1",
        intentId: "intent-1",
        activatedAt: "2026-09-02T00:00:00.000Z",
        reason: "The user confirmed this follow-up should be tracked.",
        evidenceRefs: ["event-confirm"],
        nextEvaluationAt: "2026-09-04T09:00:00.000Z",
        policyVersion: "activation-0.1",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects an activation without a first evaluation time", () => {
    const result = validateContactIntentActivation({
      id: "activation-1",
      intentId: "intent-1",
      activatedAt: "2026-09-02T00:00:00.000Z",
      reason: "Activate it.",
      evidenceRefs: [],
      policyVersion: "activation-0.1",
    });
    expect(result.valid).toBe(false);
  });

  it("accepts a sanitized evaluation failure with a retry schedule", () => {
    expect(
      validateContactIntentEvaluationFailure({
        id: "failure-1",
        intentId: "intent-1",
        failedAt: "2026-09-04T10:00:00.000Z",
        stage: "semantic",
        code: "ModelProtocolError",
        attempt: 1,
        exhausted: false,
        nextEvaluationAt: "2026-09-04T10:01:00.000Z",
        policyVersion: "default-0.1",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects an unsupported evaluation failure stage", () => {
    const result = validateContactIntentEvaluationFailure({
      id: "failure-1",
      intentId: "intent-1",
      failedAt: "2026-09-04T10:00:00.000Z",
      stage: "delivery",
      code: "NetworkError",
      attempt: 1,
      exhausted: false,
      nextEvaluationAt: "2026-09-04T10:01:00.000Z",
      policyVersion: "default-0.1",
    });
    expect(result.valid).toBe(false);
  });

  it("accepts an event-backed evaluation request", () => {
    expect(
      validateContactIntentEvaluationRequest({
        id: "request-1",
        intentId: "intent-1",
        requestedAt: "2026-09-03T12:00:00.000Z",
        eventIds: ["found-internship"],
        effect: "cancel",
        reason: "The new event may invalidate the planned follow-up.",
        confidence: 0.98,
        nextEvaluationAt: "2026-09-03T12:00:00.000Z",
        policyVersion: "route-0.1",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects an evaluation request with duplicate evidence", () => {
    const result = validateContactIntentEvaluationRequest({
      id: "request-1",
      intentId: "intent-1",
      requestedAt: "2026-09-03T12:00:00.000Z",
      eventIds: ["event-1", "event-1"],
      effect: "reevaluate",
      reason: "The event may change relevance.",
      confidence: 0.8,
      nextEvaluationAt: "2026-09-03T12:00:00.000Z",
      policyVersion: "route-0.1",
    });
    expect(result.valid).toBe(false);
  });

  it("accepts a global do-not-disturb policy signal", () => {
    expect(
      validateContactPolicySignal({
        schemaVersion: "0.1.0",
        id: "policy-1",
        kind: "set-do-not-disturb",
        evidenceRef: "event-dnd",
        occurredAt: "2026-09-03T08:00:00.000Z",
        reason: "The user asked not to be contacted this week.",
        doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects a do-not-disturb signal without an end boundary", () => {
    const result = validateContactPolicySignal({
      schemaVersion: "0.1.0",
      id: "policy-1",
      kind: "set-do-not-disturb",
      evidenceRef: "event-dnd",
      occurredAt: "2026-09-03T08:00:00.000Z",
      reason: "The user asked not to be contacted this week.",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects fields from a different policy-signal variant", () => {
    const result = validateContactPolicySignal({
      schemaVersion: "0.1.0",
      id: "policy-clear",
      kind: "clear-do-not-disturb",
      evidenceRef: "event-clear",
      occurredAt: "2026-09-04T08:00:00.000Z",
      reason: "Normal contact can resume.",
      authorization: "granted",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects out-of-range confidence", () => {
    const result = validateContactIntent({ ...validIntent, confidence: 1.1 });
    expect(result.valid).toBe(false);
  });

  it("accepts a normalized conversation event", () => {
    expect(
      validateConversationEvent({
        id: "event-1",
        conversationId: "conversation-1",
        actor: "user",
        occurredAt: "2026-09-01T00:00:00.000Z",
        content: "周五应该能收到面试结果",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("accepts a silent decision without pretending it was delivered", () => {
    expect(
      validateDecision({
        id: "decision-1",
        intentId: "intent-1",
        evaluatedAt: "2026-09-04T10:00:00.000Z",
        action: "silent",
        reason: "There is not enough value to interrupt the user now.",
        evidenceRefs: ["event-1"],
        counterEvidenceRefs: [],
        confidence: 0.8,
        nextEvaluationAt: null,
        policyVersion: "default-0.1",
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it("rejects a decision action outside the public contract", () => {
    const result = validateDecision({
      id: "decision-1",
      intentId: "intent-1",
      evaluatedAt: "2026-09-04T10:00:00.000Z",
      action: "delivered",
      reason: "This is not a decision action.",
      evidenceRefs: [],
      counterEvidenceRefs: [],
      confidence: 1,
      nextEvaluationAt: null,
      policyVersion: "default-0.1",
    });
    expect(result.valid).toBe(false);
  });
});
