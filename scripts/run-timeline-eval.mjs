import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateTimelineDataset } from "../packages/eval/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(root, "evals", "timelines-v0.1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const results = evaluateTimelineDataset(dataset);
const completedAt = new Date().toISOString();
const report = {
  schemaVersion: "0.1.0",
  dataset: {
    name: dataset.name,
    version: dataset.version,
    kind: dataset.kind,
  },
  completedAt,
  results,
  warning:
    "This is a deterministic wake-mechanics model, not evidence of semantic model quality.",
};
const reportPath = resolve(
  root,
  "reports",
  "timelines",
  `${completedAt.replaceAll(":", "-")}.json`,
);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.table(
  results.flatMap((scenario) =>
    scenario.results.map((result) => ({
      scenario: scenario.scenarioId,
      strategy: result.strategy,
      scheduler: result.schedulerActivations,
      deterministic: result.deterministicChecks,
      routing: result.contextRoutingChecks,
      llmCalls: result.totalModelCalls,
      staleHours: (result.staleIntentMilliseconds / 3_600_000).toFixed(1),
      avoidedVsNaive: result.llmCallsAvoidedVsNaive,
    })),
  ),
);
console.log(`Report: ${reportPath}`);
