import {
  FakeClock,
  extractContactIntents,
  reevaluateContactIntent,
} from "../packages/core/dist/index.js";

let sequence = 0;
const idGenerator = (kind) => `${kind}-${++sequence}`;
const initialEvent = {
  id: "event-plan",
  conversationId: "conversation-1",
  actor: "user",
  occurredAt: "2026-09-01T09:00:00.000Z",
  content: "周五应该能收到面试结果。",
};

const [intent] = await extractContactIntents({
  events: [initialEvent],
  target: { kind: "user", id: "user-1" },
  clock: new FakeClock("2026-09-01T09:01:00.000Z"),
  idGenerator,
  generator: {
    async generate() {
      return [
        {
          subject: "询问面试结果",
          reason: "用户预计周五收到面试结果，之后可能值得关心。",
          evidence: [{ eventId: "event-plan", quote: initialEvent.content }],
          notBefore: "2026-09-04T09:00:00.000Z",
          expiresAt: "2026-09-11T09:00:00.000Z",
          cancellationHints: ["用户已经说明结果", "用户要求不要再问"],
          priority: 0.7,
          interruptionCost: 0.3,
          confidence: 0.92,
        },
      ];
    },
  },
  policy: { activationThreshold: 0.8 },
});

if (!intent) {
  throw new Error("Expected the demo to extract one intent");
}

const common = {
  clock: new FakeClock("2026-09-04T10:00:00.000Z"),
  idGenerator,
  policyVersion: "demo-0.1",
  userState: { authorization: "granted", remainingContactBudget: 1 },
};

const contactResult = await reevaluateContactIntent({
  ...common,
  intent,
  latestEvents: [],
  semanticReevaluator: {
    async evaluate() {
      return {
        action: "contact",
        reason: "已进入合理时间窗口，且没有新信息表明话题失效。",
        evidenceRefs: ["event-plan"],
        counterEvidenceRefs: [],
        confidence: 0.86,
        nextEvaluationAt: null,
      };
    },
  },
});

const resultEvent = {
  id: "event-result",
  conversationId: "conversation-1",
  actor: "user",
  occurredAt: "2026-09-04T09:30:00.000Z",
  content: "拿到 offer 了。",
};
const resolvedResult = await reevaluateContactIntent({
  ...common,
  intent,
  latestEvents: [resultEvent],
  semanticReevaluator: {
    async evaluate() {
      return {
        action: "resolve",
        reason: "用户已经主动说明结果，不应再次询问。",
        evidenceRefs: ["event-plan"],
        counterEvidenceRefs: ["event-result"],
        confidence: 0.98,
        nextEvaluationAt: null,
      };
    },
  },
});

let semanticCalls = 0;
const cancelledResult = await reevaluateContactIntent({
  ...common,
  intent,
  latestEvents: [],
  cancellation: {
    reason: "用户明确要求不要再问这件事。",
    evidenceRef: "event-cancel",
  },
  semanticReevaluator: {
    async evaluate() {
      semanticCalls += 1;
      throw new Error("Hard cancellation must prevent semantic evaluation");
    },
  },
});

const output = {
  note: "This demo uses deterministic fake model outputs and makes no API calls.",
  extracted: {
    id: intent.id,
    status: intent.status,
    subject: intent.subject,
    notBefore: intent.notBefore,
    expiresAt: intent.expiresAt,
  },
  branches: [
    {
      scenario: "没有新信息",
      decision: contactResult.decision.action,
      resultingStatus: contactResult.intent.status,
    },
    {
      scenario: "用户已经说明结果",
      decision: resolvedResult.decision.action,
      resultingStatus: resolvedResult.intent.status,
    },
    {
      scenario: "用户明确取消",
      decision: cancelledResult.decision.action,
      resultingStatus: cancelledResult.intent.status,
      semanticModelCalls: semanticCalls,
    },
  ],
};

console.log(JSON.stringify(output, null, 2));

