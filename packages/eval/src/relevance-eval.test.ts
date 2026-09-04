import { describe, expect, it } from "vitest";
import {
  aggregateRelevanceMetrics,
  scoreRelevancePrediction,
  type ScoredRelevancePrediction,
} from "./relevance-eval.js";

function row(
  id: string,
  expectedIntentIds: string[],
  predictedIntentIds: string[],
  source: "deterministic" | "model" | "error",
): ScoredRelevancePrediction {
  return {
    scenario: {
      id,
      category: "test",
      annotation: "test row",
      now: "2026-09-03T08:00:00.000Z",
      events: [],
      expectedIntentIds,
    },
    prediction: {
      scenarioId: id,
      expectedIntentIds,
      predictedIntentIds,
      source,
      latencyMs: 10,
      modelCallRecords: [],
      error: source === "error" ? "failed" : null,
    },
    score: scoreRelevancePrediction(expectedIntentIds, predictedIntentIds),
  };
}

describe("scoreRelevancePrediction", () => {
  it("ignores order and duplicate IDs", () => {
    expect(
      scoreRelevancePrediction(["job", "parcel"], ["parcel", "job", "job"]),
    ).toEqual({
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      exactMatch: true,
    });
  });

  it("counts false positives and false negatives separately", () => {
    expect(scoreRelevancePrediction(["job", "parcel"], ["job", "study"])).toEqual({
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      exactMatch: false,
    });
  });
});

describe("aggregateRelevanceMetrics", () => {
  it("reports exact-match, micro classification, routing, and error metrics", () => {
    const metrics = aggregateRelevanceMetrics([
      row("positive-pass", ["job"], ["job"], "deterministic"),
      row("negative-pass", [], [], "model"),
      row("mixed-fail", ["parcel"], ["study"], "error"),
    ]);

    expect(metrics).toMatchObject({
      total: 3,
      exactMatches: 2,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      deterministicScenarioRate: 1 / 3,
      modelFallbackScenarioRate: 1 / 3,
      errorRate: 1 / 3,
      totalModelCalls: 0,
    });
    expect(metrics.positiveExactMatchAccuracy).toBe(0.5);
    expect(metrics.noMatchAccuracy).toBe(1);
  });
});
