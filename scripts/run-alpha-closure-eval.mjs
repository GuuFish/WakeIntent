import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAlphaClosureStopRule,
  HybridRelevanceRouter,
  LONGITUDINAL_BASELINE_PROMPT_VERSION,
  ModelDueGatedBaselineAdapter,
  ModelRelevanceRouter,
  RELEVANCE_ROUTER_PROMPT_VERSION,
  runDueGatedBaselineTimeline,
  runWakeIntentTimeline,
  scoreAlphaClosureScenario,
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
const datasetPath = resolve(
  root,
  "evals",
  "alpha-closure-longitudinal-v0.1.json",
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const execute = process.argv.includes("--execute");
const resumeArgument = process.argv.find((argument) => argument.startsWith("--resume="));
const idsArgument = process.argv.find((argument) => argument.startsWith("--ids="));
const requestedIds = idsArgument
  ? new Set(idsArgument.slice("--ids=".length).split(",").map((id) => id.trim()).filter(Boolean))
  : null;
const scenarios = requestedIds
  ? dataset.scenarios.filter((scenario) => requestedIds.has(scenario.id))
  : dataset.scenarios;

if (scenarios.length === 0) {
  throw new Error("No alpha closure scenario matched --ids");
}
if (requestedIds) {
  const found = new Set(scenarios.map((scenario) => scenario.id));
  const missing = [...requestedIds].filter((id) => !found.has(id));
  if (missing.length > 0) throw new Error(`Unknown scenario ids: ${missing.join(", ")}`);
}

const planRows = scenarios.map((scenario) => {
  const contextSteps = scenario.steps.filter((step) => step.kind === "context").length;
  const scheduledSteps = scenario.steps.filter((step) => step.kind === "scheduled").length;
  const intentCount = scenario.expected.intentCount;
  return {
    scenario: scenario.id,
    category: scenario.category,
    syntheticEvents:
      scenario.initialEvents.length +
      scenario.steps.reduce((total, step) => total + step.events.length, 0),
    wakeRequestUpperBound:
      1 + contextSteps * 2 + intentCount * (contextSteps + scheduledSteps),
    baselineRequestUpperBound: 1 + scheduledSteps,
  };
});
const requestUpperBound = planRows.reduce(
  (total, row) =>
    total + row.wakeRequestUpperBound + row.baselineRequestUpperBound,
  0,
);

if (!execute) {
  console.table(planRows);
  console.log(`Scenarios: ${scenarios.length}`);
  console.log(`Conservative API request upper bound: ${requestUpperBound}`);
  console.log("Closure runs force zero retries, so the HTTP-attempt upper bound is the same.");
  console.log("Executed runs journal every HTTP attempt and completed scenario for crash-safe resumption.");
  console.log("Dry run only. No environment file was loaded and no API request was sent.");
  console.log(
    "Use the explicit API script only after the user authorizes the displayed scenario count, synthetic payload, request upper bound, and cost.",
  );
  process.exit(0);
}

const sumUsage = (records) => {
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
};

const config = { ...configFromEnv(), maxRetries: 0 };
const routerModel = process.env.WAKEINTENT_ROUTER_MODEL?.trim() || config.model;
const promptVersions = {
  wakeintent: WAKEINTENT_MODEL_PROMPT_VERSION,
  policySignals: WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION,
  relevanceRouter: RELEVANCE_ROUTER_PROMPT_VERSION,
  dueGatedBaseline: LONGITUDINAL_BASELINE_PROMPT_VERSION,
};
const requestedScenarioIds = requestedIds ? [...requestedIds] : null;
const fullDatasetRun = scenarios.length === dataset.scenarios.length && !requestedIds;
const startedAt = new Date().toISOString();
let effectiveStartedAt = startedAt;
let runId = startedAt.replaceAll(":", "-");
let reportPath = resolve(root, "reports", "alpha-closure-runs", `${runId}.json`);
let completed = [];
let attemptedHttpRequests = 0;
let attemptLog = [];
let resumedAt = null;

if (resumeArgument) {
  const suppliedPath = resumeArgument.slice("--resume=".length);
  reportPath = isAbsolute(suppliedPath) ? suppliedPath : resolve(root, suppliedPath);
  const previous = JSON.parse(await readFile(reportPath, "utf8"));
  const sameSelection =
    JSON.stringify(previous.requestedScenarioIds) === JSON.stringify(requestedScenarioIds);
  if (
    previous.dataset?.version !== dataset.version ||
    previous.model !== config.model ||
    previous.routerModel !== routerModel ||
    previous.apiMode !== config.apiMode ||
    previous.requestUpperBound !== requestUpperBound ||
    !sameSelection
  ) {
    throw new Error("Resume report does not match the current dataset, model, API mode, or scenario selection");
  }
  runId = previous.runId;
  effectiveStartedAt = previous.startedAt ?? startedAt;
  completed = Array.isArray(previous.scenarios) ? previous.scenarios : [];
  attemptedHttpRequests = previous.requestBudget?.attemptedHttpRequests ?? 0;
  attemptLog = Array.isArray(previous.requestBudget?.attemptLog)
    ? previous.requestBudget.attemptLog
    : [];
  resumedAt = new Date().toISOString();
}

const createReport = (status, completedAt = null) => {
  const scored = completed.flatMap((item) => (item.score ? [item.score] : []));
  const stopDecision =
    status === "completed" &&
    fullDatasetRun &&
    completed.length === dataset.scenarios.length
      ? evaluateAlphaClosureStopRule(dataset, scored)
      : null;
  return {
    schemaVersion: "0.2.0",
    runId,
    status,
    dataset: {
      name: dataset.name,
      version: dataset.version,
      kind: dataset.kind,
      frozenAt: dataset.frozenAt,
      path: "evals/alpha-closure-longitudinal-v0.1.json",
    },
    startedAt: effectiveStartedAt,
    resumedAt,
    completedAt,
    lastCheckpointAt: new Date().toISOString(),
    model: config.model,
    routerModel,
    apiMode: config.apiMode,
    promptVersions,
    requestedScenarioIds,
    requestUpperBound,
    requestBudget: {
      maxLogicalRequests: requestUpperBound,
      maxRetriesPerLogicalRequest: 0,
      maxHttpAttempts: requestUpperBound,
      attemptedHttpRequests,
      remainingHttpRequests: Math.max(0, requestUpperBound - attemptedHttpRequests),
      attemptLog,
    },
    stopDecision,
    aggregate: {
      scenarios: completed.length,
      scored: scored.length,
      passed: scored.filter((item) => item.passed).length,
      errors: completed.filter((item) => item.error !== null).length,
      wakeFalseOutreach: scored.reduce(
        (total, item) => total + item.falseOutreach.wakeintent,
        0,
      ),
      baselineFalseOutreach: scored.reduce(
        (total, item) => total + item.falseOutreach.dueGatedBaseline,
        0,
      ),
    },
    scenarios: completed,
    warning:
      "This finite alpha closure run supports a project go/no-go decision, not a universal superiority claim. Preserve failures and disclose model calls, tokens, cost, and baseline results.",
  };
};

const persistReport = async (status, completedAt = null) => {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(createReport(status, completedAt), null, 2)}\n`,
    "utf8",
  );
};

await persistReport("running");
const completedIds = new Set(completed.map((item) => item.scenarioId));
for (const scenario of scenarios) {
  if (completedIds.has(scenario.id)) continue;
  let logicalRequestIndex = 0;
  const requestConfig = {
    ...config,
    requestIdFactory(identity) {
      const stableInput = [
        runId,
        scenario.id,
        logicalRequestIndex,
        identity.schemaName,
        identity.phase ?? "none",
      ].join(":");
      logicalRequestIndex += 1;
      return createHash("sha256").update(stableInput).digest("hex");
    },
    async beforeRequestAttempt(attempt) {
      if (attemptedHttpRequests >= requestUpperBound) {
        throw new Error(
          `HTTP request budget exhausted at ${attemptedHttpRequests}/${requestUpperBound}`,
        );
      }
      attemptedHttpRequests += 1;
      attemptLog.push({
        scenarioId: scenario.id,
        schemaName: attempt.schemaName,
        phase: attempt.phase,
        requestId: attempt.requestId,
        attempt: attempt.attempt,
        recordedAt: new Date().toISOString(),
      });
      await persistReport("running");
    },
  };
  const wakeAdapter = new OpenAICompatibleModelAdapter(requestConfig);
  const policyAdapter = new OpenAICompatiblePolicySignalAdapter(requestConfig);
  const routerClient = new OpenAICompatibleStructuredClient({
    ...requestConfig,
    model: routerModel,
  });
  const router = new HybridRelevanceRouter(new ModelRelevanceRouter(routerClient));
  const baselineClient = new OpenAICompatibleStructuredClient(requestConfig);
  let wakeResult = null;
  let baselineMemories = null;
  let baselineResult = null;
  try {
    wakeResult = await runWakeIntentTimeline({
      scenarioId: scenario.id,
      initialEvents: scenario.initialEvents,
      target: scenario.target,
      timeZone: scenario.timeZone,
      initialUserState: scenario.initialUserState,
      steps: scenario.steps,
      generator: {
        async generate(input) {
          const candidates = await wakeAdapter.generate(input);
          if (candidates.length > scenario.expected.intentCount) {
            throw new Error(
              `Candidate count ${candidates.length} exceeds frozen expectation ${scenario.expected.intentCount}`,
            );
          }
          return candidates;
        },
      },
      policySignalGenerator: policyAdapter,
      relevanceRouter: router,
      semanticReevaluator: wakeAdapter,
    });

    const baselineAdapter = new ModelDueGatedBaselineAdapter(baselineClient, {
      initialEvents: scenario.initialEvents,
      target: scenario.target,
      timeZone: scenario.timeZone,
    });
    baselineMemories = await baselineAdapter.extract({
      events: scenario.initialEvents,
      target: scenario.target,
      now: scenario.initialEvents.at(-1)?.occurredAt ?? scenario.steps[0].at,
      timeZone: scenario.timeZone,
    });
    baselineResult = await runDueGatedBaselineTimeline({
      memories: baselineMemories,
      initialUserState: scenario.initialUserState,
      steps: scenario.steps,
      decider: baselineAdapter,
      extractionModelCalls: 1,
    });
    const wakeRecords = [
      ...wakeAdapter.getCallRecords(),
      ...policyAdapter.getCallRecords(),
      ...routerClient.getCallRecords(),
    ];
    const baselineRecords = [...baselineClient.getCallRecords()];
    completed.push({
      scenarioId: scenario.id,
      error: null,
      score: scoreAlphaClosureScenario({
        scenario,
        wakeResult,
        baselineMemories,
        baselineResult,
      }),
      wakeintent: {
        usage: sumUsage(wakeRecords),
        result: wakeResult,
        routeAudits: router.getAudits(),
        modelCallRecords: wakeRecords,
      },
      dueGatedBaseline: {
        usage: sumUsage(baselineRecords),
        initialMemories: baselineMemories,
        result: baselineResult,
        modelCallRecords: baselineRecords,
      },
    });
  } catch (error) {
    const wakeRecords = [
      ...wakeAdapter.getCallRecords(),
      ...policyAdapter.getCallRecords(),
      ...routerClient.getCallRecords(),
    ];
    const baselineRecords = [...baselineClient.getCallRecords()];
    completed.push({
      scenarioId: scenario.id,
      error: error instanceof Error ? error.message : String(error),
      score: null,
      wakeintent: {
        usage: sumUsage(wakeRecords),
        result: wakeResult,
        routeAudits: router.getAudits(),
        modelCallRecords: wakeRecords,
      },
      dueGatedBaseline: {
        usage: sumUsage(baselineRecords),
        initialMemories: baselineMemories,
        result: baselineResult,
        modelCallRecords: baselineRecords,
      },
    });
  }
  await persistReport("running");
}

const completedAt = new Date().toISOString();
const report = createReport("completed", completedAt);
await persistReport("completed", completedAt);
console.table(
  completed.map((item) => ({
    scenario: item.scenarioId,
    passed: item.score?.passed ?? false,
    wakeCalls: item.wakeintent?.usage.calls ?? null,
    baselineCalls: item.dueGatedBaseline?.usage.calls ?? null,
    error: item.error,
  })),
);
console.log(`Stop decision: ${report.stopDecision?.decision ?? "not-applicable-to-subset"}`);
console.log(`Report: ${reportPath}`);
