import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateRelevanceMetrics,
  HybridRelevanceRouter,
  ModelRelevanceRouter,
  RELEVANCE_ROUTER_PROMPT_VERSION,
  scoreRelevancePrediction,
} from "../packages/eval/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(root, "evals", "relevance-routing-v0.1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const mode =
  process.argv[2]?.trim() ||
  process.env.WAKEINTENT_RELEVANCE_MODE?.trim() ||
  "hybrid";
if (mode !== "hybrid" && mode !== "model") {
  throw new Error("WAKEINTENT_RELEVANCE_MODE must be hybrid or model");
}

const requestedId =
  process.argv[4]?.trim() ||
  process.env.WAKEINTENT_RELEVANCE_ID?.trim();
const requestedLimitText = process.env.WAKEINTENT_RELEVANCE_LIMIT?.trim();
const requestedLimit = requestedLimitText ? Number(requestedLimitText) : null;
if (
  requestedLimit !== null &&
  (!Number.isInteger(requestedLimit) || requestedLimit <= 0)
) {
  throw new Error("WAKEINTENT_RELEVANCE_LIMIT must be a positive integer");
}
let scenarios = requestedId
  ? dataset.scenarios.filter((scenario) => scenario.id === requestedId)
  : dataset.scenarios;
if (requestedId && scenarios.length === 0) {
  throw new Error(`Unknown relevance scenario: ${requestedId}`);
}
if (requestedLimit !== null) scenarios = scenarios.slice(0, requestedLimit);
const repeatsText =
  process.argv[3]?.trim() ||
  process.env.WAKEINTENT_RELEVANCE_REPEATS?.trim() ||
  "1";
const repeats = Number(repeatsText);
if (!Number.isInteger(repeats) || repeats <= 0 || repeats > 10) {
  throw new Error("WAKEINTENT_RELEVANCE_REPEATS must be an integer from 1 to 10");
}

const config = configFromEnv();
const routerModel = process.env.WAKEINTENT_ROUTER_MODEL?.trim() || config.model;
const routerClient = new OpenAICompatibleStructuredClient({
  ...config,
  model: routerModel,
});
const modelRouter = new ModelRelevanceRouter(routerClient);
const router = mode === "hybrid"
  ? new HybridRelevanceRouter(modelRouter)
  : modelRouter;
const knownIntentIds = new Set(dataset.intents.map((intent) => intent.id));
if (knownIntentIds.size !== dataset.intents.length) {
  throw new Error("Dataset intent IDs must be unique");
}

const rows = [];
for (let runIndex = 1; runIndex <= repeats; runIndex += 1) {
for (const scenario of scenarios) {
  const activeIds = scenario.activeIntentIds ?? dataset.intents.map((intent) => intent.id);
  const activeIdSet = new Set(activeIds);
  const intents = dataset.intents.filter((intent) => activeIdSet.has(intent.id));
  if (intents.length !== activeIdSet.size) {
    throw new Error(`Scenario ${scenario.id} references an unknown active intent`);
  }
  for (const expectedId of scenario.expectedIntentIds) {
    if (!activeIdSet.has(expectedId)) {
      throw new Error(`Scenario ${scenario.id} expects inactive intent ${expectedId}`);
    }
  }

  const recordStart = routerClient.getCallRecords().length;
  const auditStart = router.getAudits().length;
  const started = performance.now();
  let predictedIntentIds = [];
  let routeSelections = [];
  let source = "error";
  let error = null;
  try {
    const selections = await router.selectRelevant({
      intents,
      events: scenario.events,
      now: scenario.now,
    });
    routeSelections = selections;
    predictedIntentIds = selections.map((selection) => selection.intentId);
    const unknownPrediction = predictedIntentIds.find((id) => !activeIdSet.has(id));
    if (unknownPrediction) {
      throw new Error(`Router selected unknown or inactive intent ${unknownPrediction}`);
    }
    const audit = router.getAudits()[auditStart];
    if (!audit) throw new Error("Router produced no audit record");
    source = audit.source;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const latencyMs = performance.now() - started;
  const records = routerClient.getCallRecords().slice(recordStart);
  const prediction = {
    scenarioId: scenario.id,
    expectedIntentIds: [...scenario.expectedIntentIds],
    predictedIntentIds: [...new Set(predictedIntentIds)],
    routeSelections,
    source,
    latencyMs,
    modelCallRecords: records,
    error,
  };
  rows.push({
    runIndex,
    scenario,
    prediction,
    score: scoreRelevancePrediction(
      scenario.expectedIntentIds,
      prediction.predictedIntentIds,
    ),
  });
}
}

const metrics = aggregateRelevanceMetrics(rows);
const stabilityRows = scenarios.map((scenario) => {
  const signatures = rows
    .filter((row) => row.scenario.id === scenario.id)
    .map((row) => [...row.prediction.predictedIntentIds].sort().join(","));
  return {
    scenarioId: scenario.id,
    stable: new Set(signatures).size <= 1,
    signatures,
  };
});
const stableScenarios = stabilityRows.filter((row) => row.stable).length;
const stability = {
  totalScenarios: stabilityRows.length,
  stableScenarios,
  rate: stabilityRows.length === 0 ? 1 : stableScenarios / stabilityRows.length,
  rows: stabilityRows,
};
const completedAt = new Date().toISOString();
const report = {
  schemaVersion: "0.1.0",
  dataset: {
    name: dataset.name,
    version: dataset.version,
    kind: dataset.kind,
  },
  mode,
  model: routerModel,
  apiMode: config.apiMode,
  modelSettings: {
    reasoningEffort:
      config.extractionReasoningEffort ?? config.reasoningEffort ?? null,
    textVerbosity: config.textVerbosity ?? null,
  },
  promptVersion: RELEVANCE_ROUTER_PROMPT_VERSION,
  repeats,
  completedAt,
  scenarioIds: scenarios.map((scenario) => scenario.id),
  metrics,
  stability,
  rows,
  warning:
    "This is a labeled development routing set, not a frozen independent test set. It diagnoses routing feasibility and failure modes but cannot establish product value by itself.",
};
const reportPath = resolve(
  root,
  "reports",
  "relevance-runs",
  `${completedAt.replaceAll(":", "-")}-${mode}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.table(
  rows.map((row) => ({
    scenario: row.scenario.id,
    run: row.runIndex,
    expected: row.scenario.expectedIntentIds.join(",") || "none",
    predicted: row.prediction.predictedIntentIds.join(",") || "none",
    source: row.prediction.source,
    calls: row.prediction.modelCallRecords.length,
    exact: row.score.exactMatch,
  })),
);
console.table([
  {
    mode,
    scenarios: metrics.total,
    repeats,
    exactAccuracy: metrics.exactMatchAccuracy.toFixed(3),
    precision: metrics.precision.toFixed(3),
    recall: metrics.recall.toFixed(3),
    f1: metrics.f1.toFixed(3),
    noMatchAccuracy: metrics.noMatchAccuracy.toFixed(3),
    modelCalls: metrics.totalModelCalls,
    tokens: metrics.totalTokens,
    stability: stability.rate.toFixed(3),
  },
]);
console.log(`Report: ${reportPath}`);
