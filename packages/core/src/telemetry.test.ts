import { describe, expect, it } from "vitest";

import {
  buildEvaluationRunTrace,
  InvalidTelemetryInputError,
  summarizeModelUsage,
  type ModelCallTelemetryRecord,
} from "./telemetry.js";

function call(
  requestId: string,
  overrides: Partial<ModelCallTelemetryRecord> = {},
): ModelCallTelemetryRecord {
  return {
    schemaName: "wakeintent_decision",
    phase: "decision",
    reasoningEffort: "low",
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    requestId,
    attempts: 1,
    costUsd: 0.001,
    ...overrides,
  };
}

describe("execution telemetry", () => {
  it("aggregates complete usage and exposes retry attempts", () => {
    expect(
      summarizeModelUsage([
        call("request-1"),
        call("request-2", {
          usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
          attempts: 2,
          costUsd: 0.0005,
        }),
      ]),
    ).toEqual({
      calls: 2,
      attempts: 3,
      inputTokens: 150,
      outputTokens: 30,
      totalTokens: 180,
      costUsd: 0.0015,
      usageComplete: true,
      costComplete: true,
    });
  });

  it("keeps unknown usage and cost explicit", () => {
    const totals = summarizeModelUsage([
      call("request-1"),
      call("request-2", {
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
        costUsd: null,
      }),
    ]);
    expect(totals).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      usageComplete: false,
      costComplete: false,
    });
  });

  it("builds a decision trace without serializing raw failure messages", () => {
    const trace = buildEvaluationRunTrace({
      traceId: "trace-1",
      startedAt: "2026-09-03T12:00:00.000Z",
      completedAt: "2026-09-03T12:00:01.500Z",
      trigger: "scheduled",
      evaluation: {
        evaluatedAt: "2026-09-03T12:00:01.000Z",
        dueCount: 1,
        work: {
          dueIntents: 1,
          contextLoads: 1,
          semanticCalls: 1,
          hardGateDecisions: 0,
          semanticDecisions: 0,
          latePolicyDecisions: 0,
          routeClosureDecisions: 0,
          batchPolicyDecisions: 0,
          contactDecisions: 0,
          budgetSuppressed: 0,
          committed: 0,
          duplicates: 0,
          conflicts: 0,
          failures: 1,
          failureRecords: 0,
          retriesScheduled: 0,
          retriesExhausted: 0,
          failureRecordConflicts: 0,
          failureRecordFailures: 1,
        },
        results: [{
          outcome: "failed",
          intentId: "intent-1",
          previousRevision: 1,
          error: new Error("secret upstream response"),
        }],
      },
      modelCalls: [call("request-1")],
    });

    expect(trace.durationMs).toBe(1500);
    expect(trace.evaluation.items[0]).toMatchObject({
      outcome: "failed",
      errorCode: "Error",
    });
    expect(JSON.stringify(trace)).not.toContain("secret upstream response");
  });

  it("rejects invalid model accounting", () => {
    expect(() => summarizeModelUsage([call("request-1", { attempts: 0 })])).toThrow(
      InvalidTelemetryInputError,
    );
  });
});
