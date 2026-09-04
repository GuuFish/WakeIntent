import assert from "node:assert/strict";

import {
  FakeClock,
  InMemoryContactIntentStore,
  evaluateDueContactIntents,
  extractContactIntents,
  registerExtractedIntents,
} from "../packages/core/dist/index.js";

const initialEvent = {
  id: "recruitment-interview-result-window",
  conversationId: "reference-host-conversation",
  actor: "user",
  occurredAt: "2026-09-01T09:00:00.000Z",
  content: "公司说周五前会通知面试结果。",
};

const scenarios = [
  {
    id: "contact-ready",
    latestEvents: [],
    userState: { authorization: "granted", remainingContactBudget: 1 },
    semanticAction: "contact",
    expectedAction: "contact",
  },
  {
    id: "resolved-before-contact",
    latestEvents: [
      {
        id: "recruitment-offer-received",
        conversationId: "reference-host-conversation",
        actor: "user",
        occurredAt: "2026-09-04T09:30:00.000Z",
        content: "我已经拿到 offer 了，不用再问这件事啦。",
      },
    ],
    userState: { authorization: "granted", remainingContactBudget: 1 },
    semanticAction: "resolve",
    expectedAction: "resolve",
  },
  {
    id: "authorization-unknown",
    latestEvents: [],
    userState: { authorization: "unknown", remainingContactBudget: 1 },
    semanticAction: "contact",
    expectedAction: "silent",
  },
];

async function runScenario(scenario) {
  const store = new InMemoryContactIntentStore();
  let sequence = 0;
  const idGenerator = (kind) => `${scenario.id}-${kind}-${++sequence}`;
  const [intent] = await extractContactIntents({
    events: [initialEvent],
    target: { kind: "user", id: "reference-user" },
    clock: new FakeClock("2026-09-01T09:01:00.000Z"),
    idGenerator,
    generator: {
      async generate() {
        return [
          {
            subject: "面试结果后续关心",
            reason: "用户预计周五前收到面试结果，结果窗口后可能值得关心。",
            evidence: [
              { eventId: initialEvent.id, quote: initialEvent.content },
            ],
            notBefore: "2026-09-04T09:00:00.000Z",
            expiresAt: "2026-09-11T09:00:00.000Z",
            cancellationHints: ["用户已经说明结果", "用户要求不要再问"],
            priority: 0.75,
            interruptionCost: 0.3,
            confidence: 0.94,
          },
        ];
      },
    },
    policy: { activationThreshold: 0.8 },
  });
  assert(intent, "The reference host must extract an intent");

  await registerExtractedIntents({
    store,
    extractionRunId: `reference-host:${scenario.id}`,
    intents: [intent],
  });

  let semanticCalls = 0;
  const evaluation = await evaluateDueContactIntents({
    store,
    clock: new FakeClock("2026-09-04T10:00:00.000Z"),
    policyVersion: "reference-host-0.1",
    contextProvider: {
      async load() {
        return {
          latestEvents: scenario.latestEvents,
          userState: scenario.userState,
        };
      },
    },
    semanticReevaluator: {
      async evaluate() {
        semanticCalls += 1;
        if (scenario.semanticAction === "resolve") {
          return {
            action: "resolve",
            reason: "用户已经主动说明结果，联系理由已经得到处理。",
            evidenceRefs: [initialEvent.id],
            counterEvidenceRefs: ["recruitment-offer-received"],
            confidence: 0.99,
            nextEvaluationAt: null,
          };
        }
        return {
          action: "contact",
          reason: "已进入结果窗口，且没有新上下文表明理由失效。",
          evidenceRefs: [initialEvent.id],
          counterEvidenceRefs: [],
          confidence: 0.88,
          nextEvaluationAt: null,
        };
      },
    },
  });

  const item = evaluation.results[0];
  assert(
    item && (item.outcome === "committed" || item.outcome === "duplicate"),
    `Scenario ${scenario.id} must commit a decision`,
  );
  assert.equal(item.decision.action, scenario.expectedAction);

  // This is the host boundary: only a contact decision enters the outbox.
  // No message is generated or delivered by WakeIntent itself.
  const outbox =
    item.decision.action === "contact"
      ? [
          {
            idempotencyKey: `delivery:${item.decision.id}`,
            target: intent.target,
            decisionId: item.decision.id,
            status: "awaiting-host-message-generation",
            delivered: false,
          },
        ]
      : [];

  return {
    scenario: scenario.id,
    decision: item.decision.action,
    resultingStatus: item.commit.record.intent.status,
    nextEvaluationAt: item.commit.record.nextEvaluationAt,
    semanticCalls,
    outbox,
  };
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario));
}

assert.equal(results[0]?.outbox.length, 1);
assert.equal(results[1]?.outbox.length, 0);
assert.equal(results[2]?.outbox.length, 0);
assert.equal(results[2]?.semanticCalls, 0);

console.log(
  JSON.stringify(
    {
      note: "Deterministic recruitment reference host; no API calls or real messages.",
      flow: [
        "conversation event -> ContactIntent",
        "latest context and policy -> decision",
        "contact only -> host outbox",
      ],
      results,
      interpretation:
        "Only the still-valid, authorized follow-up enters the host outbox. Resolved or unauthorized follow-ups produce no message work.",
    },
    null,
    2,
  ),
);
