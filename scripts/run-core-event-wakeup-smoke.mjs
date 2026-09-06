import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEvaluationRunTrace,
  evaluateDueContactIntents,
  extractContactIntents,
  FakeClock,
  registerExtractedIntents,
  requestRelevantEvaluations,
} from "../packages/core/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleModelAdapter,
  OpenAICompatibleRelevanceRouter,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";
import { openJsonContactIntentStore } from "../packages/store-json/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modeArgument = process.argv.find((argument) =>
  argument.startsWith("--mode="),
);
const mode = modeArgument?.slice("--mode=".length) ?? "cancellation";
if (mode !== "cancellation" && mode !== "timing") {
  throw new Error("--mode must be cancellation or timing");
}
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "wakeintent-core-api-smoke-"),
);
const storePath = join(temporaryDirectory, "wakeintent.json");
const runAt = new Date().toISOString();
const reportPath = resolve(
  root,
  "reports",
  "core-api-smoke",
  `${runAt.replaceAll(":", "-")}-${mode}.json`,
);

const usageSummary = (records) => {
  const sum = (field) => {
    const values = records.map((record) => record.usage[field]);
    return values.every((value) => typeof value === "number")
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const costs = records.map((record) => record.costUsd);
  return {
    calls: records.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    costUsd: costs.every((value) => typeof value === "number")
      ? costs.reduce((total, value) => total + value, 0)
      : null,
    attempts: records.reduce((total, record) => total + record.attempts, 0),
    requestIds: records.flatMap((record) =>
      record.requestId ? [record.requestId] : [],
    ),
  };
};

const config = { ...configFromEnv(), maxRetries: 0 };
const adapter = new OpenAICompatibleModelAdapter(config);
const routingClient = new OpenAICompatibleStructuredClient(config);
const router = new OpenAICompatibleRelevanceRouter(routingClient);
let sequence = 0;
const idGenerator = (kind) => `core-smoke-${kind}-${++sequence}`;
const initialEvent = {
  id: "synthetic-job-fair-plan",
  conversationId: "synthetic-conversation",
  actor: "user",
  occurredAt: "2026-09-01T09:00:00.000Z",
  content: "我周五准备去参加双选会，结束后可能想聊聊结果。",
  metadata: { synthetic: true },
};
const invalidatingEvent = {
  id:
    mode === "cancellation"
      ? "synthetic-found-internship"
      : "synthetic-job-fair-timing-update",
  conversationId: "synthetic-conversation",
  actor: "user",
  occurredAt: "2026-09-03T12:00:00.000Z",
  content:
    mode === "cancellation"
      ? "我已经找到实习了，不去双选会了，这件事不用再问我。"
      : "双选会还会参加，不过主办方通知改到周五晚上才结束，结束前不用联系我。",
  metadata: { synthetic: true },
};

let report;
try {
  const intents = await extractContactIntents({
    events: [initialEvent],
    target: { kind: "user", id: "synthetic-user" },
    clock: new FakeClock("2026-09-01T09:01:00.000Z"),
    idGenerator,
    generator: adapter,
    policy: { activationThreshold: 0.5 },
  });
  const activeIntent = intents.find((intent) => intent.status === "active");
  if (!activeIntent) {
    throw new Error("The model did not extract an active ContactIntent");
  }

  const firstStore = await openJsonContactIntentStore(storePath);
  await registerExtractedIntents({
    store: firstStore,
    extractionRunId: "core-api-smoke-extraction",
    intents: [activeIntent],
  });
  const routed = await requestRelevantEvaluations({
    store: firstStore,
    events: [invalidatingEvent],
    now: "2026-09-03T12:01:00.000Z",
    router,
    routeRunId: "core-api-smoke-route",
    policyVersion: "core-api-smoke-route-0.1",
  });

  const restartedStore = await openJsonContactIntentStore(storePath);
  let fallbackContextLoads = 0;
  const evaluation = await evaluateDueContactIntents({
    store: restartedStore,
    clock: new FakeClock("2026-09-03T12:01:00.000Z"),
    policyVersion: "core-api-smoke-decision-0.1",
    routeClosureThreshold: 0.7,
    contextProvider: {
      async load() {
        fallbackContextLoads += 1;
        return {
          latestEvents: [invalidatingEvent],
          userState: { authorization: "granted", remainingContactBudget: 1 },
        };
      },
    },
    semanticReevaluator: adapter,
  });
  const item = evaluation.results[0];
  const finalRecord = await restartedStore.getIntent(activeIntent.id);
  const passed =
    item?.outcome === "committed" &&
    (mode === "cancellation"
      ? item.source === "route-closure" &&
        item.decision.action === "cancel" &&
        finalRecord?.intent.status === "cancelled" &&
        fallbackContextLoads === 0
      : item.source === "hard-gate" &&
        item.decision.action === "defer" &&
        finalRecord?.intent.status === "active" &&
        fallbackContextLoads === 1 &&
        evaluation.work.semanticCalls === 1 &&
        evaluation.work.contactDecisions === 0);
  const unifiedTrace = buildEvaluationRunTrace({
    traceId: `core-api-smoke:${mode}:${runAt}`,
    startedAt: runAt,
    completedAt: new Date().toISOString(),
    trigger: "context-change",
    routing: routed,
    evaluation,
    modelCalls: [
      ...adapter.getCallRecords(),
      ...routingClient.getCallRecords(),
    ],
    metadata: {
      syntheticData: true,
      model: config.model,
      apiMode: config.apiMode,
      mode,
    },
  });

  report = {
    schemaVersion: "0.1.0",
    kind: "core-event-wakeup-api-smoke",
    mode,
    syntheticData: true,
    runAt,
    passed,
    model: config.model,
    apiMode: config.apiMode,
    maxHttpRequests: mode === "cancellation" ? 2 : 3,
    initialEvent,
    invalidatingEvent,
    extractedIntent: activeIntent,
    routing: {
      selections: routed.routing.selections,
      persistedRequests: routed.requests.map((item) => item.request),
      audits: router.getAudits(),
    },
    afterRestart: {
      result:
        item?.outcome === "committed" || item?.outcome === "duplicate"
          ? {
              outcome: item.outcome,
              source: item.source,
              decision: item.decision,
            }
          : item
            ? { outcome: item.outcome, error: item.error.message }
            : null,
      finalStatus: finalRecord?.intent.status ?? null,
      fallbackContextLoads,
      evaluationWork: evaluation.work,
    },
    usage: {
      extractionAndFallbackDecision: usageSummary(adapter.getCallRecords()),
      relevanceRouting: usageSummary(routingClient.getCallRecords()),
    },
    unifiedTrace,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
