import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvalDataset } from "./types.js";

const dataset = JSON.parse(
  readFileSync(new URL("../../../evals/development-v0.1.json", import.meta.url), "utf8"),
) as EvalDataset;

describe("development evaluation dataset", () => {
  it("has unique scenario and event ids with valid evaluation times", () => {
    const scenarioIds = dataset.scenarios.map((scenario) => scenario.id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);

    for (const scenario of dataset.scenarios) {
      expect(scenario.timeZone).toMatch(/^[A-Za-z_]+\/[A-Za-z_]+$/);
      expect(Number.isNaN(Date.parse(scenario.evaluationTime))).toBe(false);
      const events = [...scenario.initialEvents, ...scenario.latestEvents];
      const eventIds = events.map((event) => event.id);
      expect(new Set(eventIds).size).toBe(eventIds.length);
      for (const event of events) {
        expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
      }
      for (const requiredRef of scenario.expected.requiredEvidenceRefs) {
        expect(eventIds).toContain(requiredRef);
      }
    }
  });

  it("is explicitly labeled as a non-conclusive development set", () => {
    expect(dataset.kind).toBe("development-fixtures");
    expect(dataset.scenarios.length).toBeGreaterThanOrEqual(8);
  });
});
