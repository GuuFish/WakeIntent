import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FakeClock,
  extractContactPolicySignals,
} from "../packages/core/dist/index.js";
import {
  aggregatePolicySignalScores,
  scorePolicySignalScenario,
} from "../packages/eval/dist/index.js";
import {
  OpenAICompatiblePolicySignalAdapter,
  WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION,
  configFromEnv,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evalDirectory = resolve(root, "evals");
const datasetFile =
  process.env.WAKEINTENT_POLICY_EVAL_DATASET?.trim() ||
  "policy-signal-extraction-v0.2.json";

async function loadDataset(fileName, seen = new Set()) {
  if (seen.has(fileName)) throw new Error("Policy eval dataset inheritance cycle");
  const nextSeen = new Set(seen).add(fileName);
  const datasetPath = resolve(evalDirectory, fileName);
  if (!datasetPath.startsWith(`${evalDirectory}\\`)) {
    throw new Error("Policy eval dataset must stay inside evals/");
  }
  const raw = JSON.parse(await readFile(datasetPath, "utf8"));
  if (!raw.extends) {
    return { ...raw, resolvedFrom: [fileName] };
  }
  const base = await loadDataset(raw.extends, nextSeen);
  const overrides = new Map(
    (raw.overrides ?? []).map((override) => [override.id, override]),
  );
  const baseScenarios = base.scenarios.map((scenario) => ({
    ...scenario,
    ...(raw.baseScenarioSplit ? { split: raw.baseScenarioSplit } : {}),
    ...(raw.defaultCurrentPolicy
      ? { currentPolicy: { ...raw.defaultCurrentPolicy } }
      : {}),
    ...(overrides.get(scenario.id) ?? {}),
  }));
  const additions = (raw.additions ?? []).map((scenario) => ({
    ...scenario,
    ...(scenario.currentPolicy
      ? { currentPolicy: { ...scenario.currentPolicy } }
      : raw.defaultCurrentPolicy
        ? { currentPolicy: { ...raw.defaultCurrentPolicy } }
        : {}),
  }));
  return {
    ...base,
    ...raw,
    scenarios: [...baseScenarios, ...additions],
    resolvedFrom: [...base.resolvedFrom, fileName],
  };
}

const dataset = await loadDataset(datasetFile);
const argumentsList = process.argv.slice(2);
const optionValue = (prefix) =>
  argumentsList.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const requestedSplit = process.env.WAKEINTENT_POLICY_EVAL_SPLIT?.trim();
const splitFilter = optionValue("--split=")?.trim() || requestedSplit;
const requestedId = argumentsList.find((argument) => !argument.startsWith("--"));
const repeatsText =
  optionValue("--repeats=")?.trim() ||
  process.env.WAKEINTENT_POLICY_EVAL_REPEATS?.trim() ||
  "1";
const repeats = Number(repeatsText);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
  throw new Error("Policy eval repeats must be an integer from 1 to 10");
}
const scenarios = dataset.scenarios.filter(
  (scenario) =>
    (!splitFilter || scenario.split === splitFilter) &&
    (!requestedId || scenario.id === requestedId),
);
if (scenarios.length === 0) {
  throw new Error("No policy signal scenario matched the requested filter");
}

const config = configFromEnv();
const adapter = new OpenAICompatiblePolicySignalAdapter(config);
const scenarioResults = [];

for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex += 1) {
  for (const [index, scenario] of scenarios.entries()) {
    const startedAt = performance.now();
    const recordStart = adapter.getCallRecords().length;
    let actualSignals = [];
    let error = null;
    try {
      let sequence = 0;
      actualSignals = await extractContactPolicySignals({
        events: scenario.events,
        clock: new FakeClock(scenario.now),
        idGenerator: (kind) =>
          `${scenario.id}-r${repeatIndex}-${kind}-${++sequence}`,
        generator: adapter,
        timeZone: scenario.timeZone,
        currentPolicy: scenario.currentPolicy,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const score = scorePolicySignalScenario({
      scenario,
      actual: actualSignals,
      error,
    });
    const modelCallRecords = adapter.getCallRecords().slice(recordStart);
    scenarioResults.push({
      ...score,
      repeatIndex,
      latencyMs: Math.round(performance.now() - startedAt),
      actualSignals,
      modelCallRecords,
    });
    console.log(
      `[r${repeatIndex} ${index + 1}/${scenarios.length}] ${scenario.id}: ${score.passed ? "PASS" : "FAIL"}`,
    );
  }
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

const groupScores = (field) =>
  Object.fromEntries(
    [...new Set(scenarioResults.map((result) => result[field]))].map((value) => [
      value,
      aggregatePolicySignalScores(
        scenarioResults.filter((result) => result[field] === value),
      ),
    ]),
  );
const canonicalPrediction = (result) =>
  result.actual
    .map((item) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
    .sort()
    .join("|");
const stabilityByScenario = Object.fromEntries(
  scenarios.map((scenario) => {
    const runs = scenarioResults.filter(
      (result) => result.scenarioId === scenario.id,
    );
    const predictions = new Set(runs.map(canonicalPrediction));
    return [
      scenario.id,
      {
        runs: runs.length,
        passedRuns: runs.filter((run) => run.passed).length,
        passRate: runs.filter((run) => run.passed).length / runs.length,
        stablePrediction: predictions.size === 1,
        uniquePredictionCount: predictions.size,
        errors: runs.filter((run) => run.error !== null).length,
      },
    ];
  }),
);
const latencyValues = scenarioResults.map((result) => result.latencyMs);
const completedAt = new Date().toISOString();
const callRecords = scenarioResults.flatMap(
  (result) => result.modelCallRecords,
);
const report = {
  schemaVersion: "0.1.0",
  dataset: {
    name: dataset.name,
    version: dataset.version,
    kind: dataset.kind,
    frozenAt: dataset.frozenAt,
    path: `evals/${datasetFile}`,
    resolvedFrom: dataset.resolvedFrom.map((item) => `evals/${item}`),
  },
  completedAt,
  model: config.model,
  apiMode: config.apiMode,
  modelSettings: {
    extractionReasoningEffort:
      config.extractionReasoningEffort ?? config.reasoningEffort ?? null,
    textVerbosity: config.textVerbosity ?? null,
  },
  promptVersion: WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION,
  scoringVersion: "0.1.0",
  filters: {
    split: splitFilter ?? null,
    scenarioId: requestedId ?? null,
    repeats,
  },
  aggregate: aggregatePolicySignalScores(scenarioResults),
  bySplit: groupScores("split"),
  byRepeat: Object.fromEntries(
    Array.from({ length: repeats }, (_, index) => index + 1).map((repeatIndex) => [
      String(repeatIndex),
      aggregatePolicySignalScores(
        scenarioResults.filter((result) => result.repeatIndex === repeatIndex),
      ),
    ]),
  ),
  byCategory: groupScores("category"),
  stability: {
    repeats,
    scenarios: scenarios.length,
    stablePredictionScenarios: Object.values(stabilityByScenario).filter(
      (item) => item.stablePrediction,
    ).length,
    allPassedScenarios: Object.values(stabilityByScenario).filter(
      (item) => item.passedRuns === repeats,
    ).length,
    meanLatencyMs:
      latencyValues.reduce((total, value) => total + value, 0) /
      latencyValues.length,
    minLatencyMs: Math.min(...latencyValues),
    maxLatencyMs: Math.max(...latencyValues),
    byScenario: stabilityByScenario,
  },
  usage: sumUsage(callRecords),
  scenarios: scenarioResults,
  warning:
    "This frozen extraction eval measures policy-signal classification and normalization only. It does not yet establish end-to-end product value or user preference.",
};
const reportPath = resolve(
  root,
  "reports",
  "policy-signal-runs",
  `${completedAt.replaceAll(":", "-")}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.table([
  {
    scope: "overall",
    scenarios: report.aggregate.scenarios,
    exact: report.aggregate.exactMatchAccuracy.toFixed(3),
    precision: report.aggregate.signalPrecision.toFixed(3),
    recall: report.aggregate.signalRecall.toFixed(3),
    falsePositives: report.aggregate.falsePositives,
    falseNegatives: report.aggregate.falseNegatives,
    errors: report.aggregate.errors,
    tokens: report.usage.totalTokens,
  },
  ...Object.entries(report.bySplit).map(([split, aggregate]) => ({
    scope: split,
    scenarios: aggregate.scenarios,
    exact: aggregate.exactMatchAccuracy.toFixed(3),
    precision: aggregate.signalPrecision.toFixed(3),
    recall: aggregate.signalRecall.toFixed(3),
    falsePositives: aggregate.falsePositives,
    falseNegatives: aggregate.falseNegatives,
    errors: aggregate.errors,
    tokens: "-",
  })),
]);
if (repeats > 1) {
  console.log(
    `Stability: ${report.stability.stablePredictionScenarios}/${report.stability.scenarios} scenarios produced one prediction across ${repeats} runs; ${report.stability.allPassedScenarios}/${report.stability.scenarios} passed every run.`,
  );
}
console.log(`Report: ${reportPath}`);
