import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  evaluateTimelineDataset,
  evaluateTimelineScenario,
  type TimelineDataset,
  type TimelineScenario,
} from "./timeline.js";

const scenario = (
  overrides: Partial<TimelineScenario> = {},
): TimelineScenario => ({
  schemaVersion: "0.1.0",
  id: "timeline",
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-09-08T00:00:00.000Z",
  heartbeatIntervalMinutes: 1440,
  opportunities: [],
  contextEventTimes: [],
  ...overrides,
});

describe("evaluateTimelineScenario", () => {
  it("shows that a strong due-gated baseline already removes empty LLM wakes", () => {
    const result = evaluateTimelineScenario(scenario());
    expect(result.results).toEqual([
      expect.objectContaining({
        strategy: "naive-heartbeat",
        totalModelCalls: 7,
      }),
      expect.objectContaining({
        strategy: "due-gated-heartbeat",
        totalModelCalls: 0,
        deterministicChecks: 7,
      }),
      expect.objectContaining({
        strategy: "wakeintent",
        totalModelCalls: 0,
        schedulerActivations: 0,
      }),
    ]);
  });

  it("batches opportunities sharing one creation and due time", () => {
    const result = evaluateTimelineScenario(
      scenario({
        opportunities: [
          {
            id: "a",
            createdAt: "2026-09-01T01:00:00.000Z",
            dueAt: "2026-09-04T00:00:00.000Z",
            invalidatedAt: null,
          },
          {
            id: "b",
            createdAt: "2026-09-01T01:00:00.000Z",
            dueAt: "2026-09-04T00:00:00.000Z",
            invalidatedAt: null,
          },
        ],
      }),
    );
    const gated = result.results.find(
      (item) => item.strategy === "due-gated-heartbeat",
    );
    const wake = result.results.find((item) => item.strategy === "wakeintent");
    expect(gated).toMatchObject({ extractionModelCalls: 1, decisionModelCalls: 1 });
    expect(wake).toMatchObject({ extractionModelCalls: 1, decisionModelCalls: 1 });
  });

  it("makes early invalidation visible without pretending it saves an LLM call", () => {
    const result = evaluateTimelineScenario(
      scenario({
        opportunities: [
          {
            id: "job-fair",
            createdAt: "2026-09-01T01:00:00.000Z",
            dueAt: "2026-09-07T00:00:00.000Z",
            invalidatedAt: "2026-09-03T12:00:00.000Z",
          },
        ],
        contextEventTimes: ["2026-09-03T12:00:00.000Z"],
      }),
    );
    const gated = result.results.find(
      (item) => item.strategy === "due-gated-heartbeat",
    );
    const wake = result.results.find((item) => item.strategy === "wakeintent");
    expect(gated).toMatchObject({
      totalModelCalls: 2,
      staleIntentMilliseconds: 302_400_000,
    });
    expect(wake).toMatchObject({
      totalModelCalls: 2,
      staleIntentMilliseconds: 0,
      contextRoutingChecks: 1,
    });
  });

  it("rejects malformed timeline boundaries", () => {
    expect(() =>
      evaluateTimelineScenario(
        scenario({ endAt: "2026-08-31T00:00:00.000Z" }),
      ),
    ).toThrow("endAt must be later than startAt");
  });
});

describe("longitudinal wake fixtures", () => {
  it("loads and evaluates every checked-in timeline", () => {
    const dataset = JSON.parse(
      readFileSync(
        new URL("../../../evals/timelines-v0.1.json", import.meta.url),
        "utf8",
      ),
    ) as TimelineDataset;
    const results = evaluateTimelineDataset(dataset);
    expect(dataset.kind).toBe("development-timelines");
    expect(results).toHaveLength(dataset.scenarios.length);
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
});
