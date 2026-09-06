import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  scoreAutonomousRun,
  selectAutonomousConclusion,
} from "../packages/eval/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";
import { renderAutonomousExperienceArtifacts } from "./render-autonomous-experience-results.mjs";

const judgeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    functionallyEquivalent: { type: "boolean" },
    candidate1Value: { type: "integer", minimum: 1, maximum: 5 },
    candidate2Value: { type: "integer", minimum: 1, maximum: 5 },
    preferred: { type: "string", enum: ["candidate1", "candidate2", "tie"] },
    candidate1UnsupportedClaim: { type: "boolean" },
    candidate2UnsupportedClaim: { type: "boolean" },
    rationale: { type: "string", minLength: 1, maxLength: 800 },
  },
  required: [
    "functionallyEquivalent",
    "candidate1Value",
    "candidate2Value",
    "preferred",
    "candidate1UnsupportedClaim",
    "candidate2UnsupportedClaim",
    "rationale",
  ],
};

const counterfactualSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    experienceCausal: { type: "boolean" },
    baselineCanNaturallyReconstruct: { type: "boolean" },
    userValueDependsOnAwayTiming: { type: "boolean" },
    rationale: { type: "string", minLength: 1, maxLength: 1000 },
  },
  required: [
    "experienceCausal",
    "baselineCanNaturallyReconstruct",
    "userValueDependsOnAwayTiming",
    "rationale",
  ],
};

const judgeInstructions =
  "Blindly compare two candidate behaviors for the same user situation. You are not told which system produced either candidate. Score actual user value, relevance, non-interruption, factual support, and whether the behaviors are functionally equivalent despite wording differences. A correct silence can be valuable; behavioral difference alone is not benefit. Mark unsupportedClaim true if the candidate asserts a factual event or tool result absent from the supplied evidence. Ignore evidence that is not cited by the candidate because it is not part of that behavior. Use 1 for harmful or badly distracting, 3 for acceptable, and 5 for clearly useful. Return JSON only.";

const counterfactualInstructions =
  "Perform a strict, falsification-oriented counterfactual audit. Decide whether a strong Memory + Proactive Agent, with the supplied conversation, current context, and one permitted return-time lookup, could naturally produce behavior functionally equivalent to the autonomous behavior without any away-time activity. The fact that the sampled baseline did not do so is not evidence that it could not. Set baselineCanNaturallyReconstruct true when the current context or a permitted return lookup supplies the same useful substance. Set experienceCausal true only when the final autonomous behavior actually relies on the recorded away event. Set userValueDependsOnAwayTiming true only when doing the activity during absence, instead of at return, is necessary for the value. Do not reward anthropomorphic framing or mere difference. Return JSON only.";

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: node --env-file=.env scripts/audit-autonomous-experience.mjs <results.corrected.json>");
}
const sourcePath = resolve(sourceArgument);
const outputPath = resolve(dirname(sourcePath), "results.audited.json");
const dataset = JSON.parse(
  await readFile(resolve("evals", "autonomous-experience-v1.json"), "utf8"),
);
const scenarioById = new Map(dataset.scenarios.map((scenario) => [scenario.id, scenario]));
let report;
try {
  report = JSON.parse(await readFile(outputPath, "utf8"));
} catch {
  report = JSON.parse(await readFile(sourcePath, "utf8"));
  report.methodAudit = {
    version: "1",
    sourceFile: "results.corrected.json",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    agentOutputsRegenerated: false,
    frozenScenariosChanged: false,
    frozenThresholdsChanged: false,
    evidenceFilter:
      "Only evidence cited by the final decision is shown to the corrected blind judge.",
    counterfactual:
      "Potential positives receive a separate falsification-oriented reconstruction audit.",
    attemptedHttpRequests: 0,
    modelCallRecords: [],
  };
}

async function persist() {
  await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function filteredCandidateView(result, experience, awayToolCall) {
  const decision = result.decision;
  const experienceUsed =
    experience?.recorded && decision.experienceRefs.includes(experience.id);
  const citedResultIds = new Set(decision.toolResultRefs);
  if (experienceUsed) {
    for (const ref of experience.resultRefs) citedResultIds.add(ref);
  }
  return {
    behavior: {
      action: decision.action,
      message: decision.message,
      reason: decision.reason,
    },
    supportingEvidence: {
      experience: experienceUsed
        ? {
            id: experience.id,
            summary: experience.summary,
            resultRefs: experience.resultRefs,
            stateChanges: experience.stateChanges,
          }
        : null,
      awayToolResults: (awayToolCall?.results ?? []).filter((item) =>
        citedResultIds.has(item.id),
      ),
      returnToolResults: (result.toolCall?.results ?? []).filter((item) =>
        citedResultIds.has(item.id),
      ),
    },
  };
}

function normalizeBlind(raw, autonomousFirst) {
  const preferred =
    raw.preferred === "tie"
      ? "same"
      : (raw.preferred === "candidate1") === autonomousFirst
        ? "autonomous_better"
        : "baseline_better";
  return {
    raw,
    autonomousFirst,
    functionallyEquivalent: raw.functionallyEquivalent,
    autonomousValue: autonomousFirst ? raw.candidate1Value : raw.candidate2Value,
    baselineValue: autonomousFirst ? raw.candidate2Value : raw.candidate1Value,
    autonomousUnsupportedClaim: autonomousFirst
      ? raw.candidate1UnsupportedClaim
      : raw.candidate2UnsupportedClaim,
    baselineUnsupportedClaim: autonomousFirst
      ? raw.candidate2UnsupportedClaim
      : raw.candidate1UnsupportedClaim,
    preferred,
  };
}

function validProvenance(result, scenario, blind) {
  const experience = result.autonomous.away.experience;
  const knownAway = new Set(
    (result.autonomous.away.toolCall?.results ?? []).map((item) => item.id),
  );
  const validConversation = new Set([
    ...scenario.phase1.map((event) => event.id),
    ...scenario.phase3.map((event) => event.id),
  ]);
  if (experience?.recorded) validConversation.add(experience.id);
  const validTool = new Set([
    ...(result.autonomous.away.toolCall?.results ?? []).map((item) => item.id),
    ...(result.autonomous.reentry.toolCall?.results ?? []).map((item) => item.id),
  ]);
  return !(
    (experience?.resultRefs ?? []).some((ref) => !knownAway.has(ref)) ||
    result.autonomous.reentry.decision.experienceRefs.some(
      (ref) => !validConversation.has(ref),
    ) ||
    result.autonomous.reentry.decision.toolResultRefs.some(
      (ref) => !validTool.has(ref),
    ) ||
    blind.autonomousUnsupportedClaim
  );
}

function createClient(runKey, stage) {
  const config = {
    ...configFromEnv(),
    maxRetries: 1,
    requestIdFactory(identity) {
      return createHash("sha256")
        .update([
          report.runId,
          "method-audit-v1",
          runKey,
          stage,
          identity.schemaName,
          identity.phase ?? "none",
        ].join(":"))
        .digest("hex");
    },
    async beforeRequestAttempt(attempt) {
      const totalAttempts =
        report.requestBudget.attemptedHttpRequests +
        report.methodAudit.attemptedHttpRequests;
      if (totalAttempts >= report.requestBudget.maxHttpAttempts) {
        throw new Error("Formal experiment HTTP attempt budget exhausted during method audit.");
      }
      report.methodAudit.attemptedHttpRequests += 1;
      report.methodAudit.lastAttempt = { runKey, stage, ...attempt, at: new Date().toISOString() };
      await persist();
    },
  };
  return new OpenAICompatibleStructuredClient(config);
}

for (const result of report.results) {
  if (result.error || result.methodAudit?.completed) continue;
  const scenario = scenarioById.get(result.scenarioId);
  if (!scenario) throw new Error("Missing scenario: " + result.scenarioId);
  const autonomousFirst = result.judge.result.autonomousFirst;
  const autonomousCandidate = filteredCandidateView(
    result.autonomous.reentry,
    result.autonomous.away.experience,
    result.autonomous.away.toolCall,
  );
  const baselineCandidate = filteredCandidateView(result.baseline.reentry, null, null);
  const candidate1 = autonomousFirst ? autonomousCandidate : baselineCandidate;
  const candidate2 = autonomousFirst ? baselineCandidate : autonomousCandidate;
  const situation = {
    conversationAndMemory: scenario.phase1,
    laterContext: scenario.phase3,
    reentry: scenario.reentry,
    userState: scenario.userState,
  };

  const blindClient = createClient(result.runKey, "filtered-blind");
  const blindRaw = await blindClient.generate({
    schemaName: "autonomous_experience_filtered_blind_judge",
    schema: judgeSchema,
    instructions: judgeInstructions,
    input: { situation, candidate1, candidate2 },
    phase: "decision",
  });
  const blind = normalizeBlind(blindRaw, autonomousFirst);
  report.methodAudit.modelCallRecords.push(...blindClient.getCallRecords());

  const experience = result.autonomous.away.experience;
  const experienceUsed =
    experience?.recorded &&
    result.autonomous.reentry.decision.experienceRefs.includes(experience.id);
  const potentialPositive =
    experienceUsed &&
    !blind.functionallyEquivalent &&
    blind.autonomousValue >= 4 &&
    blind.preferred === "autonomous_better" &&
    !blind.autonomousUnsupportedClaim;

  let counterfactual = {
    performed: false,
    experienceCausal: false,
    baselineCanNaturallyReconstruct: true,
    userValueDependsOnAwayTiming: false,
    rationale: "Not a potential positive after corrected blind comparison.",
  };
  if (potentialPositive) {
    const counterClient = createClient(result.runKey, "counterfactual");
    const counterRaw = await counterClient.generate({
      schemaName: "autonomous_experience_counterfactual_judge",
      schema: counterfactualSchema,
      instructions: counterfactualInstructions,
      input: {
        situation,
        autonomousAwayExperience: {
          experience,
          actualAwayToolResults: result.autonomous.away.toolCall?.results ?? [],
        },
        autonomousBehavior: autonomousCandidate.behavior,
        observedBaselineBehavior: baselineCandidate.behavior,
        baselineReturnCapabilities: scenario.tools.map((tool) => ({
          queryKey: tool.queryKey,
          description: tool.description,
          obtainableReturnResults: tool.returnResults,
        })),
      },
      phase: "decision",
    });
    counterfactual = { performed: true, ...counterRaw };
    report.methodAudit.modelCallRecords.push(...counterClient.getCallRecords());
  }

  const provenanceOkay = validProvenance(result, scenario, blind);
  const score = scoreAutonomousRun({
    scenario,
    experience,
    autonomousDecision: result.autonomous.reentry.decision,
    judge: {
      behaviorDifferent: !blind.functionallyEquivalent,
      experienceCausal: counterfactual.experienceCausal,
      baselineCanReconstruct: counterfactual.baselineCanNaturallyReconstruct,
      userValue: blind.autonomousValue,
      impact: blind.preferred,
      rationale: blind.raw.rationale,
    },
    actualAwayResultRefs:
      result.autonomous.away.toolCall?.results.map((item) => item.id) ?? [],
    validConversationEvidenceRefs: [
      ...scenario.phase1.map((event) => event.id),
      ...scenario.phase3.map((event) => event.id),
    ],
  });
  if (!provenanceOkay) {
    score.fabricatedProvenance = true;
    score.valuableHardToReconstruct = false;
  }
  if (!counterfactual.userValueDependsOnAwayTiming) {
    score.valuableHardToReconstruct = false;
  }

  result.methodAudit = {
    completed: true,
    filteredBlind: blind,
    counterfactual,
  };
  result.judge.originalResult = result.judge.result;
  result.judge.result = blind;
  result.score = score;
  await persist();
}

const completed = report.results.filter((result) => !result.error && result.methodAudit?.completed);
const valuableByScenario = new Map();
for (const result of completed) {
  if (!result.score.valuableHardToReconstruct) continue;
  valuableByScenario.set(
    result.scenarioId,
    (valuableByScenario.get(result.scenarioId) ?? 0) + 1,
  );
}
const counts = {
  completedRuns: completed.length,
  behaviorDifferentRuns: completed.filter((result) => result.score.behaviorDifferent).length,
  valuableHardToReconstructRuns: completed.filter(
    (result) => result.score.valuableHardToReconstruct,
  ).length,
  fabricatedRuns: completed.filter((result) => result.score.fabricatedProvenance).length,
  harmfulRuns: completed.filter((result) => result.score.harmful).length,
  stableValuableScenarioCount: [...valuableByScenario.values()].filter(
    (count) => count >= dataset.conclusionRule.stableMeansAtLeastRuns,
  ).length,
};
report.aggregate = {
  ...report.aggregate,
  ...counts,
  behaviorDifferenceRate: counts.behaviorDifferentRuns / counts.completedRuns,
  valuableHardToReconstructRate:
    counts.valuableHardToReconstructRuns / counts.completedRuns,
  fabricationRate: counts.fabricatedRuns / counts.completedRuns,
  harmfulRate: counts.harmfulRuns / counts.completedRuns,
  conclusion: selectAutonomousConclusion(counts, dataset.conclusionRule),
};
const auditUsage = report.methodAudit.modelCallRecords.reduce(
  (sum, item) => ({
    calls: sum.calls + 1,
    inputTokens:
      sum.inputTokens === null || item.usage.inputTokens === null
        ? null
        : sum.inputTokens + item.usage.inputTokens,
    outputTokens:
      sum.outputTokens === null || item.usage.outputTokens === null
        ? null
        : sum.outputTokens + item.usage.outputTokens,
    totalTokens:
      sum.totalTokens === null || item.usage.totalTokens === null
        ? null
        : sum.totalTokens + item.usage.totalTokens,
    costUsd:
      sum.costUsd === null || item.costUsd === null
        ? null
        : sum.costUsd + item.costUsd,
  }),
  { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
);
report.methodAudit.status = "completed";
report.methodAudit.completedAt = new Date().toISOString();
report.methodAudit.usage = auditUsage;
report.methodAudit.counterfactualCalls = completed.filter(
  (result) => result.methodAudit.counterfactual.performed,
).length;
report.methodAudit.correctedScoring = {
  behaviorDifferentRuns: report.aggregate.behaviorDifferentRuns,
  valuableHardToReconstructRuns: report.aggregate.valuableHardToReconstructRuns,
  fabricatedRuns: report.aggregate.fabricatedRuns,
  harmfulRuns: report.aggregate.harmfulRuns,
  stableValuableScenarioCount: report.aggregate.stableValuableScenarioCount,
  conclusion: report.aggregate.conclusion,
};
await persist();
await renderAutonomousExperienceArtifacts(outputPath);
console.log(outputPath);
console.log(JSON.stringify(report.methodAudit, null, 2));