import type {
  AggregateMetrics,
  EvalPrediction,
  EvalScenario,
  PredictionScore,
  ScoredPrediction,
} from "./types.js";

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function scorePrediction(
  scenario: EvalScenario,
  prediction: EvalPrediction,
): PredictionScore {
  const creationCorrect = scenario.expected.allowedIntentStatuses.includes(
    prediction.createdIntentStatus,
  );
  const actionCorrect = scenario.expected.allowedActions.includes(
    prediction.action,
  );
  const evidenceCorrect = scenario.expected.requiredEvidenceRefs.every((eventId) =>
    prediction.evidenceRefs.includes(eventId),
  );
  return {
    creationCorrect,
    actionCorrect,
    evidenceCorrect,
    passed:
      prediction.error === null &&
      creationCorrect &&
      actionCorrect &&
      evidenceCorrect,
  };
}

export function scoreRows(
  scenarios: EvalScenario[],
  predictions: EvalPrediction[],
): ScoredPrediction[] {
  const predictionByScenario = new Map(
    predictions.map((prediction) => [prediction.scenarioId, prediction]),
  );
  return scenarios.map((scenario) => {
    const prediction = predictionByScenario.get(scenario.id);
    if (!prediction) {
      throw new Error(`Missing prediction for scenario ${scenario.id}`);
    }
    return { scenario, prediction, score: scorePrediction(scenario, prediction) };
  });
}

export function aggregateMetrics(rows: ScoredPrediction[]): AggregateMetrics {
  const total = rows.length;
  const passed = rows.filter((row) => row.score.passed).length;
  const shouldNotContact = rows.filter(
    (row) => !row.scenario.expected.allowedActions.includes("contact"),
  );
  const predictedContact = rows.filter(
    (row) => row.prediction.action === "contact",
  );
  const justifiedContact = predictedContact.filter((row) =>
    row.scenario.expected.allowedActions.includes("contact"),
  );
  const records = rows.flatMap((row) => row.prediction.modelCallRecords ?? []);
  const sumKnown = (values: Array<number | null>): number | null => {
    const knownValues = values.filter(
      (value): value is number => value !== null,
    );
    return knownValues.length === values.length
      ? knownValues.reduce((sum, value) => sum + value, 0)
      : null;
  };

  return {
    total,
    passed,
    passRate: ratio(passed, total),
    creationAccuracy: ratio(
      rows.filter((row) => row.score.creationCorrect).length,
      total,
    ),
    actionAccuracy: ratio(
      rows.filter((row) => row.score.actionCorrect).length,
      total,
    ),
    evidenceAccuracy: ratio(
      rows.filter((row) => row.score.evidenceCorrect).length,
      total,
    ),
    falseOutreachRate: ratio(
      shouldNotContact.filter((row) => row.prediction.action === "contact").length,
      shouldNotContact.length,
    ),
    effectiveContactPrecision: ratio(
      justifiedContact.length,
      predictedContact.length,
    ),
    averageModelCalls: ratio(
      rows.reduce((sum, row) => sum + row.prediction.modelCalls, 0),
      total,
    ),
    averageLatencyMs: ratio(
      rows.reduce((sum, row) => sum + row.prediction.latencyMs, 0),
      total,
    ),
    totalInputTokens: sumKnown(records.map((record) => record.usage.inputTokens)),
    totalOutputTokens: sumKnown(records.map((record) => record.usage.outputTokens)),
    totalTokens: sumKnown(records.map((record) => record.usage.totalTokens)),
    totalCostUsd: sumKnown(records.map((record) => record.costUsd)),
  };
}
