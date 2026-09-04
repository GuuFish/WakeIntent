import {
  FakeClock,
  extractContactIntents,
  reevaluateContactIntent,
  type ContactIntent,
  type IdGenerator,
} from "@wakeintent/core";
import {
  OpenAICompatibleModelAdapter,
  OpenAICompatibleStructuredClient,
  WAKEINTENT_MODEL_PROMPT_VERSION,
  type OpenAICompatibleConfig,
} from "@wakeintent/model-openai-compatible";
import type { ModelCallRecord } from "@wakeintent/model-openai-compatible";
import {
  MEMORY_HEARTBEAT_PROMPT_VERSION,
  MemoryHeartbeatBaseline,
} from "./baseline.js";
import { aggregateMetrics, scoreRows } from "./metrics.js";
import type {
  EvalDataset,
  EvalPrediction,
  EvalRunReport,
  EvalScenario,
  SystemEvalResult,
} from "./types.js";

function ids(scenarioId: string): IdGenerator {
  let sequence = 0;
  return (kind) => `${scenarioId}-${kind}-${++sequence}`;
}

function recordsForPrediction(records: readonly ModelCallRecord[]): ModelCallRecord[] {
  return records.map((record) => ({ ...record, usage: { ...record.usage } }));
}

async function runWakeIntent(
  scenario: EvalScenario,
  config: OpenAICompatibleConfig,
): Promise<EvalPrediction> {
  const startedAt = performance.now();
  let modelCalls = 0;
  let intents: ContactIntent[] = [];
  const adapter = new OpenAICompatibleModelAdapter(config);
  try {
    modelCalls += 1;
    intents = await extractContactIntents({
      events: scenario.initialEvents,
      target: scenario.target,
      clock: new FakeClock(
        scenario.initialEvents.at(-1)?.occurredAt ?? scenario.evaluationTime,
      ),
      idGenerator: ids(scenario.id),
      generator: adapter,
      policy: { activationThreshold: 0.7 },
      timeZone: scenario.timeZone,
    });
    const selected = [...intents].sort(
      (left, right) => right.confidence - left.confidence,
    )[0];
    if (!selected) {
      return {
        system: "wakeintent",
        scenarioId: scenario.id,
        createdIntentStatus: "none",
        candidateCount: 0,
        action: "none",
        reason: "No ContactIntent was extracted.",
        evidenceRefs: [],
        confidence: 1,
        modelCalls,
        latencyMs: performance.now() - startedAt,
        error: null,
        modelCallRecords: recordsForPrediction(adapter.getCallRecords()),
        artifacts: { intents },
      };
    }
    if (selected.status !== "active") {
      return {
        system: "wakeintent",
        scenarioId: scenario.id,
        createdIntentStatus: selected.status,
        candidateCount: intents.length,
        action: "none",
        reason: "The highest-confidence ContactIntent remains a candidate.",
        evidenceRefs: selected.evidence.map((item) => item.eventId),
        confidence: selected.confidence,
        modelCalls,
        latencyMs: performance.now() - startedAt,
        error: null,
        modelCallRecords: recordsForPrediction(adapter.getCallRecords()),
        artifacts: { intents, selectedIntent: selected },
      };
    }

    modelCalls += 1;
    const result = await reevaluateContactIntent({
      intent: selected,
      latestEvents: scenario.latestEvents,
      clock: new FakeClock(scenario.evaluationTime),
      idGenerator: ids(`${scenario.id}-decision`),
      policyVersion: "development-eval-0.1",
      timeZone: scenario.timeZone,
      userState: scenario.userState,
      semanticReevaluator: adapter,
    });
    return {
      system: "wakeintent",
      scenarioId: scenario.id,
      createdIntentStatus: selected.status,
      candidateCount: intents.length,
      action: result.decision.action,
      reason: result.decision.reason,
      evidenceRefs: [
        ...result.decision.evidenceRefs,
        ...result.decision.counterEvidenceRefs,
      ],
      confidence: result.decision.confidence,
      modelCalls,
      latencyMs: performance.now() - startedAt,
      error: null,
      modelCallRecords: recordsForPrediction(adapter.getCallRecords()),
      artifacts: {
        intents,
        selectedIntent: selected,
        decisionSource: result.source,
        decision: result.decision,
      },
    };
  } catch (error) {
    return {
      system: "wakeintent",
      scenarioId: scenario.id,
      createdIntentStatus: "none",
      candidateCount: 0,
      action: "none",
      reason: "WakeIntent execution failed.",
      evidenceRefs: [],
      confidence: 0,
      modelCalls,
      latencyMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      modelCallRecords: recordsForPrediction(adapter.getCallRecords()),
      artifacts: { intents },
    };
  }
}

function buildSystemResult(
  system: SystemEvalResult["system"],
  scenarios: EvalScenario[],
  predictions: EvalPrediction[],
): SystemEvalResult {
  const rows = scoreRows(scenarios, predictions);
  return { system, metrics: aggregateMetrics(rows), rows };
}

export async function runApiEvaluation(
  dataset: EvalDataset,
  scenarios: EvalScenario[],
  config: OpenAICompatibleConfig,
): Promise<EvalRunReport> {
  const startedAt = new Date().toISOString();
  const baseline = new MemoryHeartbeatBaseline(
    new OpenAICompatibleStructuredClient(config),
  );
  const wakePredictions: EvalPrediction[] = [];
  const baselinePredictions: EvalPrediction[] = [];

  for (const scenario of scenarios) {
    wakePredictions.push(await runWakeIntent(scenario, config));
    baselinePredictions.push(await baseline.run(scenario));
  }

  return {
    schemaVersion: "0.1.0",
    dataset: {
      name: dataset.name,
      version: dataset.version,
      kind: dataset.kind,
    },
    model: config.model,
    apiMode: config.apiMode,
    modelSettings: {
      reasoningEffort: config.reasoningEffort ?? null,
      extractionReasoningEffort: config.extractionReasoningEffort ?? null,
      decisionReasoningEffort: config.decisionReasoningEffort ?? null,
      textVerbosity: config.textVerbosity ?? null,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    scenarioIds: scenarios.map((scenario) => scenario.id),
    promptVersions: {
      wakeintent: WAKEINTENT_MODEL_PROMPT_VERSION,
      "memory-heartbeat": MEMORY_HEARTBEAT_PROMPT_VERSION,
    },
    results: [
      buildSystemResult("wakeintent", scenarios, wakePredictions),
      buildSystemResult("memory-heartbeat", scenarios, baselinePredictions),
    ],
    warning:
      "Development fixtures are for harness validation only and cannot support product claims.",
  };
}
