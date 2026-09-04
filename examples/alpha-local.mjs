import { resolve } from "node:path";

import {
  FakeClock,
  evaluateDueContactIntents,
  planNextWakeup,
  registerExtractedIntents,
} from "../packages/core/dist/index.js";
import { openJsonContactIntentStore } from "../packages/store-json/dist/index.js";

const stateArgument = process.argv.slice(2).find((argument) => argument !== "--");
const statePath = resolve(
  stateArgument ?? ".wakeintent/alpha-local-demo.json",
);

const intent = {
  schemaVersion: "0.1.0",
  id: "demo-job-fair",
  status: "active",
  subject: "双选会后续关心",
  reason: "用户计划周五参加双选会，临近时可能值得关心准备情况。",
  target: { kind: "user", id: "demo-user" },
  evidence: [
    {
      eventId: "demo-plan",
      quote: "我周五准备去参加双选会。",
    },
  ],
  notBefore: "2026-09-04T09:00:00.000Z",
  expiresAt: "2026-09-05T18:00:00.000Z",
  cancellationHints: ["用户已经找到实习", "用户决定不参加双选会"],
  priority: 0.8,
  interruptionCost: 0.3,
  confidence: 0.94,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
};

const staleIntent = {
  ...intent,
  id: "demo-stale-checkin",
  subject: "过时的普通近况问候",
  reason: "用户两天前提到可能想聊聊近期状态。",
  evidence: [{ eventId: "demo-old-chat", quote: "这两天有空再聊聊吧。" }],
  notBefore: "2026-09-02T09:00:00.000Z",
  expiresAt: "2026-09-10T00:00:00.000Z",
  priority: 0.3,
  interruptionCost: 0.7,
};

const initialStore = await openJsonContactIntentStore(statePath);
const registration = await registerExtractedIntents({
  store: initialStore,
  extractionRunId: "demo-extraction-1",
  intents: [intent, staleIntent],
});

// A new adapter instance simulates a process restart before the due window.
const restartedStore = await openJsonContactIntentStore(statePath);
const evaluationClock = new FakeClock("2026-09-04T10:00:00.000Z");
const wakeupPlan = await planNextWakeup({
  store: restartedStore,
  clock: evaluationClock,
});
let semanticCalls = 0;
const evaluation = await evaluateDueContactIntents({
  store: restartedStore,
  clock: evaluationClock,
  policyVersion: "demo-policy-0.1",
  lateWakePolicy: {
    maxLatenessMs: 6 * 60 * 60 * 1000,
    onTooLate: "silent",
  },
  contextProvider: {
    async load() {
      return {
        latestEvents: [
          {
            id: "demo-found-internship",
            conversationId: "demo-conversation",
            actor: "user",
            occurredAt: "2026-09-03T12:00:00.000Z",
            content: "我已经找到实习了，不去双选会了。",
          },
        ],
        userState: {
          authorization: "granted",
          remainingContactBudget: 1,
        },
      };
    },
  },
  semanticReevaluator: {
    async evaluate() {
      semanticCalls += 1;
      return {
        action: "cancel",
        reason: "用户已经找到实习并明确不再参加双选会，原联系理由失效。",
        evidenceRefs: ["demo-plan"],
        counterEvidenceRefs: ["demo-found-internship"],
        confidence: 0.99,
        nextEvaluationAt: null,
      };
    },
  },
});

const finalRecord = await restartedStore.getIntent(intent.id);
const staleFinalRecord = await restartedStore.getIntent(staleIntent.id);
const decisions = await restartedStore.listDecisions(intent.id);
const staleDecisions = await restartedStore.listDecisions(staleIntent.id);
const evaluationDecisions = evaluation.results.flatMap((result) =>
  result.outcome === "committed" || result.outcome === "duplicate"
    ? [
        {
          intentId: result.intentId,
          source: result.source,
          action: result.decision.action,
        },
      ]
    : [],
);

console.log(
  JSON.stringify(
    {
      note: "This demo is fully local and uses a deterministic fake semantic model.",
      statePath,
      registration: registration.results.map((result) => ({
        intentId: result.record.intent.id,
        outcome: result.outcome,
      })),
      simulatedRestart: true,
      wakeupPlan,
      dueCount: evaluation.dueCount,
      decisions: evaluationDecisions,
      semanticModelCalls: semanticCalls,
      work: evaluation.work,
      finalStatus: finalRecord?.intent.status,
      nextEvaluationAt: finalRecord?.nextEvaluationAt,
      staleIntent: {
        finalStatus: staleFinalRecord?.intent.status,
        nextEvaluationAt: staleFinalRecord?.nextEvaluationAt,
      },
      auditDecisionCount: decisions.length + staleDecisions.length,
      interpretation:
        finalRecord?.intent.status === "cancelled" &&
        staleFinalRecord?.nextEvaluationAt === null
          ? "双选会理由已失效并取消；过度迟到的低价值问候清除当前时间排期，两者都不会因原排期再次主动联系。"
          : "此状态文件可能已经运行过；当前没有需要重复处理的到期意图。",
    },
    null,
    2,
  ),
);
