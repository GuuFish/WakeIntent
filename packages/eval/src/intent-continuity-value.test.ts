import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareDecisionSequences,
  summarizeBaselineBehavior,
  summarizeWakeBehavior,
  type IntentContinuityDataset,
} from "./intent-continuity-value.js";

function loadDataset(): IntentContinuityDataset {
  return JSON.parse(
    readFileSync(
      new URL("../../../evals/intent-continuity-value-v1.json", import.meta.url),
      "utf8",
    ),
  ) as IntentContinuityDataset;
}

describe("intent continuity value protocol", () => {
  it("freezes twenty balanced scenarios and three repetitions", () => {
    const dataset = loadDataset();
    expect(dataset.scenarios).toHaveLength(20);
    expect(dataset.repetitions).toBe(3);
    expect(dataset.stopRule.maximumScenarios).toBe(20);
    expect(dataset.stopRule.repetitions).toBe(3);
    expect(new Set(dataset.scenarios.map((item) => item.id)).size).toBe(20);

    const requiredCategories = [
      "normal-followup",
      "early-resolution",
      "explicit-cancellation",
      "defer-then-contact",
      "expiry",
      "context-reversal",
      "relationship-change",
      "multiple-intents",
      "partial-relevance",
      "insufficient-reason",
    ];
    const categories = new Set(dataset.scenarios.map((item) => item.category));
    for (const category of requiredCategories) expect(categories.has(category)).toBe(true);

    for (const scenario of dataset.scenarios) {
      const allEvents = [
        ...scenario.initialEvents,
        ...scenario.steps.flatMap((step) => step.events),
      ];
      const eventIds = allEvents.map((event) => event.id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
      expect(scenario.steps.map((step) => Date.parse(step.at))).toEqual(
        [...scenario.steps.map((step) => Date.parse(step.at))].sort((a, b) => a - b),
      );
      const eventIdSet = new Set(eventIds);
      for (const ref of [
        ...scenario.expected.contactRequiredEvidenceRefs,
        ...scenario.expected.contactForbiddenEvidenceRefs,
      ]) {
        expect(eventIdSet.has(ref)).toBe(true);
      }
    }
  });

  it("contains the fixed busy-then-free living demo", () => {
    const scenario = loadDataset().scenarios.find(
      (item) => item.id === "s07-living-demo-busy-then-free",
    );
    expect(scenario?.initialEvents[0]?.actor).toBe("assistant");
    expect(scenario?.steps.map((step) => step.events[0]?.id)).toEqual([
      "s07-busy",
      "s07-free",
    ]);
    expect(scenario?.expected.wakeOutcomes.map((item) => item.allowedActions)).toEqual([
      ["defer"],
      ["contact"],
    ]);
  });

  it("compares complete action sequences and counts outreach errors", () => {
    const scenario = loadDataset().scenarios[0]!;
    const wakeResult = {
      intents: [{
        schemaVersion: "0.1.0" as const,
        id: "i1",
        target: scenario.target,
        subject: "job",
        reason: "follow up",
        evidence: [{ eventId: "s01-plan" }],
        createdAt: scenario.initialEvents[0]!.occurredAt,
        notBefore: scenario.steps[0]!.at,
        expiresAt: null,
        cancellationHints: [],
        priority: 1,
        interruptionCost: 0,
        confidence: 1,
        status: "active" as const,
        updatedAt: scenario.steps[0]!.at,
      }],
      traces: [{
        at: scenario.steps[0]!.at,
        trigger: "scheduled" as const,
        intentId: "i1",
        source: "semantic" as const,
        decision: {
          id: "d1",
          intentId: "i1",
          evaluatedAt: scenario.steps[0]!.at,
          action: "contact" as const,
          reason: "due",
          evidenceRefs: ["s01-plan"],
          counterEvidenceRefs: [],
          confidence: 1,
          nextEvaluationAt: null,
          policyVersion: "test",
        },
      }],
      metrics: {
        extractionModelCalls: 1,
        policySignalExtractionCalls: 0,
        policySignalsApplied: 0,
        routingCalls: 0,
        reevaluationAttempts: 1,
        semanticDecisionModelCalls: 1,
        contactDecisions: 1,
        terminalDecisions: 0,
      },
      pendingEvaluationAt: {},
      policySnapshot: {
        state: scenario.initialUserState,
        appliedSignalIds: [],
        updatedAt: scenario.initialEvents[0]!.occurredAt,
      },
      policyAudits: [],
    };
    const memories = [{
      id: "m1",
      summary: "job",
      dueAt: scenario.steps[0]!.at,
      evidenceRefs: ["s01-plan"],
    }];
    const baselineResult = {
      memories: [],
      traces: [{
        at: scenario.steps[0]!.at,
        decisions: [{
          memoryId: "m1",
          action: "contact" as const,
          reason: "due",
          evidenceRefs: ["s01-plan"],
          nextEvaluationAt: null,
        }],
      }],
      metrics: {
        extractionModelCalls: 1,
        deterministicChecks: 1,
        decisionModelCalls: 1,
        contactDecisions: 1,
        terminalDecisions: 0,
      },
    };
    const wake = summarizeWakeBehavior(scenario, wakeResult);
    const baseline = summarizeBaselineBehavior(scenario, memories, baselineResult);
    expect(wake.missedFollowup).toBe(0);
    expect(baseline.falseOutreach).toBe(0);
    expect(compareDecisionSequences(wake, baseline)).toEqual({
      agreements: 1,
      comparisons: 1,
      rate: 1,
    });
  });
});
