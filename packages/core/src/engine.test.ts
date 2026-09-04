import { describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import {
  evaluateDueContactIntents,
  registerExtractedIntents,
} from "./engine.js";
import { InMemoryContactIntentStore } from "./store.js";
import { requestRelevantEvaluations } from "./routing.js";
import type { ContactIntent, ConversationEvent } from "./types.js";
import type { SemanticReevaluator } from "./use-cases.js";

function intent(
  id: string,
  overrides: Partial<ContactIntent> = {},
): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id,
    status: "active",
    subject: "Follow up on the campus job fair",
    reason: "The user planned to attend the job fair on Friday.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: `plan-${id}` }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-06T00:00:00.000Z",
    cancellationHints: ["The user already found an internship"],
    priority: 0.8,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function event(id: string, content: string): ConversationEvent {
  return {
    id,
    conversationId: "conversation-1",
    actor: "user",
    occurredAt: "2026-09-03T12:00:00.000Z",
    content,
  };
}

describe("WakeIntent application services", () => {
  it("registers extracted active and candidate intents with recoverable idempotency", async () => {
    const store = new InMemoryContactIntentStore();
    const active = intent("active-1", { notBefore: null });
    const candidate = intent("candidate-1", { status: "candidate" });
    const input = {
      store,
      extractionRunId: "extraction-1",
      intents: [active, candidate],
    };

    const first = await registerExtractedIntents(input);
    const replay = await registerExtractedIntents(input);

    expect(first.results.map((result) => result.outcome)).toEqual([
      "created",
      "created",
    ]);
    expect(replay.results.map((result) => result.outcome)).toEqual([
      "duplicate",
      "duplicate",
    ]);
    expect((await store.getIntent(active.id))?.nextEvaluationAt).toBe(
      active.createdAt,
    );
    expect((await store.getIntent(candidate.id))?.nextEvaluationAt).toBeNull();
  });

  it("does no context or semantic work when no intent is due", async () => {
    const store = new InMemoryContactIntentStore();
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [intent("future-1")],
    });
    let contextCalls = 0;
    let semanticCalls = 0;

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-02T00:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          contextCalls += 1;
          return { latestEvents: [], userState: { authorization: "granted" } };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          throw new Error("must not run");
        },
      },
    });

    expect(result.dueCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(contextCalls).toBe(0);
    expect(semanticCalls).toBe(0);
  });

  it("cancels a now-invalid follow-up instead of mechanically contacting", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [value],
    });
    const foundInternship = event(
      "found-internship",
      "我已经找到实习了，不去双选会了。",
    );
    const reevaluator: SemanticReevaluator = {
      async evaluate() {
        return {
          action: "cancel",
          reason: "The user already found an internship and cancelled the plan.",
          evidenceRefs: [],
          counterEvidenceRefs: [foundInternship.id],
          confidence: 0.99,
          nextEvaluationAt: null,
        };
      },
    };

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          return {
            latestEvents: [foundInternship],
            userState: { authorization: "granted", remainingContactBudget: 1 },
          };
        },
      },
      semanticReevaluator: reevaluator,
    });

    expect(result.results[0]?.outcome).toBe("committed");
    expect(
      result.results[0]?.outcome === "committed"
        ? result.results[0].decision.action
        : null,
    ).toBe("cancel");
    expect((await store.getIntent(value.id))?.intent.status).toBe("cancelled");
    expect((await store.getIntent(value.id))?.nextEvaluationAt).toBeNull();
    expect((await store.listDecisions(value.id)).length).toBe(1);
  });

  it("closes a high-confidence invalidated intent before its contact window", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [value],
    });
    const foundInternship = event(
      "found-internship",
      "我已经找到实习了，不去双选会了。",
    );
    await requestRelevantEvaluations({
      store,
      events: [foundInternship],
      now: "2026-09-03T12:00:00.000Z",
      routeRunId: "day-3-update",
      policyVersion: "route-0.1",
      router: {
        async selectRelevant() {
          return [{
            intentId: value.id,
            eventIds: [foundInternship.id],
            effect: "cancel",
            reason: "The user found an internship and abandoned the job fair plan.",
            confidence: 0.99,
          }];
        },
      },
    });
    let contextCalls = 0;
    let semanticCalls = 0;

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-03T12:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          contextCalls += 1;
          throw new Error("route closure must not load context again");
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          throw new Error("route closure must not spend a second model call");
        },
      },
    });

    expect(contextCalls).toBe(0);
    expect(semanticCalls).toBe(0);
    expect(
      result.results[0]?.outcome === "committed"
        ? [result.results[0].source, result.results[0].decision.action]
        : null,
    ).toEqual(["route-closure", "cancel"]);
    expect(result.work.routeClosureDecisions).toBe(1);
    expect((await store.getIntent(value.id))?.intent.status).toBe("cancelled");
  });

  it("revalidates an early context change but still blocks premature contact", async () => {
    const store = new InMemoryContactIntentStore();
    const value = intent("job-fair");
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [value],
    });
    const update = event(
      "job-fair-update",
      "计划没取消，不过主办方说可能会晚一点结束。",
    );
    await requestRelevantEvaluations({
      store,
      events: [update],
      now: "2026-09-03T12:00:00.000Z",
      routeRunId: "day-3-timing-update",
      policyVersion: "route-0.1",
      router: {
        async selectRelevant() {
          return [{
            intentId: value.id,
            eventIds: [update.id],
            effect: "reevaluate",
            reason: "The timing update may change when follow-up is useful.",
            confidence: 0.85,
          }];
        },
      },
    });
    let semanticCalls = 0;

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-03T12:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          return {
            latestEvents: [update],
            userState: { authorization: "granted", remainingContactBudget: 1 },
          };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          return {
            action: "contact",
            reason: "The follow-up remains useful.",
            evidenceRefs: [value.evidence[0]!.eventId],
            counterEvidenceRefs: [update.id],
            confidence: 0.8,
            nextEvaluationAt: null,
          };
        },
      },
    });

    expect(semanticCalls).toBe(1);
    expect(
      result.results[0]?.outcome === "committed"
        ? [result.results[0].source, result.results[0].decision.action]
        : null,
    ).toEqual(["hard-gate", "defer"]);
    expect((await store.getIntent(value.id))?.nextEvaluationAt).toBe(
      value.notBefore,
    );
    expect(result.work.contactDecisions).toBe(0);
  });

  it("uses deterministic hard gates without spending a semantic call", async () => {
    const store = new InMemoryContactIntentStore();
    const expired = intent("expired-1", {
      expiresAt: "2026-09-04T09:30:00.000Z",
    });
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [expired],
    });
    let semanticCalls = 0;

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          return {
            latestEvents: [],
            userState: { authorization: "granted", remainingContactBudget: 1 },
          };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          throw new Error("hard expiry should decide first");
        },
      },
    });

    expect(semanticCalls).toBe(0);
    expect(
      result.results[0]?.outcome === "committed"
        ? result.results[0].decision.action
        : null,
    ).toBe("expire");
  });

  it("isolates one failed reevaluation and continues with later due intents", async () => {
    const store = new InMemoryContactIntentStore();
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [
        intent("broken", { priority: 0.9 }),
        intent("healthy", { priority: 0.8 }),
      ],
    });

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          return {
            latestEvents: [],
            userState: { authorization: "granted", remainingContactBudget: 1 },
          };
        },
      },
      semanticReevaluator: {
        async evaluate(input) {
          if (input.intent.id === "broken") throw new Error("model parse failed");
          return {
            action: "silent",
            reason: "There is no useful reason to interrupt now.",
            evidenceRefs: [],
            counterEvidenceRefs: [],
            confidence: 0.9,
            nextEvaluationAt: null,
          };
        },
      },
    });

    expect(result.results.map((item) => item.outcome)).toEqual([
      "failed",
      "committed",
    ]);
    expect((await store.getIntent("broken"))?.revision).toBe(2);
    expect((await store.getIntent("broken"))?.nextEvaluationAt).toBe(
      "2026-09-04T10:01:00.000Z",
    );
    expect((await store.getIntent("healthy"))?.revision).toBe(2);
    expect(result.work).toMatchObject({
      failures: 1,
      failureRecords: 1,
      retriesScheduled: 1,
    });
  });

  it("backs off repeated failures and parks an exhausted intent", async () => {
    const store = new InMemoryContactIntentStore();
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [intent("broken")],
    });
    const clock = new FakeClock("2026-09-04T10:00:00.000Z");
    const input = {
      store,
      clock,
      policyVersion: "default-0.1",
      failureBackoff: {
        initialDelayMs: 1_000,
        multiplier: 2,
        maxDelayMs: 10_000,
        maxAttempts: 2,
      },
      contextProvider: {
        async load() {
          return {
            latestEvents: [],
            userState: { authorization: "granted" as const },
          };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          throw new Error("sensitive upstream message");
        },
      },
    };

    const first = await evaluateDueContactIntents(input);
    const immediateReplay = await evaluateDueContactIntents(input);
    clock.advance(1_000);
    const second = await evaluateDueContactIntents(input);

    expect(first.work.retriesScheduled).toBe(1);
    expect(immediateReplay.dueCount).toBe(0);
    expect(second.work.retriesExhausted).toBe(1);
    expect(await store.getIntent("broken")).toMatchObject({
      revision: 3,
      nextEvaluationAt: null,
      intent: { status: "active", updatedAt: "2026-09-01T00:00:00.000Z" },
    });
    const serialized = JSON.stringify(store.exportSnapshot());
    expect(serialized).not.toContain("sensitive upstream message");
    expect(serialized).toContain('"attempt":2');
  });

  it("shares a per-target contact budget across simultaneously due intents", async () => {
    const store = new InMemoryContactIntentStore();
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [
        intent("first", { priority: 0.9 }),
        intent("second", { priority: 0.8 }),
      ],
    });

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-04T10:00:00.000Z"),
      policyVersion: "default-0.1",
      sharedContactBudget: {
        maxContactDecisionsPerTarget: 1,
        onExhausted: "silent",
      },
      contextProvider: {
        async load() {
          return {
            latestEvents: [],
            userState: { authorization: "granted", remainingContactBudget: 1 },
          };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          return {
            action: "contact",
            reason: "This is a useful moment to follow up.",
            evidenceRefs: [],
            counterEvidenceRefs: [],
            confidence: 0.9,
            nextEvaluationAt: null,
          };
        },
      },
    });

    expect(
      result.results.map((item) =>
        item.outcome === "committed"
          ? [item.source, item.decision.action]
          : [item.outcome],
      ),
    ).toEqual([
      ["semantic", "contact"],
      ["batch-policy", "silent"],
    ]);
    expect(result.work).toMatchObject({
      semanticCalls: 2,
      contactDecisions: 1,
      budgetSuppressed: 1,
      batchPolicyDecisions: 1,
    });
  });

  it("silences a badly late intent without loading context or calling semantics", async () => {
    const store = new InMemoryContactIntentStore();
    const stale = intent("stale", { expiresAt: "2026-09-10T00:00:00.000Z" });
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [stale],
    });
    let contextCalls = 0;
    let semanticCalls = 0;

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-06T10:00:00.000Z"),
      policyVersion: "late-policy-0.1",
      lateWakePolicy: {
        maxLatenessMs: 6 * 60 * 60 * 1000,
        onTooLate: "silent",
      },
      contextProvider: {
        async load() {
          contextCalls += 1;
          return { latestEvents: [], userState: { authorization: "granted" } };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          throw new Error("late policy should decide first");
        },
      },
    });

    expect(contextCalls).toBe(0);
    expect(semanticCalls).toBe(0);
    expect(
      result.results[0]?.outcome === "committed"
        ? [result.results[0].source, result.results[0].decision.action]
        : null,
    ).toEqual(["late-policy", "silent"]);
    expect((await store.getIntent(stale.id))?.intent.status).toBe("active");
    expect((await store.getIntent(stale.id))?.nextEvaluationAt).toBeNull();
    expect(result.work).toMatchObject({
      dueIntents: 1,
      contextLoads: 0,
      semanticCalls: 0,
      latePolicyDecisions: 1,
      committed: 1,
    });
  });

  it("expires a badly late intent when configured to close stale work", async () => {
    const store = new InMemoryContactIntentStore();
    const stale = intent("stale", { expiresAt: "2026-09-10T00:00:00.000Z" });
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [stale],
    });

    await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-06T10:00:00.000Z"),
      policyVersion: "late-policy-0.1",
      lateWakePolicy: {
        maxLatenessMs: 6 * 60 * 60 * 1000,
        onTooLate: "expire",
      },
      contextProvider: {
        async load() {
          throw new Error("late policy should not load context");
        },
      },
      semanticReevaluator: {
        async evaluate() {
          throw new Error("late policy should not call semantics");
        },
      },
    });

    expect((await store.getIntent(stale.id))?.intent.status).toBe("expired");
  });

  it("does not let the late policy mask the intent's real expiry boundary", async () => {
    const store = new InMemoryContactIntentStore();
    const expired = intent("expired", { expiresAt: "2026-09-05T00:00:00.000Z" });
    await registerExtractedIntents({
      store,
      extractionRunId: "extraction-1",
      intents: [expired],
    });

    const result = await evaluateDueContactIntents({
      store,
      clock: new FakeClock("2026-09-06T10:00:00.000Z"),
      policyVersion: "late-policy-0.1",
      lateWakePolicy: { maxLatenessMs: 0, onTooLate: "silent" },
      contextProvider: {
        async load() {
          return { latestEvents: [], userState: { authorization: "granted" } };
        },
      },
      semanticReevaluator: {
        async evaluate() {
          throw new Error("expiry hard gate should decide");
        },
      },
    });

    expect(
      result.results[0]?.outcome === "committed"
        ? [result.results[0].source, result.results[0].decision.action]
        : null,
    ).toEqual(["hard-gate", "expire"]);
    expect(result.work.semanticCalls).toBe(0);
  });
});
