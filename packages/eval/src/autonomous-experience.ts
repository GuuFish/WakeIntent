export const AUTONOMOUS_EXPERIENCE_PROTOCOL_VERSION = "1.0.0";

export type ExperienceAction = "do_nothing" | "lookup";
export type ReentryAction =
  | "respond"
  | "respond_with_experience"
  | "contact"
  | "defer"
  | "silent";

export interface AutonomousExperienceScenario {
  id: string;
  category: string;
  valueOpportunity: boolean;
  phase1: Array<{ id: string; at: string; role: "user" | "assistant"; content: string }>;
  awayAt: string;
  phase3: Array<{ id: string; at: string; role: "user" | "assistant" | "world"; content: string }>;
  returnAt: string;
  reentry: { kind: "user_message" | "proactive_checkpoint"; content: string | null };
  userState: Record<string, unknown>;
  tools: Array<{
    queryKey: string;
    description: string;
    awayResults: Array<{ id: string; content: string; observedAt: string }>;
    returnResults: Array<{ id: string; content: string; observedAt: string }>;
  }>;
  expected: {
    awayActions: ExperienceAction[];
    reentryActions: ReentryAction[];
    experienceUse: "valuable" | "optional" | "harmful";
    notes: string;
  };
}

export interface AutonomousExperienceDataset {
  schemaVersion: "1.0.0";
  version: string;
  frozenAt: string;
  repetitions: number;
  hypothesis: string;
  budgets: {
    maximumAwayActivities: number;
    maximumAwayModelCalls: number;
    maximumReturnToolCallsPerArm: number;
    maximumLogicalRequestsPerPairedRun: number;
  };
  conclusionRule: {
    resultCMinimumValuableHardToReconstructRate: number;
    resultCMinimumStableScenarioCount: number;
    resultCMaximumFabricationRate: number;
    resultCMaximumHarmfulRate: number;
    resultBMinimumBehaviorDifferenceRate: number;
  };
  scenarios: AutonomousExperienceScenario[];
}

export interface ExperienceRecord {
  id: string;
  recorded: boolean;
  resultRefs: string[];
  stateChanges: Array<{ kind: string; value: string }>;
  pendingShare: boolean;
  summary: string | null;
}

export interface ReentryDecision {
  action: ReentryAction;
  message: string | null;
  reason: string;
  experienceRefs: string[];
  toolResultRefs: string[];
}

export interface BlindJudgeResult {
  behaviorDifferent: boolean;
  experienceCausal: boolean;
  baselineCanReconstruct: boolean;
  userValue: number;
  impact: "autonomous_better" | "same" | "baseline_better";
  rationale: string;
}

export interface ScoredAutonomousRun {
  behaviorDifferent: boolean;
  experienceUsed: boolean;
  fabricatedProvenance: boolean;
  valuableHardToReconstruct: boolean;
  harmful: boolean;
  expectedActionPass: boolean;
}

export interface AutonomousAggregate {
  completedRuns: number;
  behaviorDifferentRuns: number;
  valuableHardToReconstructRuns: number;
  fabricatedRuns: number;
  harmfulRuns: number;
  stableValuableScenarioCount: number;
}

export type AutonomousConclusion = "A_NO_ADDITIONAL_VALUE" | "B_DIFFERENT_NOT_VALUABLE" | "C_VALUABLE_HARD_TO_RECONSTRUCT";

export function validateAutonomousExperienceDataset(
  dataset: AutonomousExperienceDataset,
): void {
  if (dataset.schemaVersion !== "1.0.0") throw new Error("Unsupported schemaVersion");
  if (dataset.scenarios.length < 20) throw new Error("At least 20 frozen scenarios are required");
  if (dataset.repetitions !== 3) throw new Error("The frozen protocol requires exactly 3 repetitions");
  if (dataset.budgets.maximumAwayActivities !== 1) throw new Error("Away activity must be limited to one");
  if (dataset.budgets.maximumAwayModelCalls > 2) throw new Error("Away model calls exceed the frozen limit");
  const ids = new Set<string>();
  for (const scenario of dataset.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (Date.parse(scenario.awayAt) <= Date.parse(scenario.phase1.at(-1)?.at ?? "")) {
      throw new Error(`${scenario.id}: awayAt must follow phase1`);
    }
    if (Date.parse(scenario.returnAt) <= Date.parse(scenario.awayAt)) {
      throw new Error(`${scenario.id}: returnAt must follow awayAt`);
    }
    const queryKeys = new Set<string>();
    const resultIds = new Set<string>();
    for (const tool of scenario.tools) {
      if (queryKeys.has(tool.queryKey)) throw new Error(`${scenario.id}: duplicate tool queryKey`);
      queryKeys.add(tool.queryKey);
      for (const result of [...tool.awayResults, ...tool.returnResults]) {
        if (resultIds.has(result.id)) throw new Error(`${scenario.id}: duplicate tool result id`);
        resultIds.add(result.id);
      }
    }
  }
}

export function scoreAutonomousRun(input: {
  scenario: AutonomousExperienceScenario;
  experience: ExperienceRecord | null;
  autonomousDecision: ReentryDecision;
  judge: BlindJudgeResult;
  actualAwayResultRefs?: string[];
  validConversationEvidenceRefs?: string[];
}): ScoredAutonomousRun {
  const knownResults = new Set(
    input.actualAwayResultRefs ??
      input.scenario.tools.flatMap((tool) =>
        tool.awayResults.map((result) => result.id),
      ),
  );
  const recordedExperienceId = input.experience?.recorded ? input.experience.id : null;
  const validEvidenceRefs = new Set([
    ...(input.validConversationEvidenceRefs ?? []),
    ...(recordedExperienceId ? [recordedExperienceId] : []),
  ]);
  const invalidRecordRef = input.experience?.resultRefs.some((ref) => !knownResults.has(ref)) ?? false;
  const invalidDecisionRef = input.autonomousDecision.experienceRefs.some(
    (ref) => !validEvidenceRefs.has(ref),
  );
  const fabricatedProvenance = invalidRecordRef || invalidDecisionRef;
  const experienceUsed =
    recordedExperienceId !== null &&
    input.autonomousDecision.experienceRefs.includes(recordedExperienceId) &&
    !invalidDecisionRef;
  const valuableHardToReconstruct =
    !fabricatedProvenance &&
    experienceUsed &&
    input.judge.experienceCausal &&
    !input.judge.baselineCanReconstruct &&
    input.judge.userValue >= 4 &&
    input.judge.impact === "autonomous_better";
  return {
    behaviorDifferent: input.judge.behaviorDifferent,
    experienceUsed,
    fabricatedProvenance,
    valuableHardToReconstruct,
    harmful: input.judge.impact === "baseline_better",
    expectedActionPass: input.scenario.expected.reentryActions.includes(
      input.autonomousDecision.action,
    ),
  };
}

export function selectAutonomousConclusion(
  aggregate: AutonomousAggregate,
  rule: AutonomousExperienceDataset["conclusionRule"],
): AutonomousConclusion {
  if (aggregate.completedRuns === 0) return "A_NO_ADDITIONAL_VALUE";
  const rate = (value: number) => value / aggregate.completedRuns;
  if (
    rate(aggregate.valuableHardToReconstructRuns) >=
      rule.resultCMinimumValuableHardToReconstructRate &&
    aggregate.stableValuableScenarioCount >= rule.resultCMinimumStableScenarioCount &&
    rate(aggregate.fabricatedRuns) <= rule.resultCMaximumFabricationRate &&
    rate(aggregate.harmfulRuns) <= rule.resultCMaximumHarmfulRate
  ) {
    return "C_VALUABLE_HARD_TO_RECONSTRUCT";
  }
  if (
    rate(aggregate.behaviorDifferentRuns) >=
    rule.resultBMinimumBehaviorDifferenceRate
  ) {
    return "B_DIFFERENT_NOT_VALUABLE";
  }
  return "A_NO_ADDITIONAL_VALUE";
}
