import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareDecisionSequences,
  HybridRelevanceRouter,
  LONGITUDINAL_BASELINE_PROMPT_VERSION,
  ModelDueGatedBaselineAdapter,
  ModelRelevanceRouter,
  RELEVANCE_ROUTER_PROMPT_VERSION,
  runDueGatedBaselineTimeline,
  runWakeIntentTimeline,
  scoreAlphaClosureScenario,
  summarizeBaselineBehavior,
  summarizeWakeBehavior,
} from "../packages/eval/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleModelAdapter,
  OpenAICompatiblePolicySignalAdapter,
  OpenAICompatibleStructuredClient,
  WAKEINTENT_MODEL_PROMPT_VERSION,
  WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(root, "evals", "intent-continuity-value-v1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const execute = process.argv.includes("--execute");
const idsArgument = process.argv.find((value) => value.startsWith("--ids="));
const requestedIds = idsArgument
  ? new Set(idsArgument.slice(6).split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const scenarios = requestedIds
  ? dataset.scenarios.filter((scenario) => requestedIds.has(scenario.id))
  : dataset.scenarios;
if (scenarios.length === 0) throw new Error("No scenario matched --ids.");
if (requestedIds) {
  const found = new Set(scenarios.map((scenario) => scenario.id));
  const missing = [...requestedIds].filter((id) => !found.has(id));
  if (missing.length) throw new Error(`Unknown scenario ids: ${missing.join(", ")}`);
}
const repetitions = dataset.repetitions;

const planRows = scenarios.map((scenario) => {
  const contextSteps = scenario.steps.filter((step) => step.kind === "context").length;
  const scheduledSteps = scenario.steps.filter((step) => step.kind === "scheduled").length;
  const intentCount = scenario.expected.intentCount;
  const wakeUpper = 1 + contextSteps + contextSteps + intentCount * (contextSteps + scheduledSteps) + intentCount * scheduledSteps;
  const baselineUpper = 1 + scheduledSteps + intentCount * scheduledSteps;
  return {
    scenario: scenario.id,
    category: scenario.category,
    repetitions,
    syntheticEvents: scenario.initialEvents.length + scenario.steps.flatMap((step) => step.events).length,
    wakeRequestUpperBound: wakeUpper * repetitions,
    baselineRequestUpperBound: baselineUpper * repetitions,
  };
});
const requestUpperBound = planRows.reduce(
  (sum, row) => sum + row.wakeRequestUpperBound + row.baselineRequestUpperBound,
  0,
);

if (!execute) {
  console.table(planRows);
  console.log(`Scenarios: ${scenarios.length}; repetitions per paired scenario: ${repetitions}`);
  console.log(`System runs: ${scenarios.length * repetitions * 2}`);
  console.log(`Conservative logical/API request upper bound: ${requestUpperBound}`);
  console.log("This bound includes model-based routing/policy checks and a message-generation call for every possible CONTACT.");
  console.log("Transient network errors, 408, 429, and 5xx may retry once with the same idempotency key, but total HTTP attempts still cannot exceed this bound.");
  console.log("Dry run only: .env was not loaded and no API request was sent.");
  process.exit(0);
}

const outputSchema = {
  type: "object",
  additionalProperties: false,
  properties: { message: { type: "string", minLength: 1, maxLength: 500 } },
  required: ["message"],
};
const messageInstructions =
  "Write one concise, natural Chinese proactive message justified by the supplied CONTACT decision. Use the chronological conversation facts. Do not mention reminders, state machines, memories, intents, evidence IDs, or internal reasoning. Do not invent facts. Return JSON only.";

function sumUsage(records) {
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
  };
}

function eventsThrough(scenario, at) {
  return [
    ...scenario.initialEvents,
    ...scenario.steps
      .filter((step) => Date.parse(step.at) <= Date.parse(at))
      .flatMap((step) => step.events),
  ];
}

async function generateWakeMessages(client, scenario, result) {
  const messages = [];
  for (const trace of result.traces.filter((item) => item.decision.action === "contact")) {
    const intent = result.intents.find((item) => item.id === trace.intentId);
    const value = await client.generate({
      schemaName: "intent_continuity_outreach",
      schema: outputSchema,
      instructions: messageInstructions,
      input: {
        now: trace.at,
        timeZone: scenario.timeZone,
        conversation: eventsThrough(scenario, trace.at),
        decision: { action: trace.decision.action, reason: trace.decision.reason },
        futureCommitment: intent
          ? { subject: intent.subject, reason: intent.reason }
          : null,
      },
      phase: "decision",
    });
    messages.push({ at: trace.at, evidenceRef: intent?.evidence[0]?.eventId ?? null, message: value.message });
  }
  return messages;
}

async function generateBaselineMessages(client, scenario, memories, result) {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const messages = [];
  for (const trace of result.traces) {
    for (const decision of trace.decisions.filter((item) => item.action === "contact")) {
      const memory = memoryById.get(decision.memoryId);
      const value = await client.generate({
        schemaName: "intent_continuity_outreach",
        schema: outputSchema,
        instructions: messageInstructions,
        input: {
          now: trace.at,
          timeZone: scenario.timeZone,
          conversation: eventsThrough(scenario, trace.at),
          decision: { action: decision.action, reason: decision.reason },
          futureCommitment: memory ? { summary: memory.summary } : null,
        },
        phase: "decision",
      });
      messages.push({ at: trace.at, evidenceRef: memory?.evidenceRefs[0] ?? null, message: value.message });
    }
  }
  return messages;
}

const config = { ...configFromEnv(), maxRetries: 1 };
const resumeArgument = process.argv.find((value) => value.startsWith("--resume="));
let startedAt = new Date().toISOString();
let runId = startedAt.replaceAll(":", "-");
let reportDir = resolve(root, "reports", "intent-continuity-value", runId);
let reportPath = resolve(reportDir, "results.json");
let attemptedHttpRequests = 0;
let attemptLog = [];
let results = [];

if (resumeArgument) {
  const supplied = resumeArgument.slice("--resume=".length);
  reportPath = isAbsolute(supplied) ? supplied : resolve(root, supplied);
  const previous = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    previous.dataset?.version !== dataset.version ||
    previous.fairness?.model !== config.model ||
    previous.fairness?.apiMode !== config.apiMode ||
    previous.requestBudget?.maxLogicalRequests !== requestUpperBound
  ) {
    throw new Error("Resume report does not match this dataset, model, API mode, or request budget.");
  }
  startedAt = previous.startedAt;
  runId = previous.runId;
  reportDir = dirname(reportPath);
  attemptedHttpRequests = previous.requestBudget.attemptedHttpRequests ?? 0;
  attemptLog = previous.requestBudget.attemptLog ?? [];
  results = previous.results ?? [];
}

function makeConfig(runKey) {
  let logicalIndex = 0;
  return {
    ...config,
    requestIdFactory(identity) {
      const source = [runId, runKey, logicalIndex++, identity.schemaName, identity.phase ?? "none"].join(":");
      return createHash("sha256").update(source).digest("hex");
    },
    async beforeRequestAttempt(attempt) {
      if (attemptedHttpRequests >= requestUpperBound) {
        throw new Error(`HTTP request budget exhausted: ${attemptedHttpRequests}/${requestUpperBound}`);
      }
      attemptedHttpRequests += 1;
      attemptLog.push({
        runKey,
        schemaName: attempt.schemaName,
        phase: attempt.phase,
        requestId: attempt.requestId,
        attempt: attempt.attempt,
        at: new Date().toISOString(),
      });
      await persist("running");
    },
  };
}

function aggregate() {
  const completed = results.filter((result) => result.error === null);
  const wake = completed.map((result) => result.wakeintent.behavior);
  const baseline = completed.map((result) => result.baseline.behavior);
  const agreements = completed.reduce((sum, result) => sum + result.comparison.agreements, 0);
  const comparisons = completed.reduce((sum, result) => sum + result.comparison.comparisons, 0);
  const totals = (items, key) => items.reduce((sum, item) => sum + item[key], 0);
  const wakeExpected = totals(wake, "expectedContacts");
  const baselineExpected = totals(baseline, "expectedContacts");
  const wakeFalseDenominator = completed.reduce(
    (sum, result) => sum + result.scenario.expected.contactForbiddenEvidenceRefs.length,
    0,
  );
  const baselineFalseDenominator = wakeFalseDenominator;
  const wakeFalse = totals(wake, "falseOutreach");
  const baselineFalse = totals(baseline, "falseOutreach");
  const wakeMissed = totals(wake, "missedFollowup");
  const baselineMissed = totals(baseline, "missedFollowup");
  const falseRate = (count, denominator) => denominator === 0 ? null : count / denominator;
  const missedRate = (count, denominator) => denominator === 0 ? null : count / denominator;
  return {
    pairedRunsPlanned: scenarios.length * repetitions,
    pairedRunsCompleted: completed.length,
    errors: results.length - completed.length,
    decisionAgreement: {
      agreements,
      comparisons,
      rate: comparisons === 0 ? null : agreements / comparisons,
    },
    falseOutreach: {
      wakeintent: wakeFalse,
      baseline: baselineFalse,
      wakeintentRate: falseRate(wakeFalse, wakeFalseDenominator),
      baselineRate: falseRate(baselineFalse, baselineFalseDenominator),
      denominatorPerArm: wakeFalseDenominator,
    },
    missedFollowup: {
      wakeintent: wakeMissed,
      baseline: baselineMissed,
      wakeintentRate: missedRate(wakeMissed, wakeExpected),
      baselineRate: missedRate(baselineMissed, baselineExpected),
      expectedPerArm: Math.max(wakeExpected, baselineExpected),
    },
    usage: {
      wakeintent: sumUsage(completed.flatMap((item) => item.wakeintent.modelCallRecords)),
      baseline: sumUsage(completed.flatMap((item) => item.baseline.modelCallRecords)),
    },
    latencyMs: {
      wakeintent: completed.reduce((sum, item) => sum + item.wakeintent.latencyMs, 0),
      baseline: completed.reduce((sum, item) => sum + item.baseline.latencyMs, 0),
    },
  };
}

function createReport(status) {
  return {
    schemaVersion: "1.0.0",
    status,
    runId,
    startedAt,
    completedAt: status === "completed" ? new Date().toISOString() : null,
    dataset: {
      path: "evals/intent-continuity-value-v1.json",
      version: dataset.version,
      frozenAt: dataset.frozenAt,
      hypothesis: dataset.hypothesis,
      stopRule: dataset.stopRule,
    },
    fairness: {
      ...dataset.fairness,
      model: config.model,
      apiMode: config.apiMode,
      temperature: "omitted for both arms; identical provider default",
      retriesPerLogicalRequest: 1,
      promptVersions: {
        wakeintent: WAKEINTENT_MODEL_PROMPT_VERSION,
        policySignals: WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION,
        relevanceRouter: RELEVANCE_ROUTER_PROMPT_VERSION,
        baseline: LONGITUDINAL_BASELINE_PROMPT_VERSION,
        outreach: "1.0.0-shared",
      },
    },
    requestBudget: {
      maxLogicalRequests: requestUpperBound,
      attemptedHttpRequests,
      remainingHttpRequests: requestUpperBound - attemptedHttpRequests,
      attemptLog,
    },
    aggregate: aggregate(),
    results,
    humanEvaluation: {
      status: "pending-real-testers",
      minimumUniqueTesters: 5,
      warning: "No human score is inferred or fabricated by this runner.",
    },
  };
}

async function persist(status) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(createReport(status), null, 2)}\n`, "utf8");
}

await persist("running");
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    const runKey = `${scenario.id}:r${repetition}`;
    if (results.some((result) => result.runKey === runKey)) continue;
    const requestConfig = makeConfig(runKey);
    const wakeAdapter = new OpenAICompatibleModelAdapter(requestConfig);
    const policyAdapter = new OpenAICompatiblePolicySignalAdapter(requestConfig);
    const routerClient = new OpenAICompatibleStructuredClient(requestConfig);
    const baselineClient = new OpenAICompatibleStructuredClient(requestConfig);
    const wakeMessageClient = new OpenAICompatibleStructuredClient(requestConfig);
    const baselineMessageClient = new OpenAICompatibleStructuredClient(requestConfig);
    const router = new HybridRelevanceRouter(new ModelRelevanceRouter(routerClient));
    let wakeResult = null;
    let baselineMemories = null;
    let baselineResult = null;
    let wakeMessages = [];
    let baselineMessages = [];
    let wakeLatencyMs = 0;
    let baselineLatencyMs = 0;
    let error = null;
    try {
      const baselineFirst = (scenarioIndex + repetition) % 2 === 0;
      const runWake = async () => {
        const start = performance.now();
        wakeResult = await runWakeIntentTimeline({
          scenarioId: `${scenario.id}-r${repetition}`,
          initialEvents: scenario.initialEvents,
          target: scenario.target,
          timeZone: scenario.timeZone,
          initialUserState: scenario.initialUserState,
          steps: scenario.steps,
          generator: wakeAdapter,
          policySignalGenerator: policyAdapter,
          relevanceRouter: router,
          semanticReevaluator: wakeAdapter,
        });
        wakeMessages = await generateWakeMessages(wakeMessageClient, scenario, wakeResult);
        wakeLatencyMs = performance.now() - start;
      };
      const runBaseline = async () => {
        const start = performance.now();
        const baseline = new ModelDueGatedBaselineAdapter(baselineClient, {
          initialEvents: scenario.initialEvents,
          target: scenario.target,
          timeZone: scenario.timeZone,
        });
        baselineMemories = await baseline.extract({
          events: scenario.initialEvents,
          target: scenario.target,
          now: scenario.initialEvents.at(-1)?.occurredAt ?? scenario.steps[0].at,
          timeZone: scenario.timeZone,
        });
        baselineResult = await runDueGatedBaselineTimeline({
          memories: baselineMemories,
          initialUserState: scenario.initialUserState,
          steps: scenario.steps,
          decider: baseline,
          extractionModelCalls: 1,
        });
        baselineMessages = await generateBaselineMessages(
          baselineMessageClient,
          scenario,
          baselineMemories,
          baselineResult,
        );
        baselineLatencyMs = performance.now() - start;
      };
      if (baselineFirst) {
        await runBaseline();
        await runWake();
      } else {
        await runWake();
        await runBaseline();
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const wakeRecords = [
      ...wakeAdapter.getCallRecords(),
      ...policyAdapter.getCallRecords(),
      ...routerClient.getCallRecords(),
      ...wakeMessageClient.getCallRecords(),
    ];
    const baselineRecords = [
      ...baselineClient.getCallRecords(),
      ...baselineMessageClient.getCallRecords(),
    ];
    let score = null;
    let wakeBehavior = null;
    let baselineBehavior = null;
    let comparison = null;
    if (wakeResult && baselineMemories && baselineResult) {
      score = scoreAlphaClosureScenario({
        scenario,
        wakeResult,
        baselineMemories,
        baselineResult,
      });
      wakeBehavior = summarizeWakeBehavior(scenario, wakeResult);
      baselineBehavior = summarizeBaselineBehavior(scenario, baselineMemories, baselineResult);
      comparison = compareDecisionSequences(wakeBehavior, baselineBehavior);
    }
    results.push({
      runKey,
      scenarioId: scenario.id,
      repetition,
      scenario,
      armOrder: (scenarioIndex + repetition) % 2 === 0
        ? ["baseline", "wakeintent"]
        : ["wakeintent", "baseline"],
      error,
      score,
      comparison,
      wakeintent: {
        behavior: wakeBehavior,
        result: wakeResult,
        messages: wakeMessages,
        routeAudits: router.getAudits(),
        usage: sumUsage(wakeRecords),
        latencyMs: wakeLatencyMs,
        modelCallRecords: wakeRecords,
      },
      baseline: {
        behavior: baselineBehavior,
        initialMemories: baselineMemories,
        result: baselineResult,
        messages: baselineMessages,
        usage: sumUsage(baselineRecords),
        latencyMs: baselineLatencyMs,
        modelCallRecords: baselineRecords,
      },
    });
    await persist("running");
  }
}
await persist("completed");
console.log(`Completed report: ${reportPath}`);
console.log(JSON.stringify(aggregate(), null, 2));

const { renderIntentContinuityArtifacts } = await import("./render-intent-continuity-results.mjs");
await renderIntentContinuityArtifacts(reportPath);
