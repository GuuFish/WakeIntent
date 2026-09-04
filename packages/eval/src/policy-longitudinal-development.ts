import type {
  CandidateDraft,
  ContactPolicySignalDraft,
  ContactPolicyState,
  ContactTarget,
  ConversationEvent,
  SemanticDecisionProposal,
} from "@wakeintent/core";
import {
  runDueGatedBaselineTimeline,
  runWakeIntentTimeline,
  type BaselineTimelineDecision,
  type BaselineTimelineMemory,
  type LongitudinalStep,
} from "./longitudinal.js";

export interface PolicyLongitudinalDecisionBatch {
  at: string;
  decisions: BaselineTimelineDecision[];
}

export interface PolicyLongitudinalDevelopmentScenario {
  id: string;
  timeZone: string;
  target: ContactTarget;
  initialUserState: ContactPolicyState;
  initialEvents: ConversationEvent[];
  steps: LongitudinalStep[];
  oracle: {
    wakeIntent: {
      candidates: CandidateDraft[];
      policySignals: ContactPolicySignalDraft[];
    };
    baseline: {
      memories: BaselineTimelineMemory[];
      decisionBatches: PolicyLongitudinalDecisionBatch[];
    };
  };
  expected: {
    intentCount: number;
    policySignal: ContactPolicySignalDraft;
    originalDueAt: string;
    finalEvaluationAt: string;
    wake: {
      scheduledEvaluationsAtOriginalDue: number;
      finalActions: string[];
    };
    baseline: {
      dueMemoryBatchCallsAtOriginalWindow: number;
      decisionCountInBatch: number;
      finalActions: string[];
    };
  };
}

export interface PolicyLongitudinalDevelopmentDataset {
  schemaVersion: string;
  name: string;
  version: string;
  kind: string;
  scenarios: PolicyLongitudinalDevelopmentScenario[];
}

function cloneCandidate(candidate: CandidateDraft): CandidateDraft {
  return {
    ...candidate,
    evidence: candidate.evidence.map((item) => ({ ...item })),
    cancellationHints: [...candidate.cancellationHints],
    ...(candidate.metadata ? { metadata: { ...candidate.metadata } } : {}),
  };
}

function actionCounts(actions: string[]): Record<string, number> {
  return actions.reduce<Record<string, number>>((counts, action) => {
    counts[action] = (counts[action] ?? 0) + 1;
    return counts;
  }, {});
}

function sameActionMultiset(actual: string[], expected: string[]): boolean {
  const actualCounts = actionCounts(actual);
  const expectedCounts = actionCounts(expected);
  const actions = new Set([
    ...Object.keys(actualCounts),
    ...Object.keys(expectedCounts),
  ]);
  return [...actions].every(
    (action) => (actualCounts[action] ?? 0) === (expectedCounts[action] ?? 0),
  );
}

function logicalWakeCalls(result: Awaited<ReturnType<typeof runWakeIntentTimeline>>): number {
  return (
    result.metrics.extractionModelCalls +
    result.metrics.policySignalExtractionCalls +
    result.metrics.routingCalls +
    result.metrics.semanticDecisionModelCalls
  );
}

export async function evaluatePolicyLongitudinalDevelopmentScenario(
  scenario: PolicyLongitudinalDevelopmentScenario,
) {
  const wakeResult = await runWakeIntentTimeline({
    scenarioId: scenario.id,
    initialEvents: scenario.initialEvents,
    target: scenario.target,
    timeZone: scenario.timeZone,
    initialUserState: scenario.initialUserState,
    steps: scenario.steps,
    generator: {
      async generate() {
        return scenario.oracle.wakeIntent.candidates.map(cloneCandidate);
      },
    },
    policySignalGenerator: {
      async generatePolicySignals(input) {
        const eventIds = new Set(input.events.map((event) => event.id));
        return scenario.oracle.wakeIntent.policySignals
          .filter((signal) => eventIds.has(signal.evidenceRef))
          .map((signal) => ({ ...signal }));
      },
    },
    relevanceRouter: {
      async selectRelevant() {
        return [];
      },
    },
    semanticReevaluator: {
      async evaluate(input): Promise<SemanticDecisionProposal> {
        return {
          action: "contact",
          reason: "The follow-up remains useful after the quiet window.",
          evidenceRefs: input.intent.evidence.map((item) => item.eventId),
          counterEvidenceRefs: [],
          confidence: 1,
          nextEvaluationAt: null,
          metadata: { source: "development-oracle" },
        };
      },
    },
  });

  const decisionBatches = new Map(
    scenario.oracle.baseline.decisionBatches.map((batch) => [batch.at, batch]),
  );
  const baselineResult = await runDueGatedBaselineTimeline({
    memories: scenario.oracle.baseline.memories,
    initialUserState: scenario.initialUserState,
    steps: scenario.steps,
    extractionModelCalls: 1,
    decider: {
      async decide(input) {
        const batch = decisionBatches.get(input.now);
        if (!batch) {
          throw new Error(`No baseline oracle batch exists at ${input.now}`);
        }
        return batch.decisions.map((decision) => ({
          ...decision,
          evidenceRefs: [...decision.evidenceRefs],
        }));
      },
    },
  });

  const originalDueWakeTraces = wakeResult.traces.filter(
    (trace) => trace.trigger === "scheduled" && trace.at === scenario.expected.originalDueAt,
  );
  const originalDueBaselineTraces = baselineResult.traces.filter(
    (trace) => trace.at === scenario.expected.originalDueAt,
  );
  const wakeFinalActions = wakeResult.traces
    .filter((trace) => trace.at === scenario.expected.finalEvaluationAt)
    .map((trace) => trace.decision.action);
  const baselineFinalActions = baselineResult.traces
    .filter((trace) => trace.at === scenario.expected.finalEvaluationAt)
    .flatMap((trace) => trace.decisions.map((decision) => decision.action));
  const policyEvent = scenario.steps
    .flatMap((step) => step.events)
    .find((event) => event.id === scenario.expected.policySignal.evidenceRef);
  const policyReactionLatencyMs = policyEvent
    ? Date.parse(wakeResult.policySnapshot.updatedAt) - Date.parse(policyEvent.occurredAt)
    : null;
  const baselineFirstStateReactionAt = originalDueBaselineTraces[0]?.at ?? null;
  const baselinePolicyReactionLatencyMs = policyEvent && baselineFirstStateReactionAt
    ? Date.parse(baselineFirstStateReactionAt) - Date.parse(policyEvent.occurredAt)
    : null;

  const score = {
    wakeIntentCount: wakeResult.intents.length === scenario.expected.intentCount,
    policySignalApplied:
      wakeResult.policyAudits.some(
        (audit) =>
          audit.kind === scenario.expected.policySignal.kind &&
          audit.evidenceRef === scenario.expected.policySignal.evidenceRef &&
          audit.outcome === "applied",
      ),
    wakeAvoidedOriginalDueEvaluation:
      originalDueWakeTraces.length ===
      scenario.expected.wake.scheduledEvaluationsAtOriginalDue,
    baselineUsedFairBatch:
      originalDueBaselineTraces.length ===
        scenario.expected.baseline.dueMemoryBatchCallsAtOriginalWindow &&
      originalDueBaselineTraces.every(
        (trace) =>
          trace.decisions.length === scenario.expected.baseline.decisionCountInBatch,
      ),
    wakeFinalActions: sameActionMultiset(
      wakeFinalActions,
      scenario.expected.wake.finalActions,
    ),
    baselineFinalActions: sameActionMultiset(
      baselineFinalActions,
      scenario.expected.baseline.finalActions,
    ),
  };

  return {
    scenarioId: scenario.id,
    passed: Object.values(score).every(Boolean),
    score,
    comparison: {
      wakeintent: {
        logicalModelCalls: logicalWakeCalls(wakeResult),
        callBreakdown: {
          extraction: wakeResult.metrics.extractionModelCalls,
          policyExtraction: wakeResult.metrics.policySignalExtractionCalls,
          routing: wakeResult.metrics.routingCalls,
          semanticDecision: wakeResult.metrics.semanticDecisionModelCalls,
        },
        originalDueWakeBatches: originalDueWakeTraces.length,
        policyReactionLatencyMs,
        finalActions: wakeFinalActions,
        tokens: null,
      },
      dueGatedBaseline: {
        logicalModelCalls:
          baselineResult.metrics.extractionModelCalls +
          baselineResult.metrics.decisionModelCalls,
        callBreakdown: {
          extraction: baselineResult.metrics.extractionModelCalls,
          dueDecisionBatches: baselineResult.metrics.decisionModelCalls,
        },
        originalDueWakeBatches: originalDueBaselineTraces.length,
        policyReactionLatencyMs: baselinePolicyReactionLatencyMs,
        finalActions: baselineFinalActions,
        tokens: null,
      },
    },
    wakeintent: wakeResult,
    dueGatedBaseline: baselineResult,
  };
}

export async function evaluatePolicyLongitudinalDevelopmentDataset(
  dataset: PolicyLongitudinalDevelopmentDataset,
) {
  const scenarios = [];
  for (const scenario of dataset.scenarios) {
    scenarios.push(await evaluatePolicyLongitudinalDevelopmentScenario(scenario));
  }
  return {
    scenarios,
    aggregate: {
      scenarios: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.passed).length,
    },
  };
}
