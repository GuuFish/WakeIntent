import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runApiEvaluation } from "../packages/eval/dist/index.js";
import { configFromEnv } from "../packages/model-openai-compatible/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const datasetPath = resolve(root, "evals", "development-v0.1.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const requestedIds = (process.env.WAKEINTENT_EVAL_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const rawLimit = process.env.WAKEINTENT_EVAL_LIMIT || "3";
const limit = rawLimit === "all" ? dataset.scenarios.length : Number(rawLimit);
if (!Number.isInteger(limit) || limit <= 0) {
  throw new Error("WAKEINTENT_EVAL_LIMIT must be a positive integer or all");
}

const selected = requestedIds.length
  ? dataset.scenarios.filter((scenario) => requestedIds.includes(scenario.id))
  : dataset.scenarios.slice(0, limit);
if (selected.length === 0) {
  throw new Error("No evaluation scenarios were selected");
}

console.log(
  `Running ${selected.length} development scenarios with two systems. This can make up to ${selected.length * 4} model calls.`,
);
const report = await runApiEvaluation(dataset, selected, configFromEnv());
const safeTimestamp = report.completedAt.replaceAll(":", "-");
const reportPath = resolve(root, "reports", "runs", `${safeTimestamp}.json`);
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.table(
  report.results.map((result) => ({
    system: result.system,
    passed: `${result.metrics.passed}/${result.metrics.total}`,
    passRate: result.metrics.passRate.toFixed(3),
    falseOutreachRate: result.metrics.falseOutreachRate.toFixed(3),
    avgModelCalls: result.metrics.averageModelCalls.toFixed(2),
    avgLatencyMs: result.metrics.averageLatencyMs.toFixed(0),
  })),
);
console.log(`Report: ${reportPath}`);
