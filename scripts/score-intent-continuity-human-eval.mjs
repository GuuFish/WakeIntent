import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/u, ""));
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...data] = rows;
  return data.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

const ratingsArg = process.argv.find((value) => value.startsWith("--ratings="));
const keyArg = process.argv.find((value) => value.startsWith("--key="));
if (!ratingsArg || !keyArg) throw new Error("Use --ratings=<completed.csv> --key=<blind-key.json>");
const ratingsPath = resolve(ratingsArg.slice(10));
const keyPath = resolve(keyArg.slice(6));
const ratings = parseCsv(await readFile(ratingsPath, "utf8"));
const keyData = JSON.parse(await readFile(keyPath, "utf8"));
const key = new Map(keyData.key.map((item) => [item.itemId, item]));
const testers = new Set(ratings.map((row) => row.tester_id).filter(Boolean));
if (testers.size < 5) throw new Error(`Need at least 5 unique real testers; found ${testers.size}.`);

const dimensions = [
  ["naturalness", "naturalness"],
  ["remembered", "remembered"],
  ["changedMind", "changed_mind"],
  ["disturbance", "disturbance"],
  ["continuity", "continuity"],
];
const totals = {
  wakeintent: Object.fromEntries(dimensions.map(([name]) => [name, []])),
  baseline: Object.fromEntries(dimensions.map(([name]) => [name, []])),
};
for (const row of ratings) {
  const mapping = key.get(row.item_id);
  if (!mapping) throw new Error(`Unknown item_id ${row.item_id}`);
  for (const side of ["A", "B"]) {
    const arm = mapping[side];
    for (const [name, column] of dimensions) {
      const value = Number(row[`${column}_${side}`]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error(`Invalid 1-5 score for ${row.item_id} ${column}_${side}`);
      }
      totals[arm][name].push(value);
    }
  }
}
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const aggregate = Object.fromEntries(
  Object.entries(totals).map(([arm, values]) => [
    arm,
    Object.fromEntries(Object.entries(values).map(([name, scores]) => [name, mean(scores)])),
  ]),
);
const result = {
  schemaVersion: "1.0.0",
  uniqueTesters: testers.size,
  ratings: ratings.length,
  aggregate,
  differencesWakeMinusBaseline: Object.fromEntries(
    dimensions.map(([name]) => [name, aggregate.wakeintent[name] - aggregate.baseline[name]]),
  ),
  note: "disturbance is lower-is-better; all other dimensions are higher-is-better.",
};
const outputPath = resolve(dirname(ratingsPath), "human-evaluation-results.json");
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(outputPath);
