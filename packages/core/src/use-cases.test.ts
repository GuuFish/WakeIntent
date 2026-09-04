import { describe, expect, it, vi } from "vitest";

import { FakeClock } from "./clock.js";
import type { ContactIntent, ConversationEvent } from "./types.js";
import {
  extractContactIntents,
  InvalidUseCaseInputError,
  reevaluateContactIntent,
  type CandidateDraft,
  type CandidateGenerator,
  type IdGenerator,
  type SemanticDecisionProposal,
  type SemanticReevaluator,
} from "./use-cases.js";

const initialEvent: ConversationEvent = {
  id: "event-1",
  conversationId: "conversation-1",
  actor: "user",
  occurredAt: "2026-09-01T00:00:00.000Z",
  content: "周五应该能收到面试结果",
};

function draft(overrides: Partial<CandidateDraft> = {}): CandidateDraft {
  return {
    subject: "Follow up on interview result",
    reason: "The user expects an interview result on Friday.",
    evidence: [{ eventId: "event-1" }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The user already shared the result"],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    ...overrides,
  };
}

function ids(): IdGenerator {
  let count = 0;
  return (kind) => `${kind}-${++count}`;
}

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

function staticGenerator(...drafts: CandidateDraft[]): CandidateGenerator {
  return { generate: vi.fn().mockResolvedValue(drafts) };
}

function staticReevaluator(
  proposal: SemanticDecisionProposal,
): SemanticReevaluator {
  return { evaluate: vi.fn().mockResolvedValue(proposal) };
}

describe("extractContactIntents", () => {
  it("creates an active intent when confidence reaches the policy threshold", async () => {
    const result = await extractContactIntents({
      events: [initialEvent],
      target: { kind: "user", id: "user-1" },
      clock: new FakeClock("2026-09-01T00:01:00.000Z"),
      idGenerator: ids(),
      generator: staticGenerator(draft()),
      policy: { activationThreshold: 0.8 },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "intent-1",
      status: "active",
      createdAt: "2026-09-01T00:01:00.000Z",
    });
  });

  it("keeps a low-confidence extraction as a candidate", async () => {
    const result = await extractContactIntents({
      events: [initialEvent],
      target: { kind: "user", id: "user-1" },
      clock: new FakeClock("2026-09-01T00:01:00.000Z"),
      idGenerator: ids(),
      generator: staticGenerator(draft({ confidence: 0.5 })),
      policy: { activationThreshold: 0.8 },
    });
    expect(result[0]?.status).toBe("candidate");
  });

  it("rejects model evidence that is not in the input conversation", async () => {
    await expect(
      extractContactIntents({
        events: [initialEvent],
        target: { kind: "user", id: "user-1" },
        clock: new FakeClock("2026-09-01T00:01:00.000Z"),
        idGenerator: ids(),
        generator: staticGenerator(
          draft({ evidence: [{ eventId: "hallucinated-event" }] }),
        ),
        policy: { activationThreshold: 0.8 },
      }),
    ).rejects.toThrow(InvalidUseCaseInputError);
  });

  it("accepts a conversation that creates no intent", async () => {
    const result = await extractContactIntents({
      events: [initialEvent],
      target: { kind: "user", id: "user-1" },
      clock: new FakeClock("2026-09-01T00:01:00.000Z"),
      idGenerator: ids(),
      generator: staticGenerator(),
      policy: { activationThreshold: 0.8 },
    });
    expect(result).toEqual([]);
  });
});

describe("reevaluateContactIntent", () => {
  it("uses a hard gate without calling semantic evaluation", async () => {
    const reevaluator = staticReevaluator({
      action: "contact",
      reason: "This result must never be used.",
      evidenceRefs: ["event-1"],
      counterEvidenceRefs: [],
      confidence: 1,
      nextEvaluationAt: null,
    });
    const result = await reevaluateContactIntent({
      intent: activeIntent(),
      latestEvents: [],
      clock: new FakeClock("2026-09-12T00:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: reevaluator,
    });

    expect(result.source).toBe("hard-gate");
    expect(result.decision.action).toBe("expire");
    expect(result.intent.status).toBe("expired");
    expect(reevaluator.evaluate).not.toHaveBeenCalled();
  });

  it("resolves an intent when new conversation supplies the result", async () => {
    const latestEvent: ConversationEvent = {
      id: "event-result",
      conversationId: "conversation-1",
      actor: "user",
      occurredAt: "2026-09-04T09:30:00.000Z",
      content: "拿到 offer 了",
    };
    const result = await reevaluateContactIntent({
      intent: activeIntent(),
      latestEvents: [latestEvent],
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: staticReevaluator({
        action: "resolve",
        reason: "The user already shared the interview result.",
        evidenceRefs: ["event-1"],
        counterEvidenceRefs: ["event-result"],
        confidence: 0.98,
        nextEvaluationAt: null,
      }),
    });

    expect(result.source).toBe("semantic");
    expect(result.decision.action).toBe("resolve");
    expect(result.intent.status).toBe("resolved");
  });

  it("recognizes semantic resolution before the contact window opens", async () => {
    const latestEvent: ConversationEvent = {
      id: "event-result",
      conversationId: "conversation-1",
      actor: "user",
      occurredAt: "2026-09-04T09:30:00.000Z",
      content: "拿到 offer 了，不用再问",
    };
    const result = await reevaluateContactIntent({
      intent: activeIntent({ notBefore: "2026-09-05T00:00:00.000Z" }),
      latestEvents: [latestEvent],
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: staticReevaluator({
        action: "resolve",
        reason: "The user already shared the interview result.",
        evidenceRefs: ["event-1"],
        counterEvidenceRefs: ["event-result"],
        confidence: 0.98,
        nextEvaluationAt: null,
      }),
    });

    expect(result.source).toBe("semantic");
    expect(result.decision.action).toBe("resolve");
    expect(result.intent.status).toBe("resolved");
  });

  it("does not let a semantic contact decision bypass the contact window", async () => {
    const reevaluator = staticReevaluator({
      action: "contact",
      reason: "The follow-up still appears useful.",
      evidenceRefs: ["event-1"],
      counterEvidenceRefs: ["event-update"],
      confidence: 0.8,
      nextEvaluationAt: null,
    });
    const result = await reevaluateContactIntent({
      intent: activeIntent({ notBefore: "2026-09-05T00:00:00.000Z" }),
      latestEvents: [
        {
          id: "event-update",
          conversationId: "conversation-1",
          actor: "user",
          occurredAt: "2026-09-04T09:30:00.000Z",
          content: "现在还没有消息",
        },
      ],
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: reevaluator,
    });

    expect(reevaluator.evaluate).toHaveBeenCalledOnce();
    expect(result.source).toBe("hard-gate");
    expect(result.decision.action).toBe("defer");
    expect(result.decision.nextEvaluationAt).toBe("2026-09-05T00:00:00.000Z");
    expect(result.decision.counterEvidenceRefs).toContain("event-update");
  });

  it("keeps the later semantic defer time when contact eligibility also defers", async () => {
    const result = await reevaluateContactIntent({
      intent: activeIntent({ notBefore: "2026-09-05T00:00:00.000Z" }),
      latestEvents: [
        {
          id: "event-update",
          conversationId: "conversation-1",
          actor: "user",
          occurredAt: "2026-09-04T09:30:00.000Z",
          content: "结果改到下周一才会出来",
        },
      ],
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: staticReevaluator({
        action: "defer",
        reason: "The expected result moved to next week.",
        evidenceRefs: ["event-1"],
        counterEvidenceRefs: ["event-update"],
        confidence: 0.9,
        nextEvaluationAt: "2026-09-07T10:00:00.000Z",
      }),
      evaluationTrigger: "context-change",
    });

    expect(result.source).toBe("hard-gate");
    expect(result.decision.action).toBe("defer");
    expect(result.decision.nextEvaluationAt).toBe("2026-09-07T10:00:00.000Z");
    expect(result.decision.metadata).toMatchObject({
      semanticProposalAction: "defer",
      semanticProposalNextEvaluationAt: "2026-09-07T10:00:00.000Z",
    });
  });

  it("keeps an intent active after choosing silence", async () => {
    const result = await reevaluateContactIntent({
      intent: activeIntent(),
      latestEvents: [],
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      idGenerator: ids(),
      policyVersion: "default-0.1",
      userState: { authorization: "granted", remainingContactBudget: 1 },
      semanticReevaluator: staticReevaluator({
        action: "silent",
        reason: "There is not enough value to interrupt the user now.",
        evidenceRefs: ["event-1"],
        counterEvidenceRefs: [],
        confidence: 0.8,
        nextEvaluationAt: null,
      }),
    });

    expect(result.decision.action).toBe("silent");
    expect(result.intent.status).toBe("active");
  });

  it("rejects a semantic decision that cites invented evidence", async () => {
    await expect(
      reevaluateContactIntent({
        intent: activeIntent(),
        latestEvents: [],
        clock: new FakeClock("2026-09-04T10:00:00.000Z"),
        idGenerator: ids(),
        policyVersion: "default-0.1",
        userState: { authorization: "granted", remainingContactBudget: 1 },
        semanticReevaluator: staticReevaluator({
          action: "contact",
          reason: "Invented evidence should fail.",
          evidenceRefs: ["invented-event"],
          counterEvidenceRefs: [],
          confidence: 0.9,
          nextEvaluationAt: null,
        }),
      }),
    ).rejects.toThrow(InvalidUseCaseInputError);
  });
});
