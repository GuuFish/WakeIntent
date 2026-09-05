import type { DecisionAction } from "@wakeintent/core";
import type { AlphaClosureScenario } from "./alpha-closure.js";
import type {
  BaselineTimelineMemory,
  DueGatedBaselineTimelineResult,
  WakeIntentTimelineResult,
} from "./longitudinal.js";

export const INTENT_CONTINUITY_PROTOCOL_VERSION = "1.0.0";

export interface IntentContinuityScenario extends AlphaClosureScenario {
  expected: AlphaClosureScenario["expected"] & {
    contactRequiredEvidenceRefs: string[];
    contactForbiddenEvidenceRefs: string[];
  };
}

export interface IntentContinuityDataset {
  schemaVersion: "1.0.0";
  name: string;
  version: string;
  kind: "intent-continuity-value-fixtures";
  frozenAt: string;
  repetitions: number;
  hypothesis: string;
  fairness: {
    sameModel: true;
    sameProviderDefaultTemperature: true;
    sameInitialEvents: true;
    sameLatestEvents: true;
    sameClockAndTimeZone: true;
    sameUserState: true;
    baselineHasFutureMemory: true;
  };
  stopRule: {
    maximumScenarios: number;
    repetitions: number;
    independentValueFalseOutreachReductionPoints: number;
    independentValueMissedFollowupReductionPoints: number;
    parityAgreementThreshold: number;
    humanContinuityMeanDifference: number;
    note: string;
  };
  scenarios: IntentContinuityScenario[];
}

export interface ArmBehaviorSummary {
  actionSequences: Record<string, DecisionAction[]>;
  falseOutreach: number;
  missedFollowup: number;
  expectedContacts: number;
  actualContacts: number;
  continuityChecks: number;
  continuityPasses: number;
}

function wakeEvidenceRef(
  result: WakeIntentTimelineResult,
  intentId: string,
): string | null {
  return result.intents.find((intent) => intent.id === intentId)?.evidence[0]?.eventId ?? null;
}

function baselineEvidenceRef(
  memories: BaselineTimelineMemory[],
  memoryId: string,
): string | null {
  return memories.find((memory) => memory.id === memoryId)?.evidenceRefs[0] ?? null;
}

function appendAction(
  sequences: Record<string, DecisionAction[]>,
  evidenceRef: string | null,
  action: DecisionAction,
): void {
  if (evidenceRef === null) return;
  (sequences[evidenceRef] ??= []).push(action);
}

function summarize(
  scenario: IntentContinuityScenario,
  actionSequences: Record<string, DecisionAction[]>,
): ArmBehaviorSummary {
  const required = new Set(scenario.expected.contactRequiredEvidenceRefs);
  const forbidden = new Set(scenario.expected.contactForbiddenEvidenceRefs);
  let falseOutreach = 0;
  let actualContacts = 0;
  let missedFollowup = 0;
  for (const [evidenceRef, actions] of Object.entries(actionSequences)) {
    const contacts = actions.filter((action) => action === "contact").length;
    actualContacts += contacts;
    if (forbidden.has(evidenceRef)) falseOutreach += contacts;
  }
  for (const evidenceRef of required) {
    if (!(actionSequences[evidenceRef] ?? []).includes("contact")) missedFollowup += 1;
  }
  const continuityRefs = new Set([
    ...scenario.expected.contactRequiredEvidenceRefs,
    ...scenario.expected.contactForbiddenEvidenceRefs,
    ...scenario.expected.wakeOutcomes.map((outcome) => outcome.intentEvidenceRef),
    ...scenario.expected.baselineOutcomes.map((outcome) => outcome.intentEvidenceRef),
  ]);
  return {
    actionSequences,
    falseOutreach,
    missedFollowup,
    expectedContacts: required.size,
    actualContacts,
    continuityChecks: continuityRefs.size,
    continuityPasses: [...continuityRefs].filter(
      (evidenceRef) => (actionSequences[evidenceRef] ?? []).length > 0,
    ).length,
  };
}

export function summarizeWakeBehavior(
  scenario: IntentContinuityScenario,
  result: WakeIntentTimelineResult,
): ArmBehaviorSummary {
  const sequences: Record<string, DecisionAction[]> = {};
  for (const trace of result.traces) {
    appendAction(sequences, wakeEvidenceRef(result, trace.intentId), trace.decision.action);
  }
  return summarize(scenario, sequences);
}

export function summarizeBaselineBehavior(
  scenario: IntentContinuityScenario,
  initialMemories: BaselineTimelineMemory[],
  result: DueGatedBaselineTimelineResult,
): ArmBehaviorSummary {
  const sequences: Record<string, DecisionAction[]> = {};
  for (const trace of result.traces) {
    for (const decision of trace.decisions) {
      appendAction(
        sequences,
        baselineEvidenceRef(initialMemories, decision.memoryId),
        decision.action,
      );
    }
  }
  return summarize(scenario, sequences);
}

export function compareDecisionSequences(
  wake: ArmBehaviorSummary,
  baseline: ArmBehaviorSummary,
): { agreements: number; comparisons: number; rate: number | null } {
  const refs = new Set([
    ...Object.keys(wake.actionSequences),
    ...Object.keys(baseline.actionSequences),
  ]);
  let agreements = 0;
  for (const ref of refs) {
    if (
      JSON.stringify(wake.actionSequences[ref] ?? []) ===
      JSON.stringify(baseline.actionSequences[ref] ?? [])
    ) {
      agreements += 1;
    }
  }
  return {
    agreements,
    comparisons: refs.size,
    rate: refs.size === 0 ? null : agreements / refs.size,
  };
}
