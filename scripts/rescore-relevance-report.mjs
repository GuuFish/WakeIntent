import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateRelevanceMetrics,
  scoreRelevancePrediction,
} from "../packages/eval/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = process.argv[2]
  ? resolve(process.argv[2])
  : null;
if (!inputPath) {
  throw new Error("Pass the relevance report path to rescore");
}
const dataset = JSON.parse(
  await readFile(resolve(root, "evals", "relevance-routing-v0.1.json"), "utf8"),
);
const original = JSON.parse(await readFile(inputPath, "utf8"));
const scenarios = new Map(
  dataset.scenarios.map((scenario) => [scenario.id, scenario]),
);
const rows = original.rows.map((row) => {
  const scenario = scenarios.get(row.scenario.id);
  if (!scenario) throw new Error(`Dataset no longer contains ${row.scenario.id}`);
  const prediction = {
    ...row.prediction,
    expectedIntentIds: [...scenario.expectedIntentIds],
  };
  return {
    ...row,
    scenario,
    prediction,
    score: scoreRelevancePrediction(
      scenario.expectedIntentIds,
      prediction.predictedIntentIds,
    ),
  };
});
const metrics = aggregateRelevanceMetrics(rows);
const report = {
  ...original,
  dataset: {
    name: dataset.name,
    version: dataset.version,
    kind: dataset.kind,
  },
  rescoredAt: new Date().toISOString(),
  scoringVersion: "0.1.1",
  revisionNotes: dataset.revisionNotes ?? [],
  metrics,
  rows,
  warning:
    "This rescored report preserves the original model predictions but applies the documented development-label revision. The original report remains unchanged.",
};
const extension = extname(inputPath);
const outputPath = `${inputPath.slice(0, -extension.length)}.rescored${extension}`;
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.table([
  {
    datasetVersion: dataset.version,
    predictions: metrics.total,
    exactAccuracy: metrics.exactMatchAccuracy.toFixed(3),
    precision: metrics.precision.toFixed(3),
    recall: metrics.recall.toFixed(3),
    f1: metrics.f1.toFixed(3),
    tokensReused: metrics.totalTokens,
  },
]);
console.log(`Rescored report: ${outputPath}`);
