import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  scoreAutonomousRun,
  selectAutonomousConclusion,
} from "../packages/eval/dist/index.js";
import { renderAutonomousExperienceArtifacts } from "./render-autonomous-experience-results.mjs";

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: node scripts/rescore-autonomous-experience.mjs <results.json>");
}

const sourcePath = resolve(sourceArgument);
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const corrected = structuredClone(source);

for (const result of corrected.results) {
  if (result.error) continue;

  const judgeResult = result.judge.result;
  const experience = result.autonomous.away.experience;
  const recordedExperienceId = experience?.recorded ? experience.id : null;
  const baseJudge = {
    behaviorDifferent: !judgeResult.functionallyEquivalent,
    experienceCausal:
      recordedExperienceId !== null &&
      result.autonomous.reentry.decision.experienceRefs.includes(recordedExperienceId),
    baselineCanReconstruct: judgeResult.functionallyEquivalent,
    userValue: judgeResult.autonomousValue,
    impact: judgeResult.preferred,
    rationale: judgeResult.raw.rationale,
  };

  const score = scoreAutonomousRun({
    scenario: {
      id: result.scenarioId,
      category: result.category,
      valueOpportunity: result.valueOpportunity,
      phase1: result.context.phase1,
      awayAt: result.autonomous.away.toolCall?.executedAt ?? source.startedAt,
      phase3: result.context.laterContext,
      returnAt: source.completedAt,
      reentry: result.context.reentry,
      userState: result.context.userState,
      tools: [],
      expected: result.expected,
    },
    experience,
    autonomousDecision: result.autonomous.reentry.decision,
    judge: baseJudge,
    actualAwayResultRefs:
      result.autonomous.away.toolCall?.results.map((item) => item.id) ?? [],
    validConversationEvidenceRefs: [
      ...result.context.phase1.map((event) => event.id),
      ...result.context.laterContext.map((event) => event.id),
    ],
  });

  const validAutonomousToolRefs = new Set([
    ...(result.autonomous.away.toolCall?.results ?? []).map((item) => item.id),
    ...(result.autonomous.reentry.toolCall?.results ?? []).map((item) => item.id),
  ]);
  if (
    result.autonomous.reentry.decision.toolResultRefs.some(
      (ref) => !validAutonomousToolRefs.has(ref),
    )
  ) {
    score.fabricatedProvenance = true;
    score.valuableHardToReconstruct = false;
  }
  if (judgeResult.autonomousUnsupportedClaim) {
    score.fabricatedProvenance = true;
    score.valuableHardToReconstruct = false;
  }
  result.score = score;
}

const completed = corrected.results.filter((result) => !result.error);
const valuableByScenario = new Map();
for (const result of completed) {
  if (!result.score.valuableHardToReconstruct) continue;
  valuableByScenario.set(
    result.scenarioId,
    (valuableByScenario.get(result.scenarioId) ?? 0) + 1,
  );
}
const stableValuableScenarioCount = [...valuableByScenario.values()].filter(
  (count) => count >= 2,
).length;
const originalScoring = {
  behaviorDifferentRuns: source.aggregate.behaviorDifferentRuns,
  valuableHardToReconstructRuns: source.aggregate.valuableHardToReconstructRuns,
  fabricatedRuns: source.aggregate.fabricatedRuns,
  harmfulRuns: source.aggregate.harmfulRuns,
  stableValuableScenarioCount: source.aggregate.stableValuableScenarioCount,
  conclusion: source.aggregate.conclusion,
};
const correctedCounts = {
  completedRuns: completed.length,
  behaviorDifferentRuns: completed.filter((result) => result.score.behaviorDifferent).length,
  valuableHardToReconstructRuns: completed.filter(
    (result) => result.score.valuableHardToReconstruct,
  ).length,
  fabricatedRuns: completed.filter((result) => result.score.fabricatedProvenance).length,
  harmfulRuns: completed.filter((result) => result.score.harmful).length,
  stableValuableScenarioCount,
};
corrected.aggregate = {
  ...corrected.aggregate,
  ...correctedCounts,
  behaviorDifferenceRate: correctedCounts.completedRuns
    ? correctedCounts.behaviorDifferentRuns / correctedCounts.completedRuns
    : 0,
  valuableHardToReconstructRate: correctedCounts.completedRuns
    ? correctedCounts.valuableHardToReconstructRuns / correctedCounts.completedRuns
    : 0,
  fabricationRate: correctedCounts.completedRuns
    ? correctedCounts.fabricatedRuns / correctedCounts.completedRuns
    : 0,
  harmfulRate: correctedCounts.completedRuns
    ? correctedCounts.harmfulRuns / correctedCounts.completedRuns
    : 0,
};
corrected.aggregate.conclusion = selectAutonomousConclusion(
  correctedCounts,
  corrected.dataset.conclusionRule,
);
corrected.scoringCorrection = {
  version: "1",
  correctedAt: new Date().toISOString(),
  sourceFile: "results.json",
  modelCallsAdded: 0,
  frozenScenariosChanged: false,
  frozenThresholdsChanged: false,
  reason:
    "The original validator treated valid phase1/phase3 conversation IDs in experienceRefs as fabricated provenance. Conversation evidence is now accepted, while experienceUsed still requires the recorded ExperienceRecord ID.",
  originalScoring,
  correctedScoring: {
    behaviorDifferentRuns: corrected.aggregate.behaviorDifferentRuns,
    valuableHardToReconstructRuns:
      corrected.aggregate.valuableHardToReconstructRuns,
    fabricatedRuns: corrected.aggregate.fabricatedRuns,
    harmfulRuns: corrected.aggregate.harmfulRuns,
    stableValuableScenarioCount:
      corrected.aggregate.stableValuableScenarioCount,
    conclusion: corrected.aggregate.conclusion,
  },
};

const outputPath = resolve(dirname(sourcePath), "results.corrected.json");
await writeFile(outputPath, JSON.stringify(corrected, null, 2) + "\n", "utf8");
await renderAutonomousExperienceArtifacts(outputPath);
console.log(outputPath);
console.log(JSON.stringify(corrected.scoringCorrection, null, 2));