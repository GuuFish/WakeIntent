import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scoreAutonomousRun,
  selectAutonomousConclusion,
  validateAutonomousExperienceDataset,
} from "../packages/eval/dist/index.js";
import {
  configFromEnv,
  OpenAICompatibleStructuredClient,
} from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(root, "evals", "autonomous-experience-v1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
validateAutonomousExperienceDataset(dataset);

const execute = process.argv.includes("--execute");
const idsArgument = process.argv.find((value) => value.startsWith("--ids="));
const requestedIds = idsArgument
  ? new Set(idsArgument.slice(6).split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const scenarios = requestedIds
  ? dataset.scenarios.filter((scenario) => requestedIds.has(scenario.id))
  : dataset.scenarios;
if (scenarios.length === 0) throw new Error("No scenario matched --ids.");
const pairsPlanned = scenarios.length * dataset.repetitions;
const logicalRequestUpperBound =
  pairsPlanned * dataset.budgets.maximumLogicalRequestsPerPairedRun;
const httpAttemptUpperBound =
  pairsPlanned * dataset.budgets.maximumHttpAttemptsPerPairedRun;

if (!execute) {
  console.table(scenarios.map((scenario) => ({
    scenario: scenario.id,
    category: scenario.category,
    valueOpportunity: scenario.valueOpportunity,
    tools: scenario.tools.length,
    repetitions: dataset.repetitions,
  })));
  console.log(`Paired runs: ${pairsPlanned}; system return runs: ${pairsPlanned * 2}`);
  console.log(`Maximum logical model requests: ${logicalRequestUpperBound}`);
  console.log(`Maximum HTTP attempts with one controlled retry: ${httpAttemptUpperBound}`);
  console.log("Away budget per paired run: one activity and at most two model calls.");
  console.log("Return budget: each arm may execute one identical frozen lookup.");
  console.log("Dry run only: no .env was loaded and no API request was sent.");
  process.exit(0);
}

const awayPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["do_nothing", "lookup"] },
    queryKey: { anyOf: [{ type: "string" }, { type: "null" }] },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["action", "queryKey", "reason"],
};

const experienceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    recorded: { type: "boolean" },
    resultRefs: { type: "array", items: { type: "string" }, maxItems: 8 },
    stateChanges: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["knowledge", "judgment", "interest", "pending_topic", "pending_share", "completed_small_task"],
          },
          value: { type: "string", minLength: 1, maxLength: 300 },
        },
        required: ["kind", "value"],
      },
    },
    pendingShare: { type: "boolean" },
    summary: { anyOf: [{ type: "string", minLength: 1, maxLength: 500 }, { type: "null" }] },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["recorded", "resultRefs", "stateChanges", "pendingShare", "summary", "reason"],
};

const reentrySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["respond", "respond_with_experience", "contact", "defer", "silent"],
    },
    message: { anyOf: [{ type: "string", minLength: 1, maxLength: 800 }, { type: "null" }] },
    reason: { type: "string", minLength: 1, maxLength: 600 },
    experienceRefs: { type: "array", items: { type: "string" }, maxItems: 4 },
    toolResultRefs: { type: "array", items: { type: "string" }, maxItems: 8 },
    toolQueryKey: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["action", "message", "reason", "experienceRefs", "toolResultRefs", "toolQueryKey"],
};

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

const awayInstructions =
  "You are an assistant during a bounded period while the user is absent. There is no assigned task. You may execute at most one listed lookup, or choose do_nothing. DO_NOTHING is a fully valid and preferred result when there is no concrete likely user benefit, consent is absent, the topic is private, or the available lookups are merely tempting. Respect every user boundary. Do not claim any lookup result because results are hidden until the tool actually executes. Choose only an exact queryKey from the supplied catalog. If action is do_nothing, queryKey must be null. Return JSON only.";

const integrateInstructions =
  "Integrate the result of one actually executed away-time lookup. Record durable experience state only when supported by supplied result IDs. Never invent an event, fact, preference, completed action, or source. resultRefs must contain only supplied IDs. A thought about sharing is not a sent message. If results are empty or useless, set recorded false, use empty arrays, pendingShare false, and summary null. Return JSON only.";

const reentryInstructions =
  "You are a strong Memory + Proactive Agent at the user's return or at an authorized proactive checkpoint. Use the supplied history, current context, user state, and optional verified experience ledger. You may request at most one exact queryKey from the current tool catalog; if a lookup is needed, set toolQueryKey and leave message null. When currentToolResults are supplied, toolQueryKey must be null and you must make the final decision. Do not mention internal experiments, agent arms, ledgers, IDs, or autonomous life. Do not force an old topic into an unrelated or urgent conversation. For a user message, answer it naturally. At a proactive checkpoint, contact only for concrete current value. Cite IDs only in experienceRefs and toolResultRefs; every factual claim must be supported by conversation, verified experience, or current tool results. Return JSON only.";

const judgeInstructions =
  "Blindly compare two candidate behaviors for the same user situation. You are not told which system produced either candidate. Score actual user value, relevance, non-interruption, factual support, and whether the behaviors are functionally equivalent despite wording differences. A correct silence can be valuable; behavioral difference alone is not benefit. Mark unsupportedClaim true if the candidate asserts a factual event or tool result absent from the supplied evidence. Use 1 for harmful or badly distracting, 3 for acceptable, and 5 for clearly useful. Return JSON only.";

function executeFrozenTool(scenario, queryKey, phase, runKey, arm) {
  const tool = scenario.tools.find((item) => item.queryKey === queryKey);
  const call = {
    id: `${runKey}:${arm}:${phase}:tool-1`,
    queryKey,
    phase,
    executedAt: phase === "away" ? scenario.awayAt : scenario.returnAt,
    status: tool ? "executed" : "invalid_query",
    results: tool ? (phase === "away" ? tool.awayResults : tool.returnResults) : [],
  };
  return call;
}

function sumUsage(records) {
  const total = (field) => {
    const values = records.map((record) => record.usage[field]);
    return values.every((value) => typeof value === "number")
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const costs = records.map((record) => record.costUsd);
  return {
    calls: records.length,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    costUsd: costs.every((value) => typeof value === "number")
      ? costs.reduce((sum, value) => sum + value, 0)
      : null,
  };
}

function returnInput(scenario, experienceLedger, currentToolResults, allowTool) {
  return {
    now: scenario.returnAt,
    phase1ConversationAndMemory: scenario.phase1,
    laterContext: scenario.phase3,
    reentry: scenario.reentry,
    userState: scenario.userState,
    experienceLedger,
    toolCatalog: allowTool
      ? scenario.tools.map(({ queryKey, description }) => ({ queryKey, description }))
      : [],
    currentToolResults,
    constraints: {
      maximumToolCalls: allowTool ? 1 : 0,
      doNotFabricate: true,
      doNotDerailCurrentUserNeed: true,
    },
  };
}

async function runAway(client, scenario, runKey) {
  const plan = await client.generate({
    schemaName: "autonomous_experience_away_plan",
    schema: awayPlanSchema,
    instructions: awayInstructions,
    input: {
      now: scenario.awayAt,
      conversationAndMemory: scenario.phase1,
      userState: scenario.userState,
      toolCatalog: scenario.tools.map(({ queryKey, description }) => ({ queryKey, description })),
      budget: { maximumActivities: 1, maximumModelCalls: 2 },
    },
    phase: "decision",
  });
  if (plan.action === "do_nothing") {
    return { plan, toolCall: null, experience: null };
  }
  const toolCall = executeFrozenTool(scenario, plan.queryKey, "away", runKey, "autonomous");
  const integrated = await client.generate({
    schemaName: "autonomous_experience_integrate",
    schema: experienceSchema,
    instructions: integrateInstructions,
    input: {
      now: scenario.awayAt,
      originalConversationAndMemory: scenario.phase1,
      selectedActivity: plan,
      actualToolCall: toolCall,
    },
    phase: "decision",
  });
  const experience = {
    id: `${runKey}:experience-1`,
    ...integrated,
    sourceQueryKey: plan.queryKey,
    createdAt: scenario.awayAt,
  };
  return { plan, toolCall, experience };
}

async function runReturn(client, scenario, experienceLedger, runKey, arm) {
  const first = await client.generate({
    schemaName: "autonomous_experience_reentry",
    schema: reentrySchema,
    instructions: reentryInstructions,
    input: returnInput(scenario, experienceLedger, [], true),
    phase: "decision",
  });
  if (first.toolQueryKey === null) {
    return { initialDecision: first, toolCall: null, decision: first };
  }
  const toolCall = executeFrozenTool(scenario, first.toolQueryKey, "return", runKey, arm);
  const decision = await client.generate({
    schemaName: "autonomous_experience_reentry",
    schema: reentrySchema,
    instructions: reentryInstructions,
    input: returnInput(scenario, experienceLedger, toolCall.results, false),
    phase: "decision",
  });
  if (decision.toolQueryKey !== null) {
    throw new Error(`${arm} requested more than one return tool call`);
  }
  return { initialDecision: first, toolCall, decision };
}

function candidateView(result, experience, awayToolCall) {
  return {
    behavior: {
      action: result.decision.action,
      message: result.decision.message,
      reason: result.decision.reason,
    },
    supportingEvidence: {
      experience: experience?.recorded
        ? {
            id: experience.id,
            summary: experience.summary,
            resultRefs: experience.resultRefs,
            stateChanges: experience.stateChanges,
          }
        : null,
      awayToolResults: awayToolCall?.results ?? [],
      returnToolResults: result.toolCall?.results ?? [],
    },
  };
}

async function blindJudge(
  client,
  scenario,
  baseline,
  autonomous,
  away,
  autonomousFirst,
) {
  const autonomousCandidate = candidateView(
    autonomous,
    away.experience,
    away.toolCall,
  );
  const baselineCandidate = candidateView(baseline, null, null);
  const candidate1 = autonomousFirst ? autonomousCandidate : baselineCandidate;
  const candidate2 = autonomousFirst ? baselineCandidate : autonomousCandidate;
  const situation = {
    conversationAndMemory: scenario.phase1,
    laterContext: scenario.phase3,
    reentry: scenario.reentry,
    userState: scenario.userState,
  };
  const raw = await client.generate({
    schemaName: "autonomous_experience_blind_judge",
    schema: judgeSchema,
    instructions: judgeInstructions,
    input: { situation, candidate1, candidate2 },
    phase: "decision",
  });
  const preferred = raw.preferred === "tie"
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

const baseConfig = { ...configFromEnv(), maxRetries: 1 };
const resumeArgument = process.argv.find((value) => value.startsWith("--resume="));
let startedAt = new Date().toISOString();
let runId = startedAt.replaceAll(":", "-");
let reportDir = resolve(root, "reports", "autonomous-experience", runId);
let reportPath = resolve(reportDir, "results.json");
let attemptedHttpRequests = 0;
let attemptLog = [];
let results = [];

if (resumeArgument) {
  const supplied = resumeArgument.slice("--resume=".length);
  reportPath = isAbsolute(supplied) ? supplied : resolve(root, supplied);
  const previous = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    previous.dataset?.version !== dataset.version ||
    previous.fairness?.model !== baseConfig.model ||
    previous.requestBudget?.maxHttpAttempts !== httpAttemptUpperBound
  ) {
    throw new Error("Resume report does not match this frozen dataset, model, or request budget.");
  }
  startedAt = previous.startedAt;
  runId = previous.runId;
  reportDir = dirname(reportPath);
  attemptedHttpRequests = previous.requestBudget.attemptedHttpRequests ?? 0;
  attemptLog = previous.requestBudget.attemptLog ?? [];
  results = (previous.results ?? []).filter((result) => result.error === null);
}

function aggregate() {
  const completed = results.filter((result) => result.error === null && result.score);
  const positivesByScenario = new Map();
  for (const result of completed) {
    if (result.score.valuableHardToReconstruct) {
      positivesByScenario.set(
        result.scenarioId,
        (positivesByScenario.get(result.scenarioId) ?? 0) + 1,
      );
    }
  }
  const stableValuableScenarioCount = [...positivesByScenario.values()].filter(
    (count) => count >= dataset.conclusionRule.stableMeansAtLeastRuns,
  ).length;
  const summary = {
    completedRuns: completed.length,
    behaviorDifferentRuns: completed.filter((result) => result.score.behaviorDifferent).length,
    valuableHardToReconstructRuns: completed.filter(
      (result) => result.score.valuableHardToReconstruct,
    ).length,
    fabricatedRuns: completed.filter((result) => result.score.fabricatedProvenance).length,
    harmfulRuns: completed.filter((result) => result.score.harmful).length,
    stableValuableScenarioCount,
  };
  const usageFor = (path) => sumUsage(completed.flatMap(path));
  return {
    pairedRunsPlanned: pairsPlanned,
    pairedRunsCompleted: completed.length,
    errors: results.length - completed.length,
    ...summary,
    behaviorDifferenceRate: completed.length
      ? summary.behaviorDifferentRuns / completed.length
      : null,
    valuableHardToReconstructRate: completed.length
      ? summary.valuableHardToReconstructRuns / completed.length
      : null,
    fabricationRate: completed.length ? summary.fabricatedRuns / completed.length : null,
    harmfulRate: completed.length ? summary.harmfulRuns / completed.length : null,
    conclusion: selectAutonomousConclusion(summary, dataset.conclusionRule),
    usage: {
      autonomousAway: usageFor((result) => result.autonomous.awayModelCallRecords),
      autonomousReturn: usageFor((result) => result.autonomous.returnModelCallRecords),
      baselineReturn: usageFor((result) => result.baseline.modelCallRecords),
      blindJudge: usageFor((result) => result.judge.modelCallRecords),
    },
    latencyMs: {
      total: completed.reduce((sum, result) => sum + result.latencyMs, 0),
      mean: completed.length
        ? completed.reduce((sum, result) => sum + result.latencyMs, 0) / completed.length
        : null,
      autonomousAway: completed.reduce(
        (sum, result) => sum + result.stageLatencyMs.autonomousAway,
        0,
      ),
      autonomousReturn: completed.reduce(
        (sum, result) => sum + result.stageLatencyMs.autonomousReturn,
        0,
      ),
      baselineReturn: completed.reduce(
        (sum, result) => sum + result.stageLatencyMs.baselineReturn,
        0,
      ),
      blindJudge: completed.reduce(
        (sum, result) => sum + result.stageLatencyMs.blindJudge,
        0,
      ),
    },
    toolCalls: {
      autonomousAway: completed.filter((result) => result.autonomous.away.toolCall).length,
      autonomousReturn: completed.filter((result) => result.autonomous.reentry.toolCall).length,
      baselineReturn: completed.filter((result) => result.baseline.reentry.toolCall).length,
    },
    storageBytesAdded: completed.reduce(
      (sum, result) => sum + result.autonomous.storageBytesAdded,
      0,
    ),
  };
}

function report(status) {
  return {
    schemaVersion: "1.0.0",
    status,
    runId,
    startedAt,
    completedAt: status === "completed" ? new Date().toISOString() : null,
    dataset: {
      path: "evals/autonomous-experience-v1.json",
      version: dataset.version,
      frozenAt: dataset.frozenAt,
      hypothesis: dataset.hypothesis,
      budgets: dataset.budgets,
      conclusionRule: dataset.conclusionRule,
    },
    fairness: {
      ...dataset.fairness,
      model: baseConfig.model,
      apiMode: baseConfig.apiMode,
      temperature: "omitted for all calls; identical provider default",
      retriesPerLogicalRequest: 1,
      blindJudge: true,
    },
    requestBudget: {
      maxLogicalRequests: logicalRequestUpperBound,
      maxHttpAttempts: httpAttemptUpperBound,
      attemptedHttpRequests,
      remainingHttpAttempts: httpAttemptUpperBound - attemptedHttpRequests,
      attemptLog,
    },
    aggregate: aggregate(),
    results,
    humanEvaluation: {
      status: "not-run",
      note: "No human preference score is inferred from the model judge.",
    },
  };
}

async function persist(status) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report(status), null, 2)}\n`, "utf8");
}

function requestConfig(runKey) {
  let logicalIndex = 0;
  return {
    ...baseConfig,
    requestIdFactory(identity) {
      return createHash("sha256")
        .update([runId, runKey, logicalIndex++, identity.schemaName, identity.phase ?? "none"].join(":"))
        .digest("hex");
    },
    async beforeRequestAttempt(attempt) {
      if (attemptedHttpRequests >= httpAttemptUpperBound) {
        throw new Error(`HTTP attempt budget exhausted: ${attemptedHttpRequests}/${httpAttemptUpperBound}`);
      }
      attemptedHttpRequests += 1;
      attemptLog.push({ runKey, ...attempt, at: new Date().toISOString() });
      await persist("running");
    },
  };
}

await persist("running");
for (let repetition = 1; repetition <= dataset.repetitions; repetition += 1) {
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    const scenario = scenarios[scenarioIndex];
    const runKey = `${scenario.id}:r${repetition}`;
    if (results.some((result) => result.runKey === runKey)) continue;
    const config = requestConfig(runKey);
    const awayClient = new OpenAICompatibleStructuredClient(config);
    const autonomousReturnClient = new OpenAICompatibleStructuredClient(config);
    const baselineClient = new OpenAICompatibleStructuredClient(config);
    const judgeClient = new OpenAICompatibleStructuredClient(config);
    const started = performance.now();
    let awayLatencyMs = 0;
    let autonomousReturnLatencyMs = 0;
    let baselineReturnLatencyMs = 0;
    let judgeLatencyMs = 0;
    let away = null;
    let autonomousReentry = null;
    let baselineReentry = null;
    let judge = null;
    let score = null;
    let error = null;
    try {
      const awayStarted = performance.now();
      away = await runAway(awayClient, scenario, runKey);
      awayLatencyMs = performance.now() - awayStarted;
      const autonomousFirst = (scenarioIndex + repetition) % 2 === 0;
      const runAutonomous = async () => {
        const phaseStarted = performance.now();
        const value = await runReturn(
          autonomousReturnClient,
          scenario,
          away.experience?.recorded ? [away.experience] : [],
          runKey,
          "autonomous",
        );
        autonomousReturnLatencyMs = performance.now() - phaseStarted;
        return value;
      };
      const runBaseline = async () => {
        const phaseStarted = performance.now();
        const value = await runReturn(
          baselineClient,
          scenario,
          [],
          runKey,
          "baseline",
        );
        baselineReturnLatencyMs = performance.now() - phaseStarted;
        return value;
      };

      if (autonomousFirst) {
        autonomousReentry = await runAutonomous();
        baselineReentry = await runBaseline();
      } else {
        baselineReentry = await runBaseline();
        autonomousReentry = await runAutonomous();
      }
      const judgeStarted = performance.now();
      judge = await blindJudge(
        judgeClient,
        scenario,
        baselineReentry,
        autonomousReentry,
        away,
        (scenarioIndex + repetition) % 2 === 1,
      );
      judgeLatencyMs = performance.now() - judgeStarted;
      const baseJudge = {
        behaviorDifferent: !judge.functionallyEquivalent,
        experienceCausal:
          autonomousReentry.decision.experienceRefs.length > 0,
        baselineCanReconstruct: judge.functionallyEquivalent,
        userValue: judge.autonomousValue,
        impact: judge.preferred,
        rationale: judge.raw.rationale,
      };
      score = scoreAutonomousRun({
        scenario,
        experience: away.experience,
        autonomousDecision: autonomousReentry.decision,
        judge: baseJudge,
        actualAwayResultRefs: away.toolCall?.results.map((result) => result.id) ?? [],
        validConversationEvidenceRefs: [
          ...scenario.phase1.map((event) => event.id),
          ...scenario.phase3.map((event) => event.id),
        ],
      });
      const validAutonomousToolRefs = new Set([
        ...(away.toolCall?.results ?? []).map((result) => result.id),
        ...(autonomousReentry.toolCall?.results ?? []).map((result) => result.id),
      ]);
      if (autonomousReentry.decision.toolResultRefs.some(
        (ref) => !validAutonomousToolRefs.has(ref),
      )) {
        score.fabricatedProvenance = true;
        score.valuableHardToReconstruct = false;
      }
      if (judge.autonomousUnsupportedClaim) {
        score.fabricatedProvenance = true;
        score.valuableHardToReconstruct = false;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    results.push({
      runKey,
      scenarioId: scenario.id,
      repetition,
      category: scenario.category,
      valueOpportunity: scenario.valueOpportunity,
      expected: scenario.expected,
      context: {
        phase1: scenario.phase1,
        laterContext: scenario.phase3,
        reentry: scenario.reentry,
        userState: scenario.userState,
      },
      error,
      latencyMs: performance.now() - started,
      stageLatencyMs: {
        autonomousAway: awayLatencyMs,
        autonomousReturn: autonomousReturnLatencyMs,
        baselineReturn: baselineReturnLatencyMs,
        blindJudge: judgeLatencyMs,
      },
      score,
      autonomous: {
        away,
        reentry: autonomousReentry,
        storageBytesAdded: away?.experience
          ? Buffer.byteLength(JSON.stringify(away.experience), "utf8")
          : 0,
        awayUsage: sumUsage(awayClient.getCallRecords()),
        returnUsage: sumUsage(autonomousReturnClient.getCallRecords()),
        awayModelCallRecords: awayClient.getCallRecords(),
        returnModelCallRecords: autonomousReturnClient.getCallRecords(),
      },
      baseline: {
        reentry: baselineReentry,
        usage: sumUsage(baselineClient.getCallRecords()),
        modelCallRecords: baselineClient.getCallRecords(),
      },
      judge: {
        result: judge,
        usage: sumUsage(judgeClient.getCallRecords()),
        modelCallRecords: judgeClient.getCallRecords(),
      },
    });
    await persist(error ? "interrupted" : "running");
    if (error) {
      throw new Error("Run interrupted at " + runKey + ": " + error);
    }
  }
}
await persist("completed");
console.log(`Completed report: ${reportPath}`);
console.log(JSON.stringify(aggregate(), null, 2));

const { renderAutonomousExperienceArtifacts } = await import("./render-autonomous-experience-results.mjs");
await renderAutonomousExperienceArtifacts(reportPath);
