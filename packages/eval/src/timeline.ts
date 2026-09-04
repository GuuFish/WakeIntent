export type TimelineStrategy =
  | "naive-heartbeat"
  | "due-gated-heartbeat"
  | "wakeintent";

export interface TimelineOpportunity {
  id: string;
  createdAt: string;
  dueAt: string;
  invalidatedAt: string | null;
}

export interface TimelineScenario {
  schemaVersion: "0.1.0";
  id: string;
  startAt: string;
  endAt: string;
  heartbeatIntervalMinutes: number;
  opportunities: TimelineOpportunity[];
  contextEventTimes: string[];
}

export interface TimelineDataset {
  schemaVersion: "0.1.0";
  name: string;
  version: string;
  kind: "development-timelines" | "frozen-timelines";
  scenarios: TimelineScenario[];
}

export interface TimelineStrategyMetrics {
  strategy: TimelineStrategy;
  schedulerActivations: number;
  deterministicChecks: number;
  contextRoutingChecks: number;
  extractionModelCalls: number;
  decisionModelCalls: number;
  totalModelCalls: number;
  expectedContacts: number;
  staleIntentMilliseconds: number;
  llmCallsAvoidedVsNaive: number;
}

export interface TimelineScenarioResult {
  scenarioId: string;
  heartbeatTicks: string[];
  results: TimelineStrategyMetrics[];
  caveat: string;
}

const instant = (value: string, label: string): number => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be a valid instant`);
  return parsed;
};

const uniqueInstants = (values: string[]): number[] =>
  [...new Set(values.map((value) => instant(value, "timeline instant")))].sort(
    (left, right) => left - right,
  );

function buildTicks(
  startAt: number,
  endAt: number,
  intervalMilliseconds: number,
): number[] {
  const ticks: number[] = [];
  for (
    let tick = startAt + intervalMilliseconds;
    tick <= endAt;
    tick += intervalMilliseconds
  ) {
    ticks.push(tick);
  }
  return ticks;
}

function firstTickAtOrAfter(ticks: number[], target: number): number | null {
  return ticks.find((tick) => tick >= target) ?? null;
}

function validateScenario(scenario: TimelineScenario): {
  startAt: number;
  endAt: number;
  intervalMilliseconds: number;
} {
  const startAt = instant(scenario.startAt, "startAt");
  const endAt = instant(scenario.endAt, "endAt");
  if (endAt <= startAt) throw new Error("endAt must be later than startAt");
  if (
    !Number.isInteger(scenario.heartbeatIntervalMinutes) ||
    scenario.heartbeatIntervalMinutes <= 0
  ) {
    throw new Error("heartbeatIntervalMinutes must be a positive integer");
  }
  const intervalMilliseconds = scenario.heartbeatIntervalMinutes * 60_000;
  const opportunityIds = scenario.opportunities.map((item) => item.id);
  if (new Set(opportunityIds).size !== opportunityIds.length) {
    throw new Error("Timeline opportunity ids must be unique");
  }
  for (const opportunity of scenario.opportunities) {
    const createdAt = instant(opportunity.createdAt, "createdAt");
    const dueAt = instant(opportunity.dueAt, "dueAt");
    if (createdAt < startAt || createdAt > endAt) {
      throw new Error(`Opportunity ${opportunity.id} is created outside the timeline`);
    }
    if (dueAt < createdAt || dueAt > endAt) {
      throw new Error(`Opportunity ${opportunity.id} has an invalid dueAt`);
    }
    if (opportunity.invalidatedAt !== null) {
      const invalidatedAt = instant(opportunity.invalidatedAt, "invalidatedAt");
      if (invalidatedAt < createdAt || invalidatedAt > endAt) {
        throw new Error(
          `Opportunity ${opportunity.id} has an invalid invalidatedAt`,
        );
      }
    }
  }
  for (const value of scenario.contextEventTimes) {
    const eventAt = instant(value, "contextEventTime");
    if (eventAt < startAt || eventAt > endAt) {
      throw new Error("contextEventTime must be inside the timeline");
    }
  }
  return { startAt, endAt, intervalMilliseconds };
}

export function evaluateTimelineScenario(
  scenario: TimelineScenario,
): TimelineScenarioResult {
  const { startAt, endAt, intervalMilliseconds } = validateScenario(scenario);
  const ticks = buildTicks(startAt, endAt, intervalMilliseconds);
  const extractionTimes = uniqueInstants(
    scenario.opportunities.map((item) => item.createdAt),
  );
  const expectedContacts = scenario.opportunities.filter((item) => {
    if (item.invalidatedAt === null) return true;
    return instant(item.invalidatedAt, "invalidatedAt") > instant(item.dueAt, "dueAt");
  }).length;

  const naiveDecisionCalls = ticks.length;
  const naiveTotalCalls = extractionTimes.length + naiveDecisionCalls;

  const dueEvaluationTicks = new Set<number>();
  let staleIntentMilliseconds = 0;
  for (const opportunity of scenario.opportunities) {
    const dueAt = instant(opportunity.dueAt, "dueAt");
    const dueTick = firstTickAtOrAfter(ticks, dueAt);
    if (dueTick !== null) dueEvaluationTicks.add(dueTick);
    if (opportunity.invalidatedAt !== null) {
      const invalidatedAt = instant(opportunity.invalidatedAt, "invalidatedAt");
      if (invalidatedAt < dueAt) {
        staleIntentMilliseconds += Math.max(0, (dueTick ?? dueAt) - invalidatedAt);
      }
    }
  }
  const gatedTotalCalls = extractionTimes.length + dueEvaluationTicks.size;

  const wakeDecisionTimes = new Set<number>();
  for (const opportunity of scenario.opportunities) {
    const dueAt = instant(opportunity.dueAt, "dueAt");
    const invalidatedAt =
      opportunity.invalidatedAt === null
        ? null
        : instant(opportunity.invalidatedAt, "invalidatedAt");
    wakeDecisionTimes.add(
      invalidatedAt !== null && invalidatedAt < dueAt ? invalidatedAt : dueAt,
    );
  }
  const wakeTotalCalls = extractionTimes.length + wakeDecisionTimes.size;

  const results: TimelineStrategyMetrics[] = [
    {
      strategy: "naive-heartbeat",
      schedulerActivations: ticks.length,
      deterministicChecks: 0,
      contextRoutingChecks: 0,
      extractionModelCalls: extractionTimes.length,
      decisionModelCalls: naiveDecisionCalls,
      totalModelCalls: naiveTotalCalls,
      expectedContacts,
      staleIntentMilliseconds,
      llmCallsAvoidedVsNaive: 0,
    },
    {
      strategy: "due-gated-heartbeat",
      schedulerActivations: ticks.length,
      deterministicChecks: ticks.length,
      contextRoutingChecks: 0,
      extractionModelCalls: extractionTimes.length,
      decisionModelCalls: dueEvaluationTicks.size,
      totalModelCalls: gatedTotalCalls,
      expectedContacts,
      staleIntentMilliseconds,
      llmCallsAvoidedVsNaive: naiveTotalCalls - gatedTotalCalls,
    },
    {
      strategy: "wakeintent",
      schedulerActivations: wakeDecisionTimes.size,
      deterministicChecks: wakeDecisionTimes.size,
      contextRoutingChecks: uniqueInstants(scenario.contextEventTimes).length,
      extractionModelCalls: extractionTimes.length,
      decisionModelCalls: wakeDecisionTimes.size,
      totalModelCalls: wakeTotalCalls,
      expectedContacts,
      staleIntentMilliseconds: 0,
      llmCallsAvoidedVsNaive: naiveTotalCalls - wakeTotalCalls,
    },
  ];

  return {
    scenarioId: scenario.id,
    heartbeatTicks: ticks.map((tick) => new Date(tick).toISOString()),
    results,
    caveat:
      "This deterministic model measures wake mechanics, not model judgment quality. A due-gated heartbeat is intentionally strong; WakeIntent must earn additional value through lifecycle correctness and lower false outreach in model-backed evals.",
  };
}

export function evaluateTimelineDataset(
  dataset: TimelineDataset,
): TimelineScenarioResult[] {
  return dataset.scenarios.map(evaluateTimelineScenario);
}
