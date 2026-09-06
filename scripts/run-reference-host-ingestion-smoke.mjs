import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createReferenceHostHttpServer,
  ReferenceHostService,
} from "../apps/reference-host/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleModelAdapter,
  OpenAICompatibleRelevanceRouter,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "wakeintent-host-ingestion-smoke-"),
);
const runAt = new Date().toISOString();
const maxHttpRequests = 3;
let attemptedHttpRequests = 0;
const reportPath = resolve(
  root,
  "reports",
  "host-ingestion-smoke",
  `${runAt.replaceAll(":", "-")}.json`,
);

function usageSummary(records) {
  const sum = (field) => {
    const values = records.map((record) => record.usage[field]);
    return values.every((value) => typeof value === "number")
      ? values.reduce((total, value) => total + value, 0)
      : null;
  };
  const costs = records.map((record) => record.costUsd);
  return {
    calls: records.length,
    attempts: records.reduce((total, record) => total + record.attempts, 0),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
    costUsd: costs.every((value) => typeof value === "number")
      ? costs.reduce((total, value) => total + value, 0)
      : null,
    requestIds: records.map((record) => record.requestId),
    phases: records.map((record) => ({
      schemaName: record.schemaName,
      phase: record.phase,
      reasoningEffort: record.reasoningEffort,
    })),
  };
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const config = {
  ...configFromEnv(),
  maxRetries: 0,
  beforeRequestAttempt: () => {
    attemptedHttpRequests += 1;
    if (attemptedHttpRequests > maxHttpRequests) {
      throw new Error(
        `Smoke request budget exceeded: ${attemptedHttpRequests}/${maxHttpRequests}`,
      );
    }
  },
};
const modelAdapter = new OpenAICompatibleModelAdapter(config);
const routingClient = new OpenAICompatibleStructuredClient(config);
const runtime = {
  candidateGenerator: modelAdapter,
  semanticReevaluator: modelAdapter,
  relevanceRouter: new OpenAICompatibleRelevanceRouter(routingClient),
  getTelemetrySnapshot: () => ({
    candidateAndDecisionCalls: [...modelAdapter.getCallRecords()],
    relevanceCalls: [...routingClient.getCallRecords()],
  }),
};
const service = await ReferenceHostService.open({
  intentStorePath: join(temporaryDirectory, "intents.json"),
  outboxPath: join(temporaryDirectory, "outbox.json"),
  eventStorePath: join(temporaryDirectory, "events.json"),
  conversationRuntime: runtime,
});
const server = createReferenceHostHttpServer(service);

let report;
try {
  const baseUrl = await listen(server);
  const conversationUrl = `${baseUrl}/v1/conversations/${encodeURIComponent("conversation:study-smoke")}/events`;
  const firstRequest = {
    events: [
      {
        id: "event:study-plan-smoke",
        conversationId: "conversation:study-smoke",
        actor: "user",
        occurredAt: "2026-09-04T09:00:00.000Z",
        content:
          "我打算明天学完操作系统第三章，但进程同步一直没搞懂。学完后可以关心一下我的进度。",
        metadata: { synthetic: true },
      },
    ],
    target: { kind: "user", id: "student:synthetic" },
    now: "2026-09-04T09:01:00.000Z",
    timeZone: "Asia/Hong_Kong",
    idempotencyKey: "host-smoke:study:turn-1",
    activationThreshold: 0.5,
    routePolicyVersion: "host-smoke-route-0.1",
  };
  const first = await requestJson(conversationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(firstRequest),
  });
  const intent = first.plan?.intents?.find((item) => item.status === "active");
  assert(intent, "The first turn must produce an active ContactIntent");

  const secondRequest = {
    ...firstRequest,
    events: [
      {
        id: "event:study-finished-smoke",
        conversationId: "conversation:study-smoke",
        actor: "user",
        occurredAt: "2026-09-04T15:00:00.000Z",
        content: "我已经把第三章学完了，进程同步也弄懂了，不用再问这件事。",
        metadata: { synthetic: true },
      },
    ],
    now: "2026-09-04T15:01:00.000Z",
    idempotencyKey: "host-smoke:study:turn-2",
  };
  const second = await requestJson(conversationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondRequest),
  });
  const selection = second.plan?.selections?.find(
    (item) => item.intentId === intent.id,
  );
  assert(selection, "The completion event must route to the active intent");
  assert(
    selection.effect === "resolve" || selection.effect === "cancel",
    "The completion event must close the intent",
  );

  const evaluation = await requestJson(`${baseUrl}/v1/model-evaluations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      now: secondRequest.now,
      policyVersion: "host-smoke-decision-0.1",
      routeClosureThreshold: 0.9,
      userStates: {
        "user:student:synthetic": {
          authorization: "granted",
          remainingContactBudget: 1,
        },
      },
    }),
  });
  const replay = await requestJson(conversationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondRequest),
  });
  const outbox = await requestJson(`${baseUrl}/v1/outbox`);
  const allCalls = [
    ...first.modelCalls.candidateAndDecisionCalls,
    ...first.modelCalls.relevanceCalls,
    ...second.modelCalls.candidateAndDecisionCalls,
    ...second.modelCalls.relevanceCalls,
    ...evaluation.modelCalls.candidateAndDecisionCalls,
    ...evaluation.modelCalls.relevanceCalls,
  ];
  const item = evaluation.evaluation.results[0];
  const passed =
    first.outcome === "created" &&
    first.modelCalls.candidateAndDecisionCalls.length === 1 &&
    first.modelCalls.relevanceCalls.length === 0 &&
    second.modelCalls.candidateAndDecisionCalls.length === 1 &&
    second.modelCalls.relevanceCalls.length === 1 &&
    item?.source === "route-closure" &&
    (item.decision.action === "resolve" || item.decision.action === "cancel") &&
    evaluation.evaluation.work.semanticCalls === 0 &&
    evaluation.evaluation.work.contactDecisions === 0 &&
    evaluation.modelCalls.candidateAndDecisionCalls.length === 0 &&
    evaluation.modelCalls.relevanceCalls.length === 0 &&
    replay.outcome === "duplicate" &&
    replay.modelWorkPerformed === false &&
    replay.modelCalls.candidateAndDecisionCalls.length === 0 &&
    replay.modelCalls.relevanceCalls.length === 0 &&
    outbox.items.length === 0 &&
    allCalls.length === 3;

  report = {
    schemaVersion: "0.1.0",
    kind: "reference-host-conversation-ingestion-smoke",
    syntheticData: true,
    runAt,
    passed,
    model: config.model,
    apiMode: config.apiMode,
    maxHttpRequests,
    attemptedHttpRequests,
    firstTurn: {
      outcome: first.outcome,
      extractedIntent: intent,
      modelCalls: first.modelCalls,
    },
    invalidatingTurn: {
      outcome: second.outcome,
      selection,
      modelCalls: second.modelCalls,
    },
    evaluation: {
      result: item,
      work: evaluation.evaluation.work,
      modelCalls: evaluation.modelCalls,
    },
    idempotentReplay: {
      outcome: replay.outcome,
      modelWorkPerformed: replay.modelWorkPerformed,
      modelCalls: replay.modelCalls,
    },
    outboxCount: outbox.items.length,
    usage: usageSummary(allCalls),
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  if (server.listening) await close(server);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
