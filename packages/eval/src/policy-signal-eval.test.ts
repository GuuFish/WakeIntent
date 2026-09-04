import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ContactPolicySignal } from "@wakeintent/core";
import {
  aggregatePolicySignalScores,
  scorePolicySignalScenario,
  type PolicySignalEvalScenario,
} from "./policy-signal-eval.js";

const scenario: PolicySignalEvalScenario = {
  id: "quiet",
  split: "development",
  category: "finite-do-not-disturb",
  now: "2026-09-02T10:00:00.000Z",
  timeZone: "Asia/Hong_Kong",
  events: [],
  expected: [
    {
      kind: "set-do-not-disturb",
      evidenceRef: "event-1",
      doNotDisturbUntil: "2026-09-02T14:00:00.000Z",
    },
  ],
};

describe("policy signal extraction evaluation", () => {
  it("normalizes equivalent time offsets and scores exact matches", () => {
    const actual: ContactPolicySignal[] = [
      {
        schemaVersion: "0.1.0",
        id: "signal-1",
        kind: "set-do-not-disturb",
        evidenceRef: "event-1",
        occurredAt: "2026-09-02T10:00:00.000Z",
        reason: "Explicit quiet window.",
        doNotDisturbUntil: "2026-09-02T22:00:00.000+08:00",
      },
    ];
    const score = scorePolicySignalScenario({ scenario, actual });
    expect(score).toMatchObject({
      passed: true,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });
  });

  it("keeps false positives and model errors visible in aggregate metrics", () => {
    const negative: PolicySignalEvalScenario = {
      ...scenario,
      id: "negative",
      expected: [],
    };
    const falsePositive = scorePolicySignalScenario({
      scenario: negative,
      actual: [
        {
          schemaVersion: "0.1.0",
          id: "signal-1",
          kind: "set-authorization",
          evidenceRef: "event-1",
          occurredAt: "2026-09-02T10:00:00.000Z",
          reason: "Incorrect inference.",
          authorization: "denied",
        },
      ],
    });
    const error = scorePolicySignalScenario({
      scenario,
      actual: [],
      error: "request failed",
    });
    expect(aggregatePolicySignalScores([falsePositive, error])).toMatchObject({
      scenarios: 2,
      passed: 0,
      falsePositives: 1,
      falseNegatives: 1,
      errors: 1,
    });
  });

  it("loads a frozen balanced dataset with unique evidence ids", () => {
    const dataset = JSON.parse(
      readFileSync(
        new URL(
          "../../../evals/policy-signal-extraction-v0.1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { version: string; scenarios: PolicySignalEvalScenario[] };
    expect(dataset.version).toBe("0.1.0");
    expect(dataset.scenarios.length).toBeGreaterThanOrEqual(20);
    expect(
      dataset.scenarios.filter((item) => item.expected.length > 0).length,
    ).toBeGreaterThanOrEqual(8);
    expect(
      dataset.scenarios.filter((item) => item.expected.length === 0).length,
    ).toBeGreaterThanOrEqual(8);
    expect(new Set(dataset.scenarios.map((item) => item.id)).size).toBe(
      dataset.scenarios.length,
    );
    for (const item of dataset.scenarios) {
      expect(["development", "holdout"]).toContain(item.split);
      expect(Number.isNaN(Date.parse(item.now))).toBe(false);
      expect(item.events.length).toBeGreaterThan(0);
      expect(new Set(item.events.map((event) => event.id)).size).toBe(
        item.events.length,
      );
    }
  });

  it("keeps the state-aware adjudication manifest separate from the original freeze", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          "../../../evals/policy-signal-extraction-v0.2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      version: string;
      extends: string;
      baseScenarioSplit: string;
      overrides: Array<{ id: string }>;
      additions: PolicySignalEvalScenario[];
    };
    expect(manifest).toMatchObject({
      version: "0.2.0",
      extends: "policy-signal-extraction-v0.1.json",
      baseScenarioSplit: "regression",
    });
    expect(manifest.overrides.map((item) => item.id)).toEqual([
      "restore-proactive-permission",
      "clear-quiet-window",
      "restore-and-clear",
    ]);
    expect(manifest.additions).toHaveLength(8);
    expect(manifest.additions.every((item) => item.split === "holdout")).toBe(
      true,
    );
  });
});
