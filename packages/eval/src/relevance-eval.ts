import type { ContactIntent, ConversationEvent } from "@wakeintent/core";
import type { ModelCallRecord } from "@wakeintent/model-openai-compatible";

export interface RelevanceEvalScenario {
  id: string;
  category: string;
  annotation: string;
  now: string;
  activeIntentIds?: string[];
  events: ConversationEvent[];
  expectedIntentIds: string[];
}

export interface RelevanceEvalDataset {
  schemaVersion: "0.1.0";
  name: string;
  version: string;
  kind: "development-relevance-fixtures" | "frozen-relevance-test-set";
  revisionNotes?: Array<{
    scenarioId: string;
    fromVersion: string;
    change: string;
    rationale: string;
  }>;
  intents: ContactIntent[];
  scenarios: RelevanceEvalScenario[];
}

export type RelevanceRouteSource = "deterministic" | "model" | "error";

export interface RelevancePrediction {
  scenarioId: string;
  expectedIntentIds: string[];
  predictedIntentIds: string[];
  source: RelevanceRouteSource;
  latencyMs: number;
  modelCallRecords: ModelCallRecord[];
  error: string | null;
}

export interface RelevancePredictionScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  exactMatch: boolean;
}

export interface ScoredRelevancePrediction {
  scenario: RelevanceEvalScenario;
  prediction: RelevancePrediction;
  score: RelevancePredictionScore;
}

export interface RelevanceAggregateMetrics {
  total: number;
  exactMatches: number;
  exactMatchAccuracy: number;
  positiveExactMatchAccuracy: number;
  noMatchAccuracy: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveScenarioRate: number;
  falseNegativeScenarioRate: number;
  deterministicScenarioRate: number;
  modelFallbackScenarioRate: number;
  errorRate: number;
  totalModelCalls: number;
  averageLatencyMs: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function scoreRelevancePrediction(
  expectedIntentIds: string[],
  predictedIntentIds: string[],
): RelevancePredictionScore {
  const expected = new Set(uniqueSorted(expectedIntentIds));
  const predicted = new Set(uniqueSorted(predictedIntentIds));
  const truePositives = [...predicted].filter((id) => expected.has(id)).length;
  const falsePositives = [...predicted].filter((id) => !expected.has(id)).length;
  const falseNegatives = [...expected].filter((id) => !predicted.has(id)).length;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    exactMatch: falsePositives === 0 && falseNegatives === 0,
  };
}

function sumNullable(
  values: Array<number | null>,
): number | null {
  return values.every((value): value is number => typeof value === "number")
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

export function aggregateRelevanceMetrics(
  rows: ScoredRelevancePrediction[],
): RelevanceAggregateMetrics {
  const total = rows.length;
  const exactMatches = rows.filter((row) => row.score.exactMatch).length;
  const positiveRows = rows.filter(
    (row) => row.scenario.expectedIntentIds.length > 0,
  );
  const noMatchRows = rows.filter(
    (row) => row.scenario.expectedIntentIds.length === 0,
  );
  const truePositives = rows.reduce(
    (sum, row) => sum + row.score.truePositives,
    0,
  );
  const falsePositives = rows.reduce(
    (sum, row) => sum + row.score.falsePositives,
    0,
  );
  const falseNegatives = rows.reduce(
    (sum, row) => sum + row.score.falseNegatives,
    0,
  );
  const precision = safeRate(truePositives, truePositives + falsePositives);
  const recall = safeRate(truePositives, truePositives + falseNegatives);
  const records = rows.flatMap((row) => row.prediction.modelCallRecords);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    total,
    exactMatches,
    exactMatchAccuracy: safeRate(exactMatches, total),
    positiveExactMatchAccuracy: safeRate(
      positiveRows.filter((row) => row.score.exactMatch).length,
      positiveRows.length,
    ),
    noMatchAccuracy: safeRate(
      noMatchRows.filter((row) => row.score.exactMatch).length,
      noMatchRows.length,
    ),
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    falsePositiveScenarioRate: safeRate(
      rows.filter((row) => row.score.falsePositives > 0).length,
      total,
    ),
    falseNegativeScenarioRate: safeRate(
      rows.filter((row) => row.score.falseNegatives > 0).length,
      total,
    ),
    deterministicScenarioRate: safeRate(
      rows.filter((row) => row.prediction.source === "deterministic").length,
      total,
    ),
    modelFallbackScenarioRate: safeRate(
      rows.filter((row) => row.prediction.source === "model").length,
      total,
    ),
    errorRate: safeRate(
      rows.filter((row) => row.prediction.source === "error").length,
      total,
    ),
    totalModelCalls: records.length,
    averageLatencyMs: safeRate(
      rows.reduce((sum, row) => sum + row.prediction.latencyMs, 0),
      total,
    ),
    totalInputTokens: sumNullable(records.map((record) => record.usage.inputTokens)),
    totalOutputTokens: sumNullable(records.map((record) => record.usage.outputTokens)),
    totalTokens: sumNullable(records.map((record) => record.usage.totalTokens)),
    totalCostUsd: sumNullable(records.map((record) => record.costUsd)),
  };
}
