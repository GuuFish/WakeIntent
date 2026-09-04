import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelDueGatedBaselineAdapter,
  HybridRelevanceRouter,
  ModelRelevanceRouter,
  RELEVANCE_ROUTER_PROMPT_VERSION,
  LONGITUDINAL_BASELINE_PROMPT_VERSION,
  runDueGatedBaselineTimeline,
  runWakeIntentTimeline,
} from "../packages/eval/dist/index.js";
import {
  OpenAICompatibleModelAdapter,
  OpenAICompatibleStructuredClient,
  WAKEINTENT_MODEL_PROMPT_VERSION,
  configFromEnv,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(
  root,
  "evals",
  "longitudinal-development-v0.1.json",
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const requestedId =
  process.argv[2]?.trim() ||
  process.env.WAKEINTENT_LONGITUDINAL_ID?.trim();
const scenario = requestedId
  ? dataset.scenarios.find((item) => item.id === requestedId)
  : dataset.scenarios[0];
if (!scenario) throw new Error("No longitudinal scenario is available");

const config = configFromEnv();
const routerModel = process.env.WAKEINTENT_ROUTER_MODEL?.trim() || config.model;
const routerConfig = { ...config, model: routerModel };
const wakeAdapter = new OpenAICompatibleModelAdapter(config);
const routerClient = new OpenAICompatibleStructuredClient(routerConfig);
const router = new HybridRelevanceRouter(
  new ModelRelevanceRouter(routerClient),
);
const wakeResult = await runWakeIntentTimeline({
  scenarioId: scenario.id,
  initialEvents: scenario.initialEvents,
  target: scenario.target,
  timeZone: scenario.timeZone,
  initialUserState: scenario.initialUserState,
  steps: scenario.steps,
  generator: wakeAdapter,
  semanticReevaluator: wakeAdapter,
  relevanceRouter: router,
});

const baselineClient = new OpenAICompatibleStructuredClient(config);
const baselineAdapter = new ModelDueGatedBaselineAdapter(baselineClient, {
  initialEvents: scenario.initialEvents,
  target: scenario.target,
  timeZone: scenario.timeZone,
});
const baselineMemories = await baselineAdapter.extract({
  events: scenario.initialEvents,
  target: scenario.target,
  now: scenario.initialEvents.at(-1)?.occurredAt ?? scenario.steps[0].at,
  timeZone: scenario.timeZone,
});
const baselineResult = await runDueGatedBaselineTimeline({
  memories: baselineMemories,
  initialUserState: scenario.initialUserState,
  steps: scenario.steps,
  decider: baselineAdapter,
  extractionModelCalls: 1,
});

const terminalActions = new Set(["resolve", "cancel", "expire"]);
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
const usageBySchema = (records) =>
  Object.fromEntries(
    [...new Set(records.map((record) => record.schemaName))].map((schemaName) => [
      schemaName,
      sumUsage(records.filter((record) => record.schemaName === schemaName)),
    ]),
  );
const wakeRecords = [
  ...wakeAdapter.getCallRecords(),
  ...routerClient.getCallRecords(),
];
const baselineRecords = [...baselineClient.getCallRecords()];
const audits = router.getAudits();
const wakeActions = wakeResult.traces.map((trace) => trace.decision.action);
const baselineDecisions = baselineResult.traces.flatMap(
  (trace) => trace.decisions,
);
const baselineActions = baselineDecisions.map((decision) => decision.action);
const expected = scenario.expected;
const wakeTerminalTrace = wakeResult.traces.find(
  (trace) =>
    terminalActions.has(trace.decision.action) &&
    [
      ...trace.decision.evidenceRefs,
      ...trace.decision.counterEvidenceRefs,
    ].includes(expected.requiredRouteEvidence),
);
const routeMatches = audits.flatMap((audit) => audit.matches);
const wakeFalseJobContact = wakeResult.traces.some(
  (trace) =>
    trace.decision.action === "contact" &&
    trace.decision.evidenceRefs.includes(expected.forbiddenJobFairContactEvidence),
);
const baselineFalseJobContact = baselineDecisions.some(
  (decision) =>
    decision.action === "contact" &&
    decision.evidenceRefs.includes(expected.forbiddenJobFairContactEvidence),
);
const score = {
  wakeIntentCount: wakeResult.intents.length === expected.intentCount,
  baselineMemoryCount: baselineMemories.length === expected.intentCount,
  selectiveRoute:
    routeMatches.length === expected.routeMatchCount &&
    routeMatches.every((match) =>
      match.eventIds.includes(expected.requiredRouteEvidence),
    ),
  wakeEarlyTerminal:
    Boolean(wakeTerminalTrace) && wakeTerminalTrace.trigger === "context",
  wakeSurvivingContact: expected.wakeRequiredActions.every((action) =>
    wakeActions.includes(action),
  ),
  wakeTerminalAction: wakeActions.some((action) =>
    expected.wakeRequiredTerminalActions.includes(action),
  ),
  baselineSurvivingContact: expected.baselineRequiredActions.every((action) =>
    baselineActions.includes(action),
  ),
  baselineTerminalAction: baselineActions.some((action) =>
    expected.baselineRequiredTerminalActions.includes(action),
  ),
  wakeNoFalseJobContact: !wakeFalseJobContact,
  baselineNoFalseJobContact: !baselineFalseJobContact,
};
const passed = Object.values(score).every(Boolean);
const wakeTerminalAt = wakeTerminalTrace?.at ?? null;
const baselineTerminalAt = baselineResult.traces.find((trace) =>
  trace.decisions.some((decision) => terminalActions.has(decision.action)),
)?.at ?? null;
const staleStateAvoidedMilliseconds =
  wakeTerminalAt && baselineTerminalAt
    ? Math.max(0, Date.parse(baselineTerminalAt) - Date.parse(wakeTerminalAt))
    : null;

const completedAt = new Date().toISOString();
const report = {
  schemaVersion: "0.1.0",
  dataset: { name: dataset.name, version: dataset.version, kind: dataset.kind },
  scenarioId: scenario.id,
  model: config.model,
  routerModel,
  apiMode: config.apiMode,
  modelSettings: {
    extractionReasoningEffort:
      config.extractionReasoningEffort ?? config.reasoningEffort ?? null,
    decisionReasoningEffort:
      config.decisionReasoningEffort ?? config.reasoningEffort ?? null,
    textVerbosity: config.textVerbosity ?? null,
  },
  promptVersions: {
    wakeintent: WAKEINTENT_MODEL_PROMPT_VERSION,
    relevanceRouter: RELEVANCE_ROUTER_PROMPT_VERSION,
    dueGatedBaseline: LONGITUDINAL_BASELINE_PROMPT_VERSION,
  },
  completedAt,
  scoringVersion: "0.1.2",
  expectation: expected,
  passed,
  score,
  staleStateAvoidedMilliseconds,
  wakeintent: {
    usage: sumUsage(wakeRecords),
    usageBySchema: usageBySchema(wakeRecords),
    result: wakeResult,
    routeAudits: audits,
    modelCallRecords: wakeRecords,
  },
  dueGatedBaseline: {
    usage: sumUsage(baselineRecords),
    usageBySchema: usageBySchema(baselineRecords),
    initialMemories: baselineMemories,
    result: baselineResult,
    modelCallRecords: baselineRecords,
  },
  warning:
    "One development timeline validates the pipeline only. It cannot establish product value without a frozen multi-scenario evaluation.",
};
const reportPath = resolve(
  root,
  "reports",
  "longitudinal-runs",
  `${completedAt.replaceAll(":", "-")}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.table([
  {
    system: "wakeintent",
    passed,
    calls: report.wakeintent.usage.calls,
    tokens: report.wakeintent.usage.totalTokens,
    actions: wakeActions.join(","),
  },
  {
    system: "due-gated-heartbeat",
    passed,
    calls: report.dueGatedBaseline.usage.calls,
    tokens: report.dueGatedBaseline.usage.totalTokens,
    actions: baselineActions.join(","),
  },
]);
console.log(`Stale state avoided (hours): ${
  staleStateAvoidedMilliseconds === null
    ? "unknown"
    : (staleStateAvoidedMilliseconds / 3_600_000).toFixed(1)
}`);
console.log(`Report: ${reportPath}`);
