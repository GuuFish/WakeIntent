import type {
  ContactPolicyState,
  ContactTarget,
  ConversationEvent,
  DecisionAction,
} from "@wakeintent/core";
import type {
  BaselineTimelineMemory,
  DueGatedBaselineTimelineResult,
  LongitudinalStep,
  WakeIntentTimelineResult,
} from "./longitudinal.js";

const terminalActions = new Set<DecisionAction>([
  "cancel",
  "expire",
  "resolve",
]);

export interface AlphaClosureExpectedOutcome {
  intentEvidenceRef: string;
  at: string;
  allowedActions: DecisionAction[];
  requiredDecisionEvidenceRefs?: string[];
  trigger?: LongitudinalStep["kind"];
  allowedSources?: Array<"hard-gate" | "semantic">;
}

export interface AlphaClosureScenario {
  id: string;
  category: string;
  timeZone: string;
  target: ContactTarget;
  initialUserState: ContactPolicyState;
  initialEvents: ConversationEvent[];
  steps: LongitudinalStep[];
  expected: {
    intentCount: number;
    baselineMemoryCount: number;
    wakeOutcomes: AlphaClosureExpectedOutcome[];
    baselineOutcomes: AlphaClosureExpectedOutcome[];
    requiredPolicySignals?: Array<{
      kind: "set-do-not-disturb" | "clear-do-not-disturb" | "set-authorization";
      evidenceRef: string;
    }>;
    forbiddenContactIntentEvidenceRefs?: string[];
    forbiddenWakeTraceTimes?: string[];
    allowedAdditionalWakeActions?: DecisionAction[];
    allowedAdditionalBaselineActions?: DecisionAction[];
    comparisonClaim:
      | "behavioral-parity"
      | "earlier-terminal-state"
      | "global-policy-broadcast"
      | "deterministic-hard-gate"
      | "negative-extraction";
    annotation: string;
  };
}

export interface AlphaClosureDataset {
  schemaVersion: string;
  name: string;
  version: string;
  kind: "alpha-closure-longitudinal-fixtures";
  frozenAt: string;
  stopRule: {
    maximumScenarios: number;
    minimumPassedScenarios: number;
    maximumFalseOutreach: number;
    requireAllSafetyScenarios: boolean;
    note: string;
  };
  scenarios: AlphaClosureScenario[];
}

interface OutcomeMatch {
  expected: AlphaClosureExpectedOutcome;
  matched: boolean;
  actualAction: DecisionAction | null;
  actualAt: string | null;
}

function allDecisionEvidence(
  evidenceRefs: string[],
  counterEvidenceRefs?: string[],
): Set<string> {
  return new Set([...evidenceRefs, ...(counterEvidenceRefs ?? [])]);
}

function matchWakeOutcomes(
  scenario: AlphaClosureScenario,
  wakeResult: WakeIntentTimelineResult,
): { matches: OutcomeMatch[]; used: Set<number> } {
  const used = new Set<number>();
  const matches = scenario.expected.wakeOutcomes.map((expected) => {
    const traceIndex = wakeResult.traces.findIndex((trace, index) => {
      if (used.has(index)) return false;
      const intent = wakeResult.intents.find((item) => item.id === trace.intentId);
      if (!intent?.evidence.some((item) => item.eventId === expected.intentEvidenceRef)) {
        return false;
      }
      if (trace.at !== expected.at) return false;
      if (expected.trigger && trace.trigger !== expected.trigger) return false;
      if (!expected.allowedActions.includes(trace.decision.action)) return false;
      if (expected.allowedSources && !expected.allowedSources.includes(trace.source)) {
        return false;
      }
      const evidence = allDecisionEvidence(
        trace.decision.evidenceRefs,
        trace.decision.counterEvidenceRefs,
      );
      return (expected.requiredDecisionEvidenceRefs ?? []).every((ref) =>
        evidence.has(ref),
      );
    });
    if (traceIndex === -1) {
      return { expected, matched: false, actualAction: null, actualAt: null };
    }
    used.add(traceIndex);
    const trace = wakeResult.traces[traceIndex]!;
    return {
      expected,
      matched: true,
      actualAction: trace.decision.action,
      actualAt: trace.at,
    };
  });
  return { matches, used };
}

function matchBaselineOutcomes(
  scenario: AlphaClosureScenario,
  memories: BaselineTimelineMemory[],
  baselineResult: DueGatedBaselineTimelineResult,
): { matches: OutcomeMatch[]; used: Set<string> } {
  const memoryEvidence = new Map(
    memories.map((memory) => [memory.id, new Set(memory.evidenceRefs)]),
  );
  const used = new Set<string>();
  const decisions = baselineResult.traces.flatMap((trace, traceIndex) =>
    trace.decisions.map((decision, decisionIndex) => ({
      key: `${traceIndex}:${decisionIndex}`,
      at: trace.at,
      decision,
    })),
  );
  const matches = scenario.expected.baselineOutcomes.map((expected) => {
    const actual = decisions.find((item) => {
      if (used.has(item.key)) return false;
      if (item.at !== expected.at) return false;
      if (!expected.allowedActions.includes(item.decision.action)) return false;
      if (!memoryEvidence.get(item.decision.memoryId)?.has(expected.intentEvidenceRef)) {
        return false;
      }
      const evidence = allDecisionEvidence(item.decision.evidenceRefs);
      return (expected.requiredDecisionEvidenceRefs ?? []).every((ref) =>
        evidence.has(ref),
      );
    });
    if (!actual) {
      return { expected, matched: false, actualAction: null, actualAt: null };
    }
    used.add(actual.key);
    return {
      expected,
      matched: true,
      actualAction: actual.decision.action,
      actualAt: actual.at,
    };
  });
  return { matches, used };
}

export function scoreAlphaClosureScenario(input: {
  scenario: AlphaClosureScenario;
  wakeResult: WakeIntentTimelineResult;
  baselineMemories: BaselineTimelineMemory[];
  baselineResult: DueGatedBaselineTimelineResult;
}) {
  const { scenario, wakeResult, baselineMemories, baselineResult } = input;
  const wake = matchWakeOutcomes(scenario, wakeResult);
  const baseline = matchBaselineOutcomes(scenario, baselineMemories, baselineResult);
  const allowedWakeExtras = new Set(
    scenario.expected.allowedAdditionalWakeActions ?? [],
  );
  const unexpectedWakeTraces = wakeResult.traces.filter(
    (trace, index) => !wake.used.has(index) && !allowedWakeExtras.has(trace.decision.action),
  );
  const allowedBaselineExtras = new Set(
    scenario.expected.allowedAdditionalBaselineActions ?? [],
  );
  const unexpectedBaselineDecisions = baselineResult.traces.flatMap(
    (trace, traceIndex) =>
      trace.decisions.filter(
        (decision, decisionIndex) =>
          !baseline.used.has(`${traceIndex}:${decisionIndex}`) &&
          !allowedBaselineExtras.has(decision.action),
      ),
  );
  const forbiddenEvidence = new Set(
    scenario.expected.forbiddenContactIntentEvidenceRefs ?? [],
  );
  const wakeFalseOutreach = wakeResult.traces.filter((trace) => {
    if (trace.decision.action !== "contact") return false;
    const intent = wakeResult.intents.find((item) => item.id === trace.intentId);
    return intent?.evidence.some((item) => forbiddenEvidence.has(item.eventId)) ?? false;
  });
  const baselineEvidence = new Map(
    baselineMemories.map((memory) => [memory.id, new Set(memory.evidenceRefs)]),
  );
  const baselineFalseOutreach = baselineResult.traces.flatMap((trace) =>
    trace.decisions.filter(
      (decision) =>
        decision.action === "contact" &&
        [...(baselineEvidence.get(decision.memoryId) ?? [])].some((ref) =>
          forbiddenEvidence.has(ref),
        ),
    ),
  );
  const forbiddenWakeTraceTimes = new Set(
    scenario.expected.forbiddenWakeTraceTimes ?? [],
  );
  const policySignalsSatisfied = (scenario.expected.requiredPolicySignals ?? []).every(
    (expected) =>
      wakeResult.policyAudits.some(
        (audit) =>
          audit.kind === expected.kind &&
          audit.evidenceRef === expected.evidenceRef &&
          audit.outcome === "applied",
      ),
  );

  const score = {
    wakeIntentCount: wakeResult.intents.length === scenario.expected.intentCount,
    baselineMemoryCount: baselineMemories.length === scenario.expected.baselineMemoryCount,
    wakeOutcomes: wake.matches.every((item) => item.matched),
    baselineOutcomes: baseline.matches.every((item) => item.matched),
    noUnexpectedWakeTraces: unexpectedWakeTraces.length === 0,
    noUnexpectedBaselineDecisions: unexpectedBaselineDecisions.length === 0,
    wakeNoFalseOutreach: wakeFalseOutreach.length === 0,
    baselineNoFalseOutreach: baselineFalseOutreach.length === 0,
    wakeAvoidedForbiddenTimes: wakeResult.traces.every(
      (trace) => !forbiddenWakeTraceTimes.has(trace.at),
    ),
    policySignalsSatisfied,
  };

  const staleStateAvoidedByIntent = scenario.expected.wakeOutcomes
    .filter((outcome) => outcome.allowedActions.some((action) => terminalActions.has(action)))
    .map((wakeOutcome) => {
      const baselineOutcome = scenario.expected.baselineOutcomes.find(
        (item) =>
          item.intentEvidenceRef === wakeOutcome.intentEvidenceRef &&
          item.allowedActions.some((action) => terminalActions.has(action)),
      );
      return {
        intentEvidenceRef: wakeOutcome.intentEvidenceRef,
        milliseconds: baselineOutcome
          ? Math.max(0, Date.parse(baselineOutcome.at) - Date.parse(wakeOutcome.at))
          : null,
      };
    });

  return {
    scenarioId: scenario.id,
    category: scenario.category,
    comparisonClaim: scenario.expected.comparisonClaim,
    passed: Object.values(score).every(Boolean),
    score,
    wakeOutcomeMatches: wake.matches,
    baselineOutcomeMatches: baseline.matches,
    unexpectedWakeTraces,
    unexpectedBaselineDecisions,
    falseOutreach: {
      wakeintent: wakeFalseOutreach.length,
      dueGatedBaseline: baselineFalseOutreach.length,
    },
    staleStateAvoidedByIntent,
  };
}

export function evaluateAlphaClosureStopRule(
  dataset: AlphaClosureDataset,
  scored: Array<ReturnType<typeof scoreAlphaClosureScenario>>,
) {
  const scoredByScenario = new Map(scored.map((item) => [item.scenarioId, item]));
  const passed = scored.filter((item) => item.passed).length;
  const falseOutreach = scored.reduce(
    (total, item) => total + item.falseOutreach.wakeintent,
    0,
  );
  const safetyCategories = new Set([
    "early-resolution",
    "explicit-cancellation",
    "implicit-supersession",
    "global-policy",
    "expiry",
    "non-response",
    "negative-extraction",
  ]);
  const safetyPassed = dataset.scenarios
    .filter((scenario) => safetyCategories.has(scenario.category))
    .every((scenario) => scoredByScenario.get(scenario.id)?.passed === true);
  const checks = {
    scenarioCapRespected: dataset.scenarios.length <= dataset.stopRule.maximumScenarios,
    allScenariosScored: dataset.scenarios.every((scenario) =>
      scoredByScenario.has(scenario.id),
    ),
    enoughScenariosPassed: passed >= dataset.stopRule.minimumPassedScenarios,
    falseOutreachWithinLimit: falseOutreach <= dataset.stopRule.maximumFalseOutreach,
    safetyScenariosPassed:
      !dataset.stopRule.requireAllSafetyScenarios || safetyPassed,
  };
  return {
    decision: Object.values(checks).every(Boolean) ? "GO" : "REVIEW",
    checks,
    passed,
    total: dataset.scenarios.length,
    scored: scored.length,
    wakeFalseOutreach: falseOutreach,
  } as const;
}
