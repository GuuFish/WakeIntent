import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ContextAwareBaseline, recentContext } from "../packages/eval/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleModelAdapter,
  OpenAICompatibleRelevanceRouter,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";
import { ReferenceHostService } from "../apps/reference-host/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = resolve(root, "packages/eval/fixtures/context-aware-v1.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const execute = process.argv.includes("--execute");
const required = ["normal", "resolved", "cancelled", "expired", "busy", "unanswered", "multiple", "long", "restart", "duplicate", "negative", "spontaneous"];

function validateFixture() {
  if (fixture.version !== "1.0.0" || fixture.synthetic !== true) throw new Error("Fixture must be frozen synthetic v1");
  if (fixture.scenarios.length !== 12) throw new Error("Fixture must contain exactly 12 scenarios");
  const ids = fixture.scenarios.map((scenario) => scenario.id);
  for (const id of required) if (!ids.includes(id)) throw new Error("Missing scenario " + id);
  if (new Set(ids).size !== ids.length) throw new Error("Scenario IDs must be unique");
  for (const scenario of fixture.scenarios) {
    if (!scenario.steps?.length) throw new Error("Scenario has no steps: " + scenario.id);
    for (const step of scenario.steps) {
      if (!Number.isFinite(Date.parse(step.now))) throw new Error("Invalid step time");
      if (!step.expected?.allowedActions?.length) throw new Error("Missing frozen scoring");
    }
  }
}
validateFixture();

const nonReplaySteps = fixture.scenarios.flatMap((scenario) => scenario.steps).filter((step) => !step.replay).length;
const ingestionBatches = fixture.scenarios.flatMap((scenario) => scenario.steps).filter((step) => step.events?.length && !step.replay).length;
const routedBatches = fixture.scenarios.flatMap((scenario) => scenario.steps.slice(1)).filter((step) => step.events?.length && !step.replay).length;
const dueCheckpoints = fixture.scenarios.flatMap((scenario) => scenario.steps).filter((step) => !step.replay && !step.events?.length).length;
const diagnosticCalls = fixture.scenarios.flatMap((scenario) => scenario.steps).filter((step) => step.archiveDiagnostic).length;
const plan = {
  frozenScenarios: fixture.scenarios.length,
  checkpoints: fixture.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0),
  primaryBaselineCalls: nonReplaySteps,
  diagnosticBaselineCalls: diagnosticCalls,
  wakeIntentCandidateCalls: ingestionBatches,
  wakeIntentRouterUpperBound: routedBatches,
  wakeIntentSemanticUpperBound: dueCheckpoints + routedBatches,
};
plan.estimatedLogicalCallsUpperBound =
  plan.primaryBaselineCalls + plan.diagnosticBaselineCalls + plan.wakeIntentCandidateCalls +
  plan.wakeIntentRouterUpperBound + plan.wakeIntentSemanticUpperBound;
plan.maxHttpAttempts = fixture.maxHttpRequests;

if (!execute) {
  console.log(JSON.stringify({ mode: "plan", fixturePath, modelCalls: plan, frozenScenarioIds: required }, null, 2));
  process.exit(0);
}

let attemptedHttpRequests = 0;
const config = {
  ...configFromEnv(),
  maxRetries: fixture.maxRetries,
  beforeRequestAttempt: () => {
    attemptedHttpRequests += 1;
    if (attemptedHttpRequests > fixture.maxHttpRequests) {
      throw new Error("Experiment HTTP request budget exceeded: " + attemptedHttpRequests + "/" + fixture.maxHttpRequests);
    }
  },
};
const wakeAdapter = new OpenAICompatibleModelAdapter(config);
const routeClient = new OpenAICompatibleStructuredClient(config);
const baselineClient = new OpenAICompatibleStructuredClient(config);
const runtime = {
  candidateGenerator: wakeAdapter,
  semanticReevaluator: wakeAdapter,
  relevanceRouter: new OpenAICompatibleRelevanceRouter(routeClient),
  getTelemetrySnapshot: () => ({
    candidateAndDecisionCalls: [...wakeAdapter.getCallRecords()],
    relevanceCalls: [...routeClient.getCallRecords()],
  }),
};
const baseline = new ContextAwareBaseline(baselineClient);
const allEventIds = new Set(fixture.scenarios.flatMap((scenario) =>
  scenario.steps.flatMap((step) => step.events ?? []).map((event) => event.id)));

function callSlice(client, before) {
  return client.getCallRecords().slice(before).map((record) => ({ ...record }));
}
function combineUsage(records) {
  const knownSum = (field) => {
    const values = records.map((record) => record.usage[field]);
    return values.every((value) => typeof value === "number") ? values.reduce((a, b) => a + b, 0) : null;
  };
  const costs = records.map((record) => record.costUsd);
  return {
    calls: records.length,
    attempts: records.reduce((sum, record) => sum + record.attempts, 0),
    inputTokens: knownSum("inputTokens"),
    outputTokens: knownSum("outputTokens"),
    totalTokens: knownSum("totalTokens"),
    costUsd: costs.every((value) => typeof value === "number") ? costs.reduce((a, b) => a + b, 0) : null,
  };
}
function outcomeAction(decisions) {
  if (decisions.some((item) => item.action === "contact")) return "contact";
  if (decisions.some((item) => item.action === "defer")) return "defer";
  return "silent";
}
function wakeDecisionView(evaluation) {
  return evaluation.results
    .filter((item) => item.decision)
    .map((item) => ({
      action: item.decision.action,
      kind: item.decision.action === "contact" ? "intent_driven" : "none",
      recognition:
        item.decision.action === "resolve" ? "resolved" :
        item.decision.action === "cancel" ? "cancelled" :
        item.decision.action === "expire" ? "expired" : "none",
      reason: item.decision.reason,
      evidenceRefs: [...new Set([...item.decision.evidenceRefs, ...item.decision.counterEvidenceRefs])],
      nextEvaluationAt: item.decision.nextEvaluationAt,
      intentId: item.intentId,
      source: item.source,
    }));
}
function scoreStep(expected, decisions, error) {
  if (error) return { passed: false, actionCorrect: false, contactsCorrect: false, evidenceCorrect: false, recognitionCorrect: false, explanationConsistent: false };
  const action = outcomeAction(decisions);
  const contactDecisions = decisions.filter((item) => item.action === "contact");
  const spontaneousAllowed = expected.spontaneousOpportunity === true &&
    contactDecisions.every((item) => item.kind === "spontaneous");
  const expectedContacts = expected.contacts ?? [];
  const contactsCorrect = spontaneousAllowed || (
    contactDecisions.length === expectedContacts.length &&
    expectedContacts.every((wanted) => contactDecisions.some((actual) =>
      actual.kind === wanted.kind && wanted.evidenceRefs.every((id) => actual.evidenceRefs.includes(id))))
  );
  const refs = new Set(decisions.flatMap((item) => item.evidenceRefs ?? []));
  const evidenceCorrect = (expected.evidenceRefs ?? []).every((id) => refs.has(id)) &&
    expectedContacts.every((wanted) => wanted.evidenceRefs.every((id) => refs.has(id)));
  const recognitionCorrect = !expected.recognition ||
    decisions.some((item) => item.recognition === expected.recognition);
  const explanationConsistent = decisions.every((item) =>
    typeof item.reason === "string" && item.reason.trim().length > 0 &&
    (item.action !== "contact" || (item.evidenceRefs.length > 0 && item.kind !== "none")));
  const actionCorrect = expected.allowedActions.includes(action);
  return {
    passed: actionCorrect && contactsCorrect && evidenceCorrect && recognitionCorrect && explanationConsistent,
    actionCorrect, contactsCorrect, evidenceCorrect, recognitionCorrect, explanationConsistent,
  };
}
async function auditView(service) {
  const records = await service.listIntents();
  return Promise.all(records.map(async (record) => ({
    intent: record.intent,
    revision: record.revision,
    nextEvaluationAt: record.nextEvaluationAt,
    audit: await service.intentStore.listAuditEvents(record.intent.id),
  })));
}
function traceScore(arm, scenarioRows) {
  if (arm === "wakeIntent") {
    const records = scenarioRows.at(-1)?.state ?? [];
    const valid = records.every((record) =>
      record.intent.evidence.length > 0 &&
      record.intent.evidence.every((evidence) => allEventIds.has(evidence.eventId)) &&
      record.audit.every((audit) => {
        const value = audit.decision ?? audit.activation ?? audit.request ?? audit.failure;
        const refs = [...(value?.evidenceRefs ?? []), ...(value?.counterEvidenceRefs ?? []), ...(value?.eventIds ?? [])];
        return refs.every((id) => allEventIds.has(id));
      }));
    return { applicable: true, passed: valid, establishedIntents: records.map((record) => ({
      intentId: record.intent.id,
      evidenceRefs: record.intent.evidence.map((item) => item.eventId),
      transitions: record.audit,
    })) };
  }
  const decisions = scenarioRows.flatMap((row) => row.decisions);
  return {
    applicable: false,
    passed: decisions.every((decision) => decision.evidenceRefs.every((id) => allEventIds.has(id))),
    reason: "Context-aware baseline has decision evidence but no persistent intent lifecycle to audit.",
  };
}
async function runScenario(scenario) {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-context-comparison-"));
  const paths = {
    intentStorePath: join(directory, "intents.json"),
    eventStorePath: join(directory, "events.json"),
    outboxPath: join(directory, "outbox.json"),
  };
  let service = await ReferenceHostService.open({ ...paths, conversationRuntime: runtime });
  const events = [];
  const baselineDeliveries = [];
  const savedRequests = new Map();
  const wakeRows = [];
  const baselineRows = [];
  const diagnostics = [];
  try {
    for (const step of scenario.steps) {
      const userState = step.userState ?? { authorization: "granted", remainingContactBudget: 2 };
      let processResult = null;
      let wakeError = null;
      let baselineError = null;
      const wakeBefore = wakeAdapter.getCallRecords().length;
      const routeBefore = routeClient.getCallRecords().length;
      const baselineBefore = baselineClient.getCallRecords().length;
      try {
        if (step.replay) {
          const request = savedRequests.get(step.replay);
          if (!request) throw new Error("Missing replay request " + step.replay);
          processResult = await service.processConversation(request);
        } else if (step.events?.length) {
          events.push(...step.events);
          const request = {
            conversationId: scenario.id,
            events: step.events,
            target: { kind: "user", id: "synthetic:" + scenario.id },
            now: step.now,
            timeZone: fixture.timeZone,
            idempotencyKey: "context-comparison:" + scenario.id + ":" + step.id,
            activationThreshold: 0.5,
            routePolicyVersion: "context-comparison-route-v1",
          };
          savedRequests.set(step.id, request);
          processResult = await service.processConversation(request);
        }
        if (step.restart) service = await ReferenceHostService.open({ ...paths, conversationRuntime: runtime });
        const evaluation = await service.runModelEvaluation({
          now: step.now,
          policyVersion: "context-comparison-decision-v1",
          contextEventLimit: fixture.recentEventLimit,
          routeClosureThreshold: 0.9,
          userStates: { ["user:synthetic:" + scenario.id]: userState },
        });
        const decisions = wakeDecisionView(evaluation.evaluation);
        wakeRows.push({
          stepId: step.id,
          decisions,
          score: scoreStep(step.expected, decisions, null),
          process: processResult ? { outcome: processResult.outcome, modelWorkPerformed: processResult.modelWorkPerformed } : null,
          modelCalls: [...callSlice(wakeAdapter, wakeBefore), ...callSlice(routeClient, routeBefore)],
          state: await auditView(service),
        });
      } catch (error) {
        wakeError = error instanceof Error ? error.message : String(error);
        wakeRows.push({
          stepId: step.id, decisions: [], score: scoreStep(step.expected, [], wakeError), error: wakeError,
          process: processResult ? { outcome: processResult.outcome, modelWorkPerformed: processResult.modelWorkPerformed } : null,
          modelCalls: [...callSlice(wakeAdapter, wakeBefore), ...callSlice(routeClient, routeBefore)],
          state: await auditView(service),
        });
      }
      try {
        let decisions = [];
        if (!step.replay) {
          decisions = await baseline.decide({
            events: recentContext(events, step.now),
            now: step.now,
            timeZone: fixture.timeZone,
            userState,
            deliveries: baselineDeliveries,
          });
          for (const decision of decisions.filter((item) => item.action === "contact")) {
            baselineDeliveries.push({ at: step.now, evidenceRefs: decision.evidenceRefs, reason: decision.reason });
          }
        }
        baselineRows.push({
          stepId: step.id, decisions, score: scoreStep(step.expected, decisions, null),
          modelCalls: callSlice(baselineClient, baselineBefore),
        });
        if (step.archiveDiagnostic) {
          const before = baselineClient.getCallRecords().length;
          const full = await baseline.decide({
            events: events.filter((event) => Date.parse(event.occurredAt) <= Date.parse(step.now)),
            now: step.now, timeZone: fixture.timeZone, userState, deliveries: baselineDeliveries,
          });
          diagnostics.push({
            kind: "full-archive-context",
            stepId: step.id,
            decisions: full,
            score: scoreStep(step.expected, full, null),
            modelCalls: callSlice(baselineClient, before),
          });
        }
      } catch (error) {
        baselineError = error instanceof Error ? error.message : String(error);
        baselineRows.push({
          stepId: step.id, decisions: [], score: scoreStep(step.expected, [], baselineError),
          error: baselineError, modelCalls: callSlice(baselineClient, baselineBefore),
        });
      }
    }
    return {
      id: scenario.id, title: scenario.title, kind: scenario.kind,
      wakeIntent: { rows: wakeRows, trace: traceScore("wakeIntent", wakeRows) },
      contextAware: { rows: baselineRows, trace: traceScore("contextAware", baselineRows) },
      diagnostics,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const results = [];
for (const scenario of fixture.scenarios) {
  process.stdout.write("Running " + scenario.id + "...\n");
  results.push(await runScenario(scenario));
}
function armMetrics(arm) {
  const rows = results.flatMap((scenario) => scenario[arm].rows.map((row) => ({ ...row, scenarioId: scenario.id, scenarioKind: scenario.kind })));
  const scored = rows.filter((row) => row.stepId !== "initial" && row.stepId !== "replay-initial");
  const intentRows = scored.filter((row) => row.scenarioKind === "intent_driven");
  const noContactRows = scored.filter((row) => {
    const scenario = fixture.scenarios.find((item) => item.id === row.scenarioId);
    const expected = scenario.steps.find((item) => item.id === row.stepId).expected;
    return (expected.contacts ?? []).length === 0 && !expected.spontaneousOpportunity;
  });
  const contacts = scored.flatMap((row) => row.decisions.filter((decision) => decision.action === "contact").map((decision) => ({ row, decision })));
  const validContacts = contacts.filter(({ row }) => row.score.contactsCorrect);
  const records = results.flatMap((scenario) => scenario[arm].rows.flatMap((row) => row.modelCalls));
  return {
    scoredCheckpoints: scored.length,
    passed: scored.filter((row) => row.score.passed).length,
    passRate: scored.filter((row) => row.score.passed).length / scored.length,
    intentDrivenPassRate: intentRows.filter((row) => row.score.passed).length / intentRows.length,
    effectiveContactRate: contacts.length ? validContacts.length / contacts.length : 0,
    falseOutreachRate: noContactRows.length ? noContactRows.filter((row) => row.decisions.some((d) => d.action === "contact")).length / noContactRows.length : 0,
    silenceOrDeferAccuracy: noContactRows.filter((row) => row.score.actionCorrect && row.score.contactsCorrect).length / noContactRows.length,
    reasoningBehaviorConsistency: scored.filter((row) => row.score.explanationConsistent).length / scored.length,
    evidenceAccuracy: scored.filter((row) => row.score.evidenceCorrect).length / scored.length,
    lifecycleTraceability: arm === "wakeIntent"
      ? results.filter((scenario) => scenario[arm].trace.passed).length / results.length
      : null,
    usage: combineUsage(records),
  };
}
const metrics = { wakeIntent: armMetrics("wakeIntent"), contextAware: armMetrics("contextAware") };
const byId = Object.fromEntries(results.map((scenario) => [scenario.id, scenario]));
const hard = ["resolved", "cancelled", "expired", "long", "restart", "duplicate"];
const passScenario = (arm, id) => byId[id][arm].rows.filter((row) => row.stepId !== "initial" && row.stepId !== "replay-initial").every((row) => row.score.passed);
const wakeHardWins = hard.filter((id) => passScenario("wakeIntent", id) && !passScenario("contextAware", id));
const wakeTokens = metrics.wakeIntent.usage.totalTokens;
const baselineTokens = metrics.contextAware.usage.totalTokens;
const tokenRatio = typeof wakeTokens === "number" && typeof baselineTokens === "number" && baselineTokens > 0 ? wakeTokens / baselineTokens : null;
let conclusion = 3;
if (
  metrics.wakeIntent.intentDrivenPassRate >= metrics.contextAware.intentDrivenPassRate + 0.1 &&
  metrics.wakeIntent.falseOutreachRate <= metrics.contextAware.falseOutreachRate &&
  passScenario("wakeIntent", "restart") && passScenario("wakeIntent", "duplicate") &&
  metrics.wakeIntent.lifecycleTraceability >= 0.9 &&
  (tokenRatio === null || tokenRatio <= 2)
) conclusion = 1;
else if (
  metrics.wakeIntent.lifecycleTraceability >= 0.9 &&
  metrics.wakeIntent.intentDrivenPassRate >= metrics.contextAware.intentDrivenPassRate - 0.1 &&
  (wakeHardWins.length > 0 || metrics.contextAware.lifecycleTraceability === null) &&
  (tokenRatio === null || tokenRatio <= 3)
) conclusion = 2;

const diagnosticRecords = results.flatMap((scenario) => scenario.diagnostics.flatMap((item) => item.modelCalls));
const runAt = new Date().toISOString();
const report = {
  schemaVersion: "1.0.0",
  kind: "context-aware-comparison",
  syntheticData: true,
  frozenFixture: "packages/eval/fixtures/context-aware-v1.json",
  runAt,
  model: config.model,
  apiMode: config.apiMode,
  plan,
  attemptedHttpRequests,
  primaryMetrics: metrics,
  diagnosticUsage: combineUsage(diagnosticRecords),
  tokenRatio,
  wakeHardWins,
  conclusion,
  conclusionLabels: {
    1: "WakeIntent 显示出足以支持独立 ContactIntent 模块的价值",
    2: "WakeIntent 有工程价值，但目前更适合作为主动聊天应用的内部子系统，与 Context-aware 层组合",
    3: "WakeIntent 没有显示出足以抵消复杂度与 Token 成本的优势，应收缩或合并实现",
  },
  results,
};
const reportPath = resolve(root, "reports", "context-aware-comparison", runAt.replaceAll(":", "-") + ".json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ reportPath, attemptedHttpRequests, metrics, tokenRatio, wakeHardWins, conclusion, label: report.conclusionLabels[conclusion] }, null, 2));
