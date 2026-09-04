import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateAlphaClosureStopRule,
  scoreAlphaClosureScenario,
  type AlphaClosureDataset,
} from "./alpha-closure.js";

function loadDataset(): AlphaClosureDataset {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../../evals/alpha-closure-longitudinal-v0.1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as AlphaClosureDataset;
}

describe("alpha closure dataset", () => {
  it("freezes exactly twelve chronological, evidence-complete scenarios", () => {
    const dataset = loadDataset();
    expect(dataset.scenarios).toHaveLength(12);
    expect(dataset.stopRule.maximumScenarios).toBe(12);
    expect(new Set(dataset.scenarios.map((scenario) => scenario.id)).size).toBe(12);

    for (const scenario of dataset.scenarios) {
      const stepTimes = scenario.steps.map((step) => Date.parse(step.at));
      expect(stepTimes.every((time) => !Number.isNaN(time))).toBe(true);
      expect(stepTimes).toEqual([...stepTimes].sort((left, right) => left - right));
      const events = [
        ...scenario.initialEvents,
        ...scenario.steps.flatMap((step) => step.events),
      ];
      const eventIds = events.map((event) => event.id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
      const eventIdSet = new Set(eventIds);
      for (const outcome of [
        ...scenario.expected.wakeOutcomes,
        ...scenario.expected.baselineOutcomes,
      ]) {
        expect(eventIdSet.has(outcome.intentEvidenceRef)).toBe(true);
        expect((outcome.requiredDecisionEvidenceRefs ?? []).every((ref) =>
          eventIdSet.has(ref),
        )).toBe(true);
      }
      for (const signal of scenario.expected.requiredPolicySignals ?? []) {
        const event = events.find((item) => item.id === signal.evidenceRef);
        expect(event?.actor).toBe("user");
      }
    }
  });

  it("accepts a correctly matched explicit follow-up result", () => {
    const scenario = loadDataset().scenarios.find(
      (item) => item.id === "explicit-followup-contact",
    )!;
    const wakeResult = {
      intents: [{
        schemaVersion: "0.1.0" as const,
        id: "intent-1",
        target: scenario.target,
        subject: "复试结果",
        reason: "用户要求跟进。",
        evidence: [{ eventId: "contact-plan" }],
        createdAt: "2026-09-01T09:00:00.000Z",
        notBefore: "2026-09-05T12:00:00.000Z",
        expiresAt: null,
        cancellationHints: [],
        priority: 1,
        interruptionCost: 0,
        confidence: 1,
        status: "active" as const,
        updatedAt: "2026-09-05T12:00:00.000Z",
      }],
      traces: [{
        at: "2026-09-05T12:00:00.000Z",
        trigger: "scheduled" as const,
        intentId: "intent-1",
        source: "semantic" as const,
        decision: {
          id: "decision-1",
          intentId: "intent-1",
          evaluatedAt: "2026-09-05T12:00:00.000Z",
          action: "contact" as const,
          reason: "The requested time arrived.",
          evidenceRefs: ["contact-plan"],
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
        updatedAt: "2026-09-01T09:00:00.000Z",
      },
      policyAudits: [],
    };
    const baselineMemories = [{
      id: "memory-1",
      summary: "复试结果跟进",
      dueAt: "2026-09-05T12:00:00.000Z",
      evidenceRefs: ["contact-plan"],
    }];
    const baselineResult = {
      memories: [],
      traces: [{
        at: "2026-09-05T12:00:00.000Z",
        decisions: [{
          memoryId: "memory-1",
          action: "contact" as const,
          reason: "The requested time arrived.",
          evidenceRefs: ["contact-plan"],
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

    const score = scoreAlphaClosureScenario({
      scenario,
      wakeResult,
      baselineMemories,
      baselineResult,
    });
    expect(score.passed).toBe(true);
    expect(score.falseOutreach).toEqual({ wakeintent: 0, dueGatedBaseline: 0 });
  });

  it("turns the finite stop rule into a GO decision without adding scenarios", () => {
    const dataset = loadDataset();
    const scored = dataset.scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      category: scenario.category,
      comparisonClaim: scenario.expected.comparisonClaim,
      passed: true,
      score: {
        wakeIntentCount: true,
        baselineMemoryCount: true,
        wakeOutcomes: true,
        baselineOutcomes: true,
        noUnexpectedWakeTraces: true,
        noUnexpectedBaselineDecisions: true,
        wakeNoFalseOutreach: true,
        baselineNoFalseOutreach: true,
        wakeAvoidedForbiddenTimes: true,
        policySignalsSatisfied: true,
      },
      wakeOutcomeMatches: [],
      baselineOutcomeMatches: [],
      unexpectedWakeTraces: [],
      unexpectedBaselineDecisions: [],
      falseOutreach: { wakeintent: 0, dueGatedBaseline: 0 },
      staleStateAvoidedByIntent: [],
    }));

    expect(evaluateAlphaClosureStopRule(dataset, scored)).toMatchObject({
      decision: "GO",
      passed: 12,
      total: 12,
      wakeFalseOutreach: 0,
    });
  });

  it("returns REVIEW when a completed run has unscored scenarios", () => {
    const dataset = loadDataset();
    const scored = dataset.scenarios.slice(0, 10).map((scenario) => ({
      scenarioId: scenario.id,
      category: scenario.category,
      comparisonClaim: scenario.expected.comparisonClaim,
      passed: true,
      score: {
        wakeIntentCount: true,
        baselineMemoryCount: true,
        wakeOutcomes: true,
        baselineOutcomes: true,
        noUnexpectedWakeTraces: true,
        noUnexpectedBaselineDecisions: true,
        wakeNoFalseOutreach: true,
        baselineNoFalseOutreach: true,
        wakeAvoidedForbiddenTimes: true,
        policySignalsSatisfied: true,
      },
      wakeOutcomeMatches: [],
      baselineOutcomeMatches: [],
      unexpectedWakeTraces: [],
      unexpectedBaselineDecisions: [],
      falseOutreach: { wakeintent: 0, dueGatedBaseline: 0 },
      staleStateAvoidedByIntent: [],
    }));

    expect(evaluateAlphaClosureStopRule(dataset, scored)).toMatchObject({
      decision: "REVIEW",
      passed: 10,
      scored: 10,
      total: 12,
      checks: {
        allScenariosScored: false,
        safetyScenariosPassed: false,
      },
    });
  });
});
