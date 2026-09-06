import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultReport =
  "reports/autonomous-experience/2026-09-05T17-43-19.137Z/results.audited.json";
const reportPath = resolve(process.argv[2] ?? defaultReport);
const runKey = process.argv[3] ?? "ae20-proactive-deadline-checkpoint:r2";
const report = JSON.parse(await readFile(reportPath, "utf8"));
const result = report.results.find((item) => item.runKey === runKey);
if (!result) throw new Error("Run not found: " + runKey);

function printEvents(label, events) {
  console.log("\n" + label);
  for (const event of events) {
    console.log("- [" + event.role + "] " + event.content);
  }
}

console.log("Autonomous Experience result replay");
console.log("Run: " + result.runKey);
console.log("Formal conclusion: " + report.aggregate.conclusion);
printEvents("Phase 1", result.context.phase1);
printEvents("Later context", result.context.laterContext);

console.log("\nAway Time");
console.log("- action: " + result.autonomous.away.plan.action);
console.log("- reason: " + result.autonomous.away.plan.reason);
console.log(
  "- actual result: " +
    (result.autonomous.away.toolCall?.results.map((item) => item.content).join(" | ") ??
      "(none)"),
);
console.log(
  "- persisted experience: " +
    (result.autonomous.away.experience?.summary ?? "(none)"),
);

console.log("\nReturn situation");
console.log("- " + (result.context.reentry.content ?? "(proactive checkpoint)"));

console.log("\nBaseline");
console.log("- action: " + result.baseline.reentry.decision.action);
console.log("- message: " + (result.baseline.reentry.decision.message ?? "(silent)"));

console.log("\nAutonomous");
console.log("- action: " + result.autonomous.reentry.decision.action);
console.log("- message: " + (result.autonomous.reentry.decision.message ?? "(silent)"));

console.log("\nBlind comparison");
console.log("- preferred: " + result.judge.result.preferred);
console.log("- autonomous value: " + result.judge.result.autonomousValue + "/5");
console.log("- baseline value: " + result.judge.result.baselineValue + "/5");

console.log("\nCounterfactual audit");
console.log(
  "- baseline can reconstruct: " +
    result.methodAudit.counterfactual.baselineCanNaturallyReconstruct,
);
console.log(
  "- value depends on Away Time: " +
    result.methodAudit.counterfactual.userValueDependsOnAwayTiming,
);
console.log("- rationale: " + result.methodAudit.counterfactual.rationale);

console.log("\nThis run passes the full chain: " + result.score.valuableHardToReconstruct);
console.log(
  "Stability warning: the same scenario passed only 1/3 repetitions, so it is not stable evidence.",
);