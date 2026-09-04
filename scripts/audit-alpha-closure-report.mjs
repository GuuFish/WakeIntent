import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateAlphaClosureStopRule } from "../packages/eval/dist/index.js";

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: node scripts/audit-alpha-closure-report.mjs <report.json>");
}

const sourcePath = resolve(sourceArgument);
if (sourcePath.endsWith(".audited.json")) {
  throw new Error("Audit the original report, not an already audited report");
}
const report = JSON.parse(await readFile(sourcePath, "utf8"));
const datasetPath = resolve("evals", "alpha-closure-longitudinal-v0.1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const scored = report.scenarios.flatMap((scenario) =>
  scenario.score ? [scenario.score] : [],
);
const recordsFor = (key) =>
  report.scenarios.flatMap((scenario) => scenario[key]?.modelCallRecords ?? []);
const wakeRecords = recordsFor("wakeintent");
const baselineRecords = recordsFor("dueGatedBaseline");
const allRecords = [...wakeRecords, ...baselineRecords];
const sum = (records, selector) =>
  records.reduce((total, record) => total + (selector(record) ?? 0), 0);
const usageFor = (records) => ({
  recordedCalls: records.length,
  inputTokens: sum(records, (record) => record.usage.inputTokens),
  outputTokens: sum(records, (record) => record.usage.outputTokens),
  totalTokens: sum(records, (record) => record.usage.totalTokens),
  costUsd: records.every((record) => typeof record.costUsd === "number")
    ? sum(records, (record) => record.costUsd)
    : null,
});

const auditedAt = new Date().toISOString();
const audited = {
  ...report,
  schemaVersion: "0.2.1-audited",
  originalStopDecision: report.stopDecision,
  stopDecision: evaluateAlphaClosureStopRule(dataset, scored),
  audit: {
    auditedAt,
    sourceReport: sourcePath,
    outcomesRescored: false,
    errorScenarioIds: report.scenarios
      .filter((scenario) => scenario.error !== null)
      .map((scenario) => scenario.scenarioId),
    usage: {
      wakeintent: usageFor(wakeRecords),
      dueGatedBaseline: usageFor(baselineRecords),
      combinedKnown: usageFor(allRecords),
      attemptedHttpRequests: report.requestBudget.attemptedHttpRequests,
      unretainedAttemptRecords:
        report.requestBudget.attemptedHttpRequests - allRecords.length,
    },
    notes: [
      "The original scenario outcomes and failures are unchanged.",
      "The corrected stop decision treats unscored scenarios as REVIEW instead of null.",
      "Known token totals exclude attempts whose call records were discarded by the original runner error path.",
    ],
  },
};
const outputPath = sourcePath.replace(/\.json$/, ".audited.json");
await writeFile(outputPath, `${JSON.stringify(audited, null, 2)}\n`, "utf8");
console.log(`Decision: ${audited.stopDecision.decision}`);
console.log(`Scored: ${audited.stopDecision.scored}/${audited.stopDecision.total}`);
console.log(`Passed: ${audited.stopDecision.passed}/${audited.stopDecision.total}`);
console.log(`Known tokens: ${audited.audit.usage.combinedKnown.totalTokens}`);
console.log(`Audited report: ${outputPath}`);
