import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePolicyLongitudinalDevelopmentDataset } from "../packages/eval/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(
  root,
  "evals",
  "longitudinal-policy-development-v0.1.json",
);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const results = await evaluatePolicyLongitudinalDevelopmentDataset(dataset);
const completedAt = new Date().toISOString();
const report = {
  schemaVersion: "0.1.0",
  dataset: {
    name: dataset.name,
    version: dataset.version,
    kind: dataset.kind,
    path: "evals/longitudinal-policy-development-v0.1.json",
  },
  completedAt,
  ...results,
  warning:
    "This offline oracle evaluation verifies lifecycle mechanics, accounting, and baseline fairness only. Logical calls are simulated pipeline invocations; token fields are null. It does not measure model extraction quality or establish product value.",
};
const reportPath = resolve(
  root,
  "reports",
  "policy-longitudinal-offline",
  `${completedAt.replaceAll(":", "-")}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.table(
  report.scenarios.flatMap((scenario) => [
    {
      scenario: scenario.scenarioId,
      system: "wakeintent",
      passed: scenario.passed,
      calls: scenario.comparison.wakeintent.logicalModelCalls,
      originalDueWakes: scenario.comparison.wakeintent.originalDueWakeBatches,
      stateLatencyHours:
        scenario.comparison.wakeintent.policyReactionLatencyMs === null
          ? null
          : scenario.comparison.wakeintent.policyReactionLatencyMs / 3_600_000,
      actions: scenario.comparison.wakeintent.finalActions.join(","),
    },
    {
      scenario: scenario.scenarioId,
      system: "due-gated-heartbeat",
      passed: scenario.passed,
      calls: scenario.comparison.dueGatedBaseline.logicalModelCalls,
      originalDueWakes:
        scenario.comparison.dueGatedBaseline.originalDueWakeBatches,
      stateLatencyHours:
        scenario.comparison.dueGatedBaseline.policyReactionLatencyMs === null
          ? null
          : scenario.comparison.dueGatedBaseline.policyReactionLatencyMs / 3_600_000,
      actions: scenario.comparison.dueGatedBaseline.finalActions.join(","),
    },
  ]),
);
console.log(`Report: ${reportPath}`);
