import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type {
  CandidateDraft,
  CandidateGenerator,
  ContactPolicySignalDraft,
  ConversationEvent,
  PolicySignalGenerator,
  SemanticDecisionProposal,
  SemanticReevaluator,
} from "@wakeintent/core";
import {
  runDueGatedBaselineTimeline,
  runWakeIntentTimeline,
  type LongitudinalStep,
  type RelevanceRouter,
} from "./longitudinal.js";
import {
  evaluatePolicyLongitudinalDevelopmentDataset,
  type PolicyLongitudinalDevelopmentDataset,
} from "./policy-longitudinal-development.js";

const initialEvent: ConversationEvent = {
  id: "plan",
  conversationId: "conversation",
  actor: "user",
  occurredAt: "2026-09-01T09:00:00.000Z",
  content: "周五去双选会，前一天问问我材料准备好了没有。",
};

const candidate = (overrides: Partial<CandidateDraft> = {}): CandidateDraft => ({
  subject: "双选会材料",
  reason: "用户计划参加双选会并希望提前跟进。",
  evidence: [{ eventId: "plan" }],
  notBefore: "2026-09-05T12:00:00.000Z",
  expiresAt: null,
  cancellationHints: ["用户不再参加双选会"],
  priority: 0.8,
  interruptionCost: 0.2,
  confidence: 0.95,
  ...overrides,
});

const generator = (drafts: CandidateDraft[]): CandidateGenerator => ({
  async generate() {
    return drafts;
  },
});

const policyGenerator = (
  select: (events: ConversationEvent[]) => ContactPolicySignalDraft[],
): PolicySignalGenerator => ({
  async generatePolicySignals(input) {
    return select(input.events);
  },
});

const proposal = (
  overrides: Partial<SemanticDecisionProposal> = {},
): SemanticDecisionProposal => ({
  action: "contact",
  reason: "The follow-up remains useful.",
  evidenceRefs: ["plan"],
  counterEvidenceRefs: [],
  confidence: 0.9,
  nextEvaluationAt: null,
  ...overrides,
});

const router = (
  selectIds: (input: Parameters<RelevanceRouter["selectRelevant"]>[0]) => Promise<string[]>,
): RelevanceRouter => ({
  async selectRelevant(input) {
    return (await selectIds(input)).map((intentId) => ({
      intentId,
      eventIds: input.events.map((event) => event.id),
      effect: "reevaluate" as const,
      reason: "Test route requires semantic reevaluation.",
      confidence: 1,
    }));
  },
});

const scheduled = (at: string): LongitudinalStep => ({
  at,
  kind: "scheduled",
  events: [],
});

describe("runWakeIntentTimeline", () => {
  it("resolves an intent on relevant new context and never wakes it at due time", async () => {
    let evaluations = 0;
    const result = await runWakeIntentTimeline({
      scenarioId: "early-resolution",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate()]),
      relevanceRouter: router(async ({ intents }) => [intents[0]!.id]),
      semanticReevaluator: {
        async evaluate(): Promise<SemanticDecisionProposal> {
          evaluations += 1;
          return proposal({
            action: "resolve",
            reason: "The user found an internship and will not attend.",
            evidenceRefs: ["plan"],
            counterEvidenceRefs: ["found-internship"],
          });
        },
      },
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "found-internship",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "已经找到实习了，双选会不去了。",
            },
          ],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
      ],
    });

    expect(evaluations).toBe(1);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({
      trigger: "context",
      decision: { action: "resolve" },
    });
    expect(result.intents[0]?.status).toBe("resolved");
    expect(result.pendingEvaluationAt).toEqual({});
  });

  it("does not call the semantic model for unrelated context", async () => {
    let evaluations = 0;
    const semanticReevaluator: SemanticReevaluator = {
      async evaluate(input) {
        evaluations += 1;
        expect(input.latestEvents.map((event) => event.id)).toContain("weather");
        return proposal();
      },
    };
    const result = await runWakeIntentTimeline({
      scenarioId: "unrelated-context",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate()]),
      relevanceRouter: router(async () => []),
      semanticReevaluator,
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "weather",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "今天下雨了。",
            },
          ],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
        scheduled("2026-09-06T12:00:00.000Z"),
      ],
    });

    expect(evaluations).toBe(1);
    expect(result.metrics).toMatchObject({
      routingCalls: 1,
      reevaluationAttempts: 1,
      semanticDecisionModelCalls: 1,
      contactDecisions: 1,
    });
    expect(result.traces[0]?.trigger).toBe("scheduled");
  });

  it("reuses a high-confidence route closure without a second semantic call", async () => {
    let evaluations = 0;
    const result = await runWakeIntentTimeline({
      scenarioId: "route-closure",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate()]),
      relevanceRouter: {
        async selectRelevant({ intents, events }) {
          return [{
            intentId: intents[0]!.id,
            eventIds: [events[0]!.id],
            effect: "cancel",
            reason: "The user abandoned the underlying plan.",
            confidence: 0.98,
          }];
        },
      },
      semanticReevaluator: {
        async evaluate() {
          evaluations += 1;
          return proposal();
        },
      },
      steps: [{
        at: "2026-09-03T08:00:00.000Z",
        kind: "context",
        events: [{
          id: "found-internship",
          conversationId: "conversation",
          actor: "user",
          occurredAt: "2026-09-03T08:00:00.000Z",
          content: "已经找到实习了，双选会不去了。",
        }],
      }],
    });

    expect(evaluations).toBe(0);
    expect(result.traces[0]).toMatchObject({
      decision: {
        action: "cancel",
        counterEvidenceRefs: ["found-internship"],
        metadata: { source: "relevance-route-closure" },
      },
    });
    expect(result.metrics.semanticDecisionModelCalls).toBe(0);
  });

  it("reschedules defer and stops after a one-shot contact", async () => {
    let evaluations = 0;
    const result = await runWakeIntentTimeline({
      scenarioId: "defer-then-contact",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate()]),
      relevanceRouter: router(async () => []),
      semanticReevaluator: {
        async evaluate() {
          evaluations += 1;
          return evaluations === 1
            ? proposal({
                action: "defer",
                reason: "Wait one day.",
                nextEvaluationAt: "2026-09-06T12:00:00.000Z",
              })
            : proposal();
        },
      },
      steps: [
        scheduled("2026-09-05T12:00:00.000Z"),
        scheduled("2026-09-06T12:00:00.000Z"),
        scheduled("2026-09-07T12:00:00.000Z"),
      ],
    });

    expect(result.traces.map((trace) => trace.decision.action)).toEqual([
      "defer",
      "contact",
    ]);
    expect(result.pendingEvaluationAt).toEqual({});
  });

  it("treats an active intent without notBefore as immediately eligible", async () => {
    const result = await runWakeIntentTimeline({
      scenarioId: "immediately-eligible",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate({ notBefore: null })]),
      relevanceRouter: router(async () => []),
      semanticReevaluator: { async evaluate() { return proposal(); } },
      steps: [scheduled("2026-09-02T12:00:00.000Z")],
    });

    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.decision.action).toBe("contact");
  });

  it("routes one intent without waking an unrelated intent", async () => {
    const evaluator: SemanticReevaluator = {
      async evaluate(input) {
        return input.intent.subject === "双选会材料"
          ? proposal({
              action: "resolve",
              reason: "The job-fair plan is no longer relevant.",
              counterEvidenceRefs: ["found-internship"],
            })
          : proposal();
      },
    };
    const result = await runWakeIntentTimeline({
      scenarioId: "multiple-intents",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([
        candidate(),
        candidate({ subject: "面试结果", reason: "等待面试结果。" }),
      ]),
      relevanceRouter: router(async ({ intents }) => [
        intents.find((intent) => intent.subject === "双选会材料")!.id,
      ]),
      semanticReevaluator: evaluator,
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "found-internship",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "找到实习了，不去双选会了。",
            },
          ],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
      ],
    });

    expect(result.traces.map((trace) => trace.decision.action)).toEqual([
      "resolve",
      "contact",
    ]);
    expect(result.metrics.semanticDecisionModelCalls).toBe(2);
  });

  it("broadcasts one extracted quiet window to every scheduled intent", async () => {
    let semanticEvaluations = 0;
    const quietUntil = "2026-09-06T12:00:00.000Z";
    const result = await runWakeIntentTimeline({
      scenarioId: "global-quiet-window",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([
        candidate({ subject: "双选会材料" }),
        candidate({ subject: "快递签收", reason: "确认快递是否收到。" }),
      ]),
      policySignalGenerator: policyGenerator((events) =>
        events.some((event) => event.id === "quiet")
          ? [
              {
                kind: "set-do-not-disturb",
                evidenceRef: "quiet",
                reason: "用户明确要求本周不要主动联系。",
                doNotDisturbUntil: quietUntil,
              },
            ]
          : [],
      ),
      relevanceRouter: router(async () => []),
      semanticReevaluator: {
        async evaluate() {
          semanticEvaluations += 1;
          return proposal();
        },
      },
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "quiet",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "这周先别主动联系我，下周再说。",
            },
          ],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
      ],
    });

    expect(semanticEvaluations).toBe(0);
    expect(Object.values(result.pendingEvaluationAt)).toEqual([
      quietUntil,
      quietUntil,
    ]);
    expect(result.traces).toEqual([]);
    expect(result.policySnapshot.state.doNotDisturbUntil).toBe(quietUntil);
    expect(result.policyAudits).toMatchObject([
      { kind: "set-do-not-disturb", evidenceRef: "quiet", outcome: "applied" },
    ]);
    expect(result.metrics).toMatchObject({
      policySignalExtractionCalls: 1,
      policySignalsApplied: 1,
      routingCalls: 1,
      semanticDecisionModelCalls: 0,
    });
  });

  it("restores postponed schedules when the user clears a quiet window", async () => {
    const result = await runWakeIntentTimeline({
      scenarioId: "clear-global-quiet-window",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([candidate()]),
      policySignalGenerator: policyGenerator((events) => {
        if (events.some((event) => event.id === "quiet")) {
          return [
            {
              kind: "set-do-not-disturb",
              evidenceRef: "quiet",
              reason: "用户要求暂时免打扰。",
              doNotDisturbUntil: "2026-09-07T12:00:00.000Z",
            },
          ];
        }
        if (events.some((event) => event.id === "resume")) {
          return [
            {
              kind: "clear-do-not-disturb",
              evidenceRef: "resume",
              reason: "用户明确恢复普通联系。",
            },
          ];
        }
        return [];
      }),
      relevanceRouter: router(async () => []),
      semanticReevaluator: { async evaluate() { return proposal(); } },
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "quiet",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "这周不要主动联系。",
            },
          ],
        },
        {
          at: "2026-09-04T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "resume",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-04T08:00:00.000Z",
              content: "没事了，可以正常联系我。",
            },
          ],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
      ],
    });

    expect(result.traces.map((trace) => trace.decision.action)).toEqual([
      "contact",
    ]);
    expect(result.policySnapshot.state).not.toHaveProperty(
      "doNotDisturbUntil",
    );
    expect(result.policyAudits.map((audit) => audit.kind)).toEqual([
      "set-do-not-disturb",
      "clear-do-not-disturb",
    ]);
    expect(result.metrics).toMatchObject({
      policySignalExtractionCalls: 2,
      policySignalsApplied: 2,
      semanticDecisionModelCalls: 1,
    });
  });

  it("immediately closes every active intent when global authorization is denied", async () => {
    let routingCalls = 0;
    let semanticCalls = 0;
    const result = await runWakeIntentTimeline({
      scenarioId: "global-authorization-denied",
      initialEvents: [initialEvent],
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
      initialUserState: { authorization: "granted" },
      generator: generator([
        candidate({ subject: "双选会材料" }),
        candidate({ subject: "快递签收" }),
      ]),
      policySignalGenerator: policyGenerator((events) =>
        events.some((event) => event.id === "global-denial")
          ? [{
              kind: "set-authorization",
              evidenceRef: "global-denial",
              reason: "用户撤销了所有主动联系授权。",
              authorization: "denied",
            }]
          : [],
      ),
      relevanceRouter: {
        async selectRelevant() {
          routingCalls += 1;
          return [];
        },
      },
      semanticReevaluator: {
        async evaluate() {
          semanticCalls += 1;
          return proposal();
        },
      },
      steps: [{
        at: "2026-09-03T08:00:00.000Z",
        kind: "context",
        events: [{
          id: "global-denial",
          conversationId: "conversation",
          actor: "user",
          occurredAt: "2026-09-03T08:00:00.000Z",
          content: "以后都不要主动联系我。",
        }],
      }],
    });

    expect(result.traces).toHaveLength(2);
    expect(result.traces.map((trace) => trace.decision.action)).toEqual([
      "cancel",
      "cancel",
    ]);
    expect(result.traces.every((trace) =>
      trace.decision.counterEvidenceRefs.includes("global-denial"),
    )).toBe(true);
    expect(result.pendingEvaluationAt).toEqual({});
    expect(result.intents.every((intent) => intent.status === "cancelled")).toBe(true);
    expect(routingCalls).toBe(0);
    expect(semanticCalls).toBe(0);
    expect(result.metrics).toMatchObject({
      policySignalExtractionCalls: 1,
      policySignalsApplied: 1,
      routingCalls: 0,
      semanticDecisionModelCalls: 0,
      terminalDecisions: 2,
    });
  });
});

describe("runDueGatedBaselineTimeline", () => {
  it("waits until due, then uses accumulated context once and removes the memory", async () => {
    let decisions = 0;
    const result = await runDueGatedBaselineTimeline({
      memories: [
        {
          id: "job-fair",
          summary: "Prepare for the job fair.",
          dueAt: "2026-09-05T12:00:00.000Z",
          evidenceRefs: ["plan"],
        },
      ],
      initialUserState: { authorization: "granted" },
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [
            {
              id: "found-internship",
              conversationId: "conversation",
              actor: "user",
              occurredAt: "2026-09-03T08:00:00.000Z",
              content: "找到实习了，不去双选会了。",
            },
          ],
        },
        scheduled("2026-09-04T12:00:00.000Z"),
        scheduled("2026-09-05T12:00:00.000Z"),
        scheduled("2026-09-06T12:00:00.000Z"),
      ],
      decider: {
        async decide(input) {
          decisions += 1;
          expect(input.latestEvents.map((event) => event.id)).toContain(
            "found-internship",
          );
          return [
            {
              memoryId: "job-fair",
              action: "cancel",
              reason: "The goal is already superseded.",
              evidenceRefs: ["found-internship"],
              nextEvaluationAt: null,
            },
          ];
        },
      },
    });

    expect(decisions).toBe(1);
    expect(result.memories).toEqual([]);
    expect(result.metrics).toMatchObject({
      deterministicChecks: 3,
      decisionModelCalls: 1,
      terminalDecisions: 1,
    });
  });

  it("rejects duplicate decisions for a batched due window", async () => {
    await expect(
      runDueGatedBaselineTimeline({
        memories: [
          { id: "a", summary: "A", dueAt: "2026-09-02T00:00:00.000Z", evidenceRefs: [] },
          { id: "b", summary: "B", dueAt: "2026-09-02T00:00:00.000Z", evidenceRefs: [] },
        ],
        initialUserState: { authorization: "granted" },
        steps: [scheduled("2026-09-02T00:00:00.000Z")],
        decider: {
          async decide() {
            return [
              { memoryId: "a", action: "contact", reason: "A", evidenceRefs: [], nextEvaluationAt: null },
              { memoryId: "a", action: "contact", reason: "A again", evidenceRefs: [], nextEvaluationAt: null },
            ];
          },
        },
      }),
    ).rejects.toThrow("uniquely cover every due memory");
  });

  it("keeps global context available for memories due in later batches", async () => {
    const seenEventIds: string[][] = [];
    const result = await runDueGatedBaselineTimeline({
      memories: [
        {
          id: "first",
          summary: "First follow-up",
          dueAt: "2026-09-05T12:00:00.000Z",
          evidenceRefs: ["plan-a"],
        },
        {
          id: "second",
          summary: "Second follow-up",
          dueAt: "2026-09-06T12:00:00.000Z",
          evidenceRefs: ["plan-b"],
        },
      ],
      initialUserState: { authorization: "granted" },
      steps: [
        {
          at: "2026-09-03T08:00:00.000Z",
          kind: "context",
          events: [{
            id: "global-stop",
            conversationId: "conversation",
            actor: "user",
            occurredAt: "2026-09-03T08:00:00.000Z",
            content: "以后都不要主动联系我。",
          }],
        },
        scheduled("2026-09-05T12:00:00.000Z"),
        scheduled("2026-09-06T12:00:00.000Z"),
      ],
      decider: {
        async decide(input) {
          seenEventIds.push(input.latestEvents.map((event) => event.id));
          return input.memories.map((memory) => ({
            memoryId: memory.id,
            action: "cancel" as const,
            reason: "Global proactive contact permission was revoked.",
            evidenceRefs: ["global-stop"],
            nextEvaluationAt: null,
          }));
        },
      },
    });

    expect(seenEventIds).toEqual([["global-stop"], ["global-stop"]]);
    expect(result.metrics.decisionModelCalls).toBe(2);
    expect(result.memories).toEqual([]);
  });
});

describe("model-backed longitudinal fixtures", () => {
    it("has unique scenarios with chronological steps and unique event ids", () => {
    const dataset = JSON.parse(
      readFileSync(
        new URL(
          "../../../evals/longitudinal-development-v0.1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      scenarios: Array<{
        id: string;
        initialEvents: ConversationEvent[];
        steps: LongitudinalStep[];
      }>;
    };
    expect(dataset.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dataset.scenarios.map((item) => item.id)).size).toBe(
      dataset.scenarios.length,
    );
    for (const item of dataset.scenarios) {
      const times = item.steps.map((step) => Date.parse(step.at));
      expect(times.every((time) => !Number.isNaN(time))).toBe(true);
      expect(times).toEqual([...times].sort((left, right) => left - right));
      const eventIds = [
        ...item.initialEvents.map((event) => event.id),
        ...item.steps.flatMap((step) => step.events.map((event) => event.id)),
      ];
      expect(new Set(eventIds).size).toBe(eventIds.length);
    }
    });

  it("runs the global-policy two-intent fixture through both offline systems", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../evals/longitudinal-policy-development-v0.1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as PolicyLongitudinalDevelopmentDataset;
    expect(fixture.scenarios).toHaveLength(1);
    expect(fixture.scenarios[0]?.expected.intentCount).toBe(2);

    const report = await evaluatePolicyLongitudinalDevelopmentDataset(fixture);
    expect(report.aggregate).toEqual({ scenarios: 1, passed: 1 });
    expect(report.scenarios[0]?.score).toEqual({
      wakeIntentCount: true,
      policySignalApplied: true,
      wakeAvoidedOriginalDueEvaluation: true,
      baselineUsedFairBatch: true,
      wakeFinalActions: true,
      baselineFinalActions: true,
    });
    expect(report.scenarios[0]?.comparison).toMatchObject({
      wakeintent: {
        originalDueWakeBatches: 0,
        policyReactionLatencyMs: 0,
        finalActions: ["contact", "contact"],
        tokens: null,
      },
      dueGatedBaseline: {
        originalDueWakeBatches: 1,
        policyReactionLatencyMs: 187_200_000,
        finalActions: ["contact", "contact"],
        tokens: null,
      },
    });
  });
});
