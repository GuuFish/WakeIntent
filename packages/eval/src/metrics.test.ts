import { describe, expect, it } from "vitest";
import type { ModelCallRecord } from "@wakeintent/model-openai-compatible";
import { aggregateMetrics, scorePrediction } from "./metrics.js";
import type { EvalPrediction, EvalScenario, ScoredPrediction } from "./types.js";

const scenario: EvalScenario = {
  schemaVersion: "0.1.0",
  id: "s1",
  category: "early-resolution",
  language: "zh-CN",
  timeZone: "Asia/Hong_Kong",
  initialEvents: [],
  latestEvents: [],
  evaluationTime: "2026-09-01T00:00:00.000Z",
  target: { kind: "user", id: "u1" },
  userState: { authorization: "granted" },
  expected: {
    allowedIntentStatuses: ["active"],
    primaryAction: "resolve",
    allowedActions: ["resolve"],
    requiredEvidenceRefs: ["result-event"],
    annotation: "The result is already known.",
  },
};

function prediction(overrides: Partial<EvalPrediction> = {}): EvalPrediction {
  return {
    system: "wakeintent",
    scenarioId: "s1",
    createdIntentStatus: "active",
    candidateCount: 1,
    action: "resolve",
    reason: "Resolved",
    evidenceRefs: ["result-event"],
    confidence: 0.9,
    modelCalls: 2,
    latencyMs: 100,
    error: null,
    modelCallRecords: [],
    artifacts: {},
    ...overrides,
  };
}

describe("scorePrediction", () => {
  it("requires creation, action, evidence, and no runtime error", () => {
    expect(scorePrediction(scenario, prediction()).passed).toBe(true);
    expect(
      scorePrediction(scenario, prediction({ evidenceRefs: [] })).passed,
    ).toBe(false);
  });
});

describe("aggregateMetrics", () => {
  it("counts unjustified contact as false outreach", () => {
    const rows: ScoredPrediction[] = [
      {
        scenario,
        prediction: prediction({ action: "contact" }),
        score: scorePrediction(scenario, prediction({ action: "contact" })),
      },
    ];
    expect(aggregateMetrics(rows)).toMatchObject({
      total: 1,
      passed: 0,
      falseOutreachRate: 1,
      effectiveContactPrecision: 0,
    });
  });

  it("aggregates known token usage and keeps unknown cost explicit", () => {
    const record: ModelCallRecord = {
      schemaName: "test_schema",
      phase: "decision",
      reasoningEffort: "low",
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      requestId: "request-1",
      attempts: 1,
      costUsd: null,
    };
    const result = aggregateMetrics([
      {
        scenario,
        prediction: prediction({ modelCallRecords: [record] }),
        score: scorePrediction(scenario, prediction()),
      },
    ]);

    expect(result).toMatchObject({
      totalInputTokens: 100,
      totalOutputTokens: 25,
      totalTokens: 125,
      totalCostUsd: null,
    });
  });
});
