import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error("Usage: node scripts/rescore-longitudinal-report.mjs <report.json>");
}
const absoluteSource = resolve(sourcePath);
const report = JSON.parse(await readFile(absoluteSource, "utf8"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(
  await readFile(
    resolve(root, "evals", "longitudinal-development-v0.1.json"),
    "utf8",
  ),
);
const expectation =
  report.expectation ??
  dataset.scenarios.find((scenario) => scenario.id === report.scenarioId)?.expected;
if (!expectation) throw new Error("Cannot resolve report expectation");
const requiredEvidence = report.wakeintent.routeAudits
  .flatMap((audit) => audit.matches)
  .flatMap((match) => match.eventIds)[0];
const terminalActions = new Set(["resolve", "cancel", "expire"]);
const wakeTerminalTrace = report.wakeintent.result.traces.find(
  (trace) =>
    terminalActions.has(trace.decision.action) &&
    [
      ...trace.decision.evidenceRefs,
      ...trace.decision.counterEvidenceRefs,
    ].includes(requiredEvidence),
);
const baselineTerminalTrace = report.dueGatedBaseline.result.traces.find((trace) =>
  trace.decisions.some((decision) => terminalActions.has(decision.action)),
);
const correctedScore = {
  ...report.score,
  wakeEarlyTerminal:
    Boolean(wakeTerminalTrace) && wakeTerminalTrace.trigger === "context",
  baselineTerminalAction: report.dueGatedBaseline.result.traces
    .flatMap((trace) => trace.decisions)
    .some((decision) =>
      expectation.baselineRequiredTerminalActions.includes(decision.action),
    ),
};
const rescored = {
  ...report,
  originalPassed: report.passed,
  originalScoringVersion: report.scoringVersion ?? "0.1.0",
  scoringVersion: "0.1.2",
  expectation,
  passed: Object.values(correctedScore).every(Boolean),
  score: correctedScore,
  staleStateAvoidedMilliseconds:
    wakeTerminalTrace && baselineTerminalTrace
      ? Math.max(
          0,
          Date.parse(baselineTerminalTrace.at) - Date.parse(wakeTerminalTrace.at),
        )
      : null,
  rescoreNote:
    "Scoring 0.1.2 accepts decisive latest-event evidence from either evidenceRefs or counterEvidenceRefs and resolves the versioned scenario expectation from the dataset.",
};
const outputPath = absoluteSource.replace(/\.json$/u, ".rescored.json");
await writeFile(outputPath, `${JSON.stringify(rescored, null, 2)}\n`, "utf8");
console.log(`Rescored report: ${outputPath}`);
