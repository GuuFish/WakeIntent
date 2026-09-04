import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RelevanceEvalDataset } from "./relevance-eval.js";

const dataset = JSON.parse(
  readFileSync(
    new URL("../../../evals/relevance-routing-v0.1.json", import.meta.url),
    "utf8",
  ),
) as RelevanceEvalDataset;

describe("relevance routing development dataset", () => {
  it("uses unique known intent, scenario, and event IDs", () => {
    const intentIds = dataset.intents.map((intent) => intent.id);
    expect(new Set(intentIds).size).toBe(intentIds.length);
    const knownIntentIds = new Set(intentIds);
    const scenarioIds = dataset.scenarios.map((scenario) => scenario.id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);

    for (const scenario of dataset.scenarios) {
      expect(Number.isNaN(Date.parse(scenario.now))).toBe(false);
      const activeIds = scenario.activeIntentIds ?? intentIds;
      for (const intentId of activeIds) expect(knownIntentIds.has(intentId)).toBe(true);
      for (const intentId of scenario.expectedIntentIds) {
        expect(activeIds).toContain(intentId);
      }
      const eventIds = scenario.events.map((event) => event.id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
      for (const event of scenario.events) {
        expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
        expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(Date.parse(scenario.now));
      }
    }
  });

  it("contains both positive and no-match cases across key routing risks", () => {
    expect(dataset.kind).toBe("development-relevance-fixtures");
    expect(dataset.scenarios.length).toBeGreaterThanOrEqual(12);
    expect(dataset.scenarios.some((scenario) => scenario.expectedIntentIds.length === 0)).toBe(true);
    expect(dataset.scenarios.some((scenario) => scenario.expectedIntentIds.length > 1)).toBe(true);
    expect(new Set(dataset.scenarios.map((scenario) => scenario.category)).size).toBeGreaterThanOrEqual(8);
  });
});
