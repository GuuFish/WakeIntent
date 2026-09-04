import { describe, expect, it } from "vitest";

import { activateIntent } from "./lifecycle.js";
import {
  ContactIntentNotFoundError,
  ContactIntentStoreConflictError,
  IdempotencyConflictError,
  InMemoryContactIntentStore,
  InvalidStoreInputError,
} from "./store.js";
import type {
  ContactDecision,
  ContactIntent,
  ContactIntentActivation,
  ContactIntentEvaluationFailure,
  ContactIntentEvaluationRequest,
} from "./types.js";

function intent(
  id: string,
  overrides: Partial<ContactIntent> = {},
): ContactIntent {
  const createdAt = "2026-09-01T00:00:00.000Z";
  return {
    schemaVersion: "0.1.0",
    id,
    status: "active",
    subject: `Follow up ${id}`,
    reason: "The user expects a future outcome.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: `event-${id}` }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The outcome already happened"],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function decision(
  intentId: string,
  action: ContactDecision["action"] = "defer",
  id = `decision-${intentId}`,
): ContactDecision {
  return {
    id,
    intentId,
    evaluatedAt: "2026-09-04T10:00:00.000Z",
    action,
    reason: `Test ${action}`,
    evidenceRefs: [`event-${intentId}`],
    counterEvidenceRefs: [],
    confidence: 0.9,
    nextEvaluationAt:
      action === "defer" ? "2026-09-05T10:00:00.000Z" : null,
    policyVersion: "test-1",
  };
}

function activation(intentId: string): ContactIntentActivation {
  return {
    id: `activation-${intentId}`,
    intentId,
    activatedAt: "2026-09-02T00:00:00.000Z",
    reason: "The user confirmed this follow-up should be tracked.",
    evidenceRefs: [`confirm-${intentId}`],
    nextEvaluationAt: "2026-09-04T09:00:00.000Z",
    policyVersion: "activation-test-1",
  };
}

function failure(
  intentId: string,
  overrides: Partial<ContactIntentEvaluationFailure> = {},
): ContactIntentEvaluationFailure {
  return {
    id: `failure-${intentId}`,
    intentId,
    failedAt: "2026-09-04T10:00:00.000Z",
    stage: "semantic",
    code: "ModelProtocolError",
    attempt: 1,
    exhausted: false,
    nextEvaluationAt: "2026-09-04T10:01:00.000Z",
    policyVersion: "default-0.1",
    ...overrides,
  };
}

function evaluationRequest(
  intentId: string,
  overrides: Partial<ContactIntentEvaluationRequest> = {},
): ContactIntentEvaluationRequest {
  return {
    id: `evaluation-request-${intentId}`,
    intentId,
    requestedAt: "2026-09-03T12:00:00.000Z",
    eventIds: ["found-internship"],
    effect: "cancel",
    reason: "The user already found an internship.",
    confidence: 0.98,
    nextEvaluationAt: "2026-09-03T12:00:00.000Z",
    policyVersion: "route-0.1",
    ...overrides,
  };
}

describe("InMemoryContactIntentStore", () => {
  it("creates records without exposing mutable internal data", async () => {
    const store = new InMemoryContactIntentStore();
    const original = intent("intent-1");
    const created = await store.createIntent({
      intent: original,
      nextEvaluationAt: original.notBefore,
      idempotencyKey: "create-1",
    });

    created.record.intent.subject = "mutated outside";
    original.reason = "also mutated outside";

    expect((await store.getIntent("intent-1"))?.intent.subject).toBe(
      "Follow up intent-1",
    );
    expect((await store.getIntent("intent-1"))?.intent.reason).toBe(
      "The user expects a future outcome.",
    );
  });

  it("returns duplicate for an exact create replay", async () => {
    const store = new InMemoryContactIntentStore();
    const input = {
      intent: intent("intent-1"),
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-1",
    };

    expect((await store.createIntent(input)).outcome).toBe("created");
    expect((await store.createIntent(input)).outcome).toBe("duplicate");
    expect((await store.listIntents()).length).toBe(1);
  });

  it("rejects idempotency key reuse with different input", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("intent-1"),
      nextEvaluationAt: null,
      idempotencyKey: "create-1",
    });

    await expect(
      store.createIntent({
        intent: intent("intent-2"),
        nextEvaluationAt: null,
        idempotencyKey: "create-1",
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("commits state and audit atomically and advances the revision", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("intent-1"),
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-1",
    });

    const committed = await store.commitDecision({
      intentId: "intent-1",
      expectedRevision: 1,
      decision: decision("intent-1", "cancel"),
      idempotencyKey: "commit-1",
    });

    expect(committed.record.revision).toBe(2);
    expect(committed.record.intent.status).toBe("cancelled");
    expect(committed.record.nextEvaluationAt).toBeNull();
    expect(await store.listDecisions("intent-1")).toEqual([
      decision("intent-1", "cancel"),
    ]);
  });

  it("does not append or advance twice on an exact decision replay", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("intent-1"),
      nextEvaluationAt: null,
      idempotencyKey: "create-1",
    });
    const input = {
      intentId: "intent-1",
      expectedRevision: 1,
      decision: decision("intent-1"),
      idempotencyKey: "commit-1",
    };

    expect((await store.commitDecision(input)).outcome).toBe("committed");
    expect((await store.commitDecision(input)).outcome).toBe("duplicate");
    expect((await store.getIntent("intent-1"))?.revision).toBe(2);
    expect((await store.listDecisions("intent-1")).length).toBe(1);
  });

  it("records a retryable evaluation failure without changing semantic state", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("intent-1");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    const input = {
      intentId: value.id,
      expectedRevision: 1,
      failure: failure(value.id),
      idempotencyKey: "record-failure-1",
    };

    const first = await store.recordEvaluationFailure(input);
    const replay = await store.recordEvaluationFailure(input);

    expect(first.outcome).toBe("recorded");
    expect(replay.outcome).toBe("duplicate");
    expect(first.record).toMatchObject({
      revision: 2,
      nextEvaluationAt: "2026-09-04T10:01:00.000Z",
      intent: { status: "active", updatedAt: value.updatedAt },
    });
    expect(await store.listAuditEvents(value.id)).toEqual([
      { kind: "evaluation-failed", failure: failure(value.id) },
    ]);
    expect(await store.listDecisions(value.id)).toEqual([]);
  });

  it("requires consecutive failure attempts and parks an exhausted intent", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("intent-1");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    await store.recordEvaluationFailure({
      intentId: value.id,
      expectedRevision: 1,
      failure: failure(value.id),
      idempotencyKey: "record-failure-1",
    });
    const exhausted = failure(value.id, {
      id: "failure-intent-1-2",
      failedAt: "2026-09-04T10:01:00.000Z",
      attempt: 2,
      exhausted: true,
      nextEvaluationAt: null,
    });

    await expect(
      store.recordEvaluationFailure({
        intentId: value.id,
        expectedRevision: 2,
        failure: { ...exhausted, attempt: 3 },
        idempotencyKey: "wrong-attempt",
      }),
    ).rejects.toThrow(InvalidStoreInputError);
    const recorded = await store.recordEvaluationFailure({
      intentId: value.id,
      expectedRevision: 2,
      failure: exhausted,
      idempotencyKey: "record-failure-2",
    });

    expect(recorded.record).toMatchObject({
      revision: 3,
      nextEvaluationAt: null,
      intent: { status: "active", updatedAt: value.updatedAt },
    });
    expect(
      await store.listIntents({ dueAtOrBefore: "2026-09-05T00:00:00.000Z" }),
    ).toEqual([]);
    expect(() => new InMemoryContactIntentStore(store.exportSnapshot())).not.toThrow();
  });

  it("persists an early evaluation request without changing intent semantics", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-job-fair",
    });
    const input = {
      intentId: value.id,
      expectedRevision: 1,
      request: evaluationRequest(value.id),
      idempotencyKey: "route-run-1-job-fair",
    };

    const first = await store.requestEvaluation(input);
    const replay = await store.requestEvaluation({ ...input, expectedRevision: 2 });

    expect(first.outcome).toBe("requested");
    expect(replay.outcome).toBe("duplicate");
    expect(first.record).toMatchObject({
      revision: 2,
      nextEvaluationAt: "2026-09-03T12:00:00.000Z",
      intent: { status: "active", updatedAt: value.updatedAt },
    });
    expect(await store.listAuditEvents(value.id)).toEqual([
      { kind: "evaluation-requested", request: evaluationRequest(value.id) },
    ]);
    expect(() => new InMemoryContactIntentStore(store.exportSnapshot())).not.toThrow();
  });

  it("never lets an evaluation request postpone earlier scheduled work", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-job-fair",
    });

    const result = await store.requestEvaluation({
      intentId: value.id,
      expectedRevision: 1,
      request: evaluationRequest(value.id, {
        requestedAt: "2026-09-04T10:00:00.000Z",
        nextEvaluationAt: "2026-09-04T10:00:00.000Z",
      }),
      idempotencyKey: "late-route",
    });

    expect(result.record.nextEvaluationAt).toBe("2026-09-04T09:00:00.000Z");
    expect(result.request.nextEvaluationAt).toBe("2026-09-04T09:00:00.000Z");
  });

  it("rejects stale revisions and duplicate decision identifiers", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("intent-1"),
      nextEvaluationAt: null,
      idempotencyKey: "create-1",
    });
    await store.commitDecision({
      intentId: "intent-1",
      expectedRevision: 1,
      decision: decision("intent-1"),
      idempotencyKey: "commit-1",
    });

    await expect(
      store.commitDecision({
        intentId: "intent-1",
        expectedRevision: 1,
        decision: decision("intent-1", "silent", "decision-other"),
        idempotencyKey: "commit-stale",
      }),
    ).rejects.toThrow(ContactIntentStoreConflictError);

    const second = intent("intent-2");
    await store.createIntent({
      intent: second,
      nextEvaluationAt: null,
      idempotencyKey: "create-2",
    });
    await expect(
      store.commitDecision({
        intentId: "intent-2",
        expectedRevision: 1,
        decision: decision("intent-2", "silent", "decision-intent-1"),
        idempotencyKey: "commit-duplicate-decision-id",
      }),
    ).rejects.toThrow(ContactIntentStoreConflictError);
  });

  it("rejects scheduling candidates and terminal decisions", async () => {
    const store = new InMemoryContactIntentStore();
    const candidate = intent("candidate-1", { status: "candidate" });
    await expect(
      store.createIntent({
        intent: candidate,
        nextEvaluationAt: candidate.notBefore,
        idempotencyKey: "candidate-create",
      }),
    ).rejects.toThrow(InvalidStoreInputError);

    const terminal = intent("terminal-1");
    await store.createIntent({
      intent: terminal,
      nextEvaluationAt: null,
      idempotencyKey: "terminal-create",
    });
    const invalid = decision("terminal-1", "cancel");
    invalid.nextEvaluationAt = "2026-09-06T00:00:00.000Z";
    await expect(
      store.commitDecision({
        intentId: "terminal-1",
        expectedRevision: 1,
        decision: invalid,
        idempotencyKey: "terminal-commit",
      }),
    ).rejects.toThrow(InvalidStoreInputError);
  });

  it("rejects evaluating a candidate before explicit activation", async () => {
    const store = new InMemoryContactIntentStore();
    await store.createIntent({
      intent: intent("candidate-1", { status: "candidate" }),
      nextEvaluationAt: null,
      idempotencyKey: "candidate-create",
    });

    await expect(
      store.commitDecision({
        intentId: "candidate-1",
        expectedRevision: 1,
        decision: decision("candidate-1", "silent"),
        idempotencyKey: "candidate-commit",
      }),
    ).rejects.toThrow(InvalidStoreInputError);
  });

  it("activates a candidate atomically and records the lifecycle event", async () => {
    const store = new InMemoryContactIntentStore();
    const candidate = intent("candidate-1", { status: "candidate" });
    await store.createIntent({
      intent: candidate,
      nextEvaluationAt: null,
      idempotencyKey: "candidate-create",
    });

    const result = await store.activateIntent({
      intentId: candidate.id,
      expectedRevision: 1,
      activation: activation(candidate.id),
      idempotencyKey: "candidate-activate",
    });

    expect(result.outcome).toBe("activated");
    expect(result.record.intent.status).toBe("active");
    expect(result.record.revision).toBe(2);
    expect(result.record.nextEvaluationAt).toBe(
      "2026-09-04T09:00:00.000Z",
    );
    expect(await store.listAuditEvents(candidate.id)).toEqual([
      { kind: "activated", activation: activation(candidate.id) },
    ]);
  });

  it("replays activation idempotently and allows later decisions", async () => {
    const store = new InMemoryContactIntentStore();
    const candidate = intent("candidate-1", { status: "candidate" });
    await store.createIntent({
      intent: candidate,
      nextEvaluationAt: null,
      idempotencyKey: "candidate-create",
    });
    const activateInput = {
      intentId: candidate.id,
      expectedRevision: 1,
      activation: activation(candidate.id),
      idempotencyKey: "candidate-activate",
    };
    await store.activateIntent(activateInput);

    expect((await store.activateIntent(activateInput)).outcome).toBe("duplicate");
    await store.commitDecision({
      intentId: candidate.id,
      expectedRevision: 2,
      decision: decision(candidate.id, "cancel"),
      idempotencyKey: "candidate-cancel",
    });
    expect((await store.getIntent(candidate.id))?.revision).toBe(3);
    expect((await store.listAuditEvents(candidate.id)).map((event) => event.kind)).toEqual([
      "activated",
      "decision",
    ]);
  });

  it("rejects activation schedules before activation time or notBefore", async () => {
    const store = new InMemoryContactIntentStore();
    const candidate = intent("candidate-1", { status: "candidate" });
    await store.createIntent({
      intent: candidate,
      nextEvaluationAt: null,
      idempotencyKey: "candidate-create",
    });
    const invalid = activation(candidate.id);
    invalid.nextEvaluationAt = "2026-09-01T12:00:00.000Z";

    await expect(
      store.activateIntent({
        intentId: candidate.id,
        expectedRevision: 1,
        activation: invalid,
        idempotencyKey: "candidate-activate",
      }),
    ).rejects.toThrow(InvalidStoreInputError);
  });

  it("rejects initial scheduling before notBefore", async () => {
    const store = new InMemoryContactIntentStore();
    await expect(
      store.createIntent({
        intent: intent("intent-1"),
        nextEvaluationAt: "2026-09-03T09:00:00.000Z",
        idempotencyKey: "create-1",
      }),
    ).rejects.toThrow(InvalidStoreInputError);
  });

  it("filters due active intents and sorts by due time then priority", async () => {
    const store = new InMemoryContactIntentStore();
    const fixtures = [
      {
        value: intent("later"),
        due: "2026-09-05T09:00:00.000Z",
      },
      {
        value: intent("low", { priority: 0.2 }),
        due: "2026-09-04T09:00:00.000Z",
      },
      {
        value: intent("high", { priority: 0.9 }),
        due: "2026-09-04T09:00:00.000Z",
      },
      {
        value: intent("candidate", { status: "candidate" }),
        due: null,
      },
    ];
    for (const fixture of fixtures) {
      await store.createIntent({
        intent: fixture.value,
        nextEvaluationAt: fixture.due,
        idempotencyKey: `create-${fixture.value.id}`,
      });
    }

    const due = await store.listIntents({
      dueAtOrBefore: "2026-09-04T10:00:00.000Z",
    });
    expect(due.map((record) => record.intent.id)).toEqual(["high", "low"]);
  });

  it("round-trips state, audit history, and idempotency through a snapshot", async () => {
    const first = new InMemoryContactIntentStore();
    const original = intent("intent-1");
    const createInput = {
      intent: original,
      nextEvaluationAt: original.notBefore,
      idempotencyKey: "create-1",
    };
    const commitInput = {
      intentId: "intent-1",
      expectedRevision: 1,
      decision: decision("intent-1"),
      idempotencyKey: "commit-1",
    };
    await first.createIntent(createInput);
    await first.commitDecision(commitInput);

    const restored = new InMemoryContactIntentStore(first.exportSnapshot());

    expect((await restored.createIntent(createInput)).outcome).toBe("duplicate");
    expect((await restored.commitDecision(commitInput)).outcome).toBe("duplicate");
    expect((await restored.getIntent("intent-1"))?.revision).toBe(2);
    expect((await restored.listDecisions("intent-1")).length).toBe(1);
  });

  it("rejects snapshots whose revision and audit history disagree", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("intent-1");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    const snapshot = store.exportSnapshot();
    snapshot.records[0]!.revision = 2;

    expect(() => new InMemoryContactIntentStore(snapshot)).toThrow(
      ContactIntentStoreConflictError,
    );
  });

  it("reports missing intents explicitly", async () => {
    const store = new InMemoryContactIntentStore();
    await expect(store.listDecisions("missing")).rejects.toThrow(
      ContactIntentNotFoundError,
    );
  });

  it("accepts activation as a separate domain operation before persistence", () => {
    const candidate = intent("candidate-1", { status: "candidate" });
    expect(activateIntent(candidate, "2026-09-02T00:00:00.000Z").status).toBe(
      "active",
    );
  });
});
