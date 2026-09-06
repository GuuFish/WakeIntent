import { describe, expect, it } from "vitest";
import {
  scoreAutonomousRun,
  selectAutonomousConclusion,
  validateAutonomousExperienceDataset,
  type AutonomousExperienceDataset,
  type AutonomousExperienceScenario,
} from "./autonomous-experience.js";

const rule = {
  resultCMinimumValuableHardToReconstructRate: 0.25,
  resultCMinimumStableScenarioCount: 5,
  resultCMaximumFabricationRate: 0,
  resultCMaximumHarmfulRate: 0.05,
  resultBMinimumBehaviorDifferenceRate: 0.2,
};

describe("autonomous experience scoring", () => {
  it("requires actual away-result provenance for positive evidence", () => {
    const scenario: AutonomousExperienceScenario = {
      id: "s01",
      category: "discovery",
      valueOpportunity: true,
      phase1: [{ id: "p1", at: "2026-09-01T00:00:00Z", role: "user", content: "x" }],
      awayAt: "2026-09-02T00:00:00Z",
      phase3: [],
      returnAt: "2026-09-03T00:00:00Z",
      reentry: { kind: "user_message", content: "hi" },
      userState: {},
      tools: [{
        queryKey: "q",
        description: "q",
        awayResults: [{ id: "real-result", content: "fact", observedAt: "2026-09-02T00:00:00Z" }],
        returnResults: [],
      }],
      expected: {
        awayActions: ["lookup"],
        reentryActions: ["respond_with_experience"],
        experienceUse: "valuable",
        notes: "",
      },
    };
    const score = scoreAutonomousRun({
      scenario,
      experience: {
        id: "experience-1",
        recorded: true,
        resultRefs: ["invented-result"],
        stateChanges: [],
        pendingShare: true,
        summary: "invented",
      },
      autonomousDecision: {
        action: "respond_with_experience",
        message: "x",
        reason: "x",
        experienceRefs: ["experience-1"],
        toolResultRefs: [],
      },
      judge: {
        behaviorDifferent: true,
        experienceCausal: true,
        baselineCanReconstruct: false,
        userValue: 5,
        impact: "autonomous_better",
        rationale: "x",
      },
    });
    expect(score.fabricatedProvenance).toBe(true);
    expect(score.valuableHardToReconstruct).toBe(false);
  });

  it("accepts conversation evidence without treating it as an autonomous experience", () => {
    const scenario: AutonomousExperienceScenario = {
      id: "s02",
      category: "discovery",
      valueOpportunity: true,
      phase1: [{ id: "p1", at: "2026-09-01T00:00:00Z", role: "user", content: "x" }],
      awayAt: "2026-09-02T00:00:00Z",
      phase3: [],
      returnAt: "2026-09-03T00:00:00Z",
      reentry: { kind: "user_message", content: "hi" },
      userState: {},
      tools: [{
        queryKey: "q",
        description: "q",
        awayResults: [{ id: "real-result", content: "fact", observedAt: "2026-09-02T00:00:00Z" }],
        returnResults: [],
      }],
      expected: {
        awayActions: ["lookup"],
        reentryActions: ["respond_with_experience"],
        experienceUse: "valuable",
        notes: "",
      },
    };
    const score = scoreAutonomousRun({
      scenario,
      experience: {
        id: "experience-1",
        recorded: true,
        resultRefs: ["real-result"],
        stateChanges: [],
        pendingShare: true,
        summary: "supported",
      },
      autonomousDecision: {
        action: "respond_with_experience",
        message: "x",
        reason: "x",
        experienceRefs: ["p1", "experience-1"],
        toolResultRefs: [],
      },
      judge: {
        behaviorDifferent: true,
        experienceCausal: true,
        baselineCanReconstruct: false,
        userValue: 5,
        impact: "autonomous_better",
        rationale: "x",
      },
      actualAwayResultRefs: ["real-result"],
      validConversationEvidenceRefs: ["p1"],
    });
    expect(score.fabricatedProvenance).toBe(false);
    expect(score.experienceUsed).toBe(true);
    expect(score.valuableHardToReconstruct).toBe(true);
  });
  it("selects C only when value, stability, provenance, and harm thresholds all pass", () => {
    expect(selectAutonomousConclusion({
      completedRuns: 60,
      behaviorDifferentRuns: 30,
      valuableHardToReconstructRuns: 16,
      fabricatedRuns: 0,
      harmfulRuns: 3,
      stableValuableScenarioCount: 5,
    }, rule)).toBe("C_VALUABLE_HARD_TO_RECONSTRUCT");
    expect(selectAutonomousConclusion({
      completedRuns: 60,
      behaviorDifferentRuns: 30,
      valuableHardToReconstructRuns: 16,
      fabricatedRuns: 1,
      harmfulRuns: 3,
      stableValuableScenarioCount: 5,
    }, rule)).toBe("B_DIFFERENT_NOT_VALUABLE");
  });

  it("freezes at least twenty scenarios and one away activity", () => {
    const scenario: AutonomousExperienceScenario = {
      id: "s",
      category: "x",
      valueOpportunity: false,
      phase1: [{ id: "p", at: "2026-09-01T00:00:00Z", role: "user", content: "x" }],
      awayAt: "2026-09-02T00:00:00Z",
      phase3: [],
      returnAt: "2026-09-03T00:00:00Z",
      reentry: { kind: "proactive_checkpoint", content: null },
      userState: {},
      tools: [],
      expected: {
        awayActions: ["do_nothing"],
        reentryActions: ["silent"],
        experienceUse: "harmful",
        notes: "",
      },
    };
    const dataset = {
      schemaVersion: "1.0.0",
      version: "1.0.0",
      frozenAt: "2026-09-06T00:00:00Z",
      repetitions: 3,
      hypothesis: "x",
      budgets: {
        maximumAwayActivities: 1,
        maximumAwayModelCalls: 2,
        maximumReturnToolCallsPerArm: 1,
        maximumLogicalRequestsPerPairedRun: 7,
      },
      conclusionRule: rule,
      scenarios: Array.from({ length: 20 }, (_, index) => ({ ...scenario, id: `s-${index}` })),
    } satisfies AutonomousExperienceDataset;
    expect(() => validateAutonomousExperienceDataset(dataset)).not.toThrow();
  });
});
