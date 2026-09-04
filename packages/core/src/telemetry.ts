import type {
  DueEvaluationItemResult,
  EvaluateDueContactIntentsResult,
  EvaluationWorkStats,
} from "./engine.js";
import type { RequestRelevantEvaluationsResult } from "./routing.js";
import type { DecisionAction } from "./types.js";

export interface ModelCallTelemetryRecord {
  schemaName: string;
  phase: string | null;
  reasoningEffort: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  requestId: string;
  attempts: number;
  costUsd: number | null;
}

export interface ModelUsageTotals {
  calls: number;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  usageComplete: boolean;
  costComplete: boolean;
}

export interface EvaluationTraceItem {
  intentId: string;
  previousRevision: number;
  outcome: DueEvaluationItemResult["outcome"];
  source: string | null;
  action: DecisionAction | null;
  decisionId: string | null;
  errorCode: string | null;
  retryAt: string | null;
  retryExhausted: boolean | null;
}

export interface EvaluationRunTrace {
  schemaVersion: "0.1.0";
  traceId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  trigger: "scheduled" | "context-change" | "mixed";
  routing: {
    routerCalled: boolean;
    activeIntentCount: number;
    eventCount: number;
    selections: Array<{
      intentId: string;
      eventIds: string[];
      effect: "reevaluate" | "cancel" | "resolve";
      confidence: number;
      requestId: string | null;
      persistenceOutcome: "requested" | "duplicate" | null;
    }>;
  } | null;
  evaluation: {
    evaluatedAt: string;
    dueCount: number;
    work: EvaluationWorkStats;
    items: EvaluationTraceItem[];
  };
  model: {
    totals: ModelUsageTotals;
    calls: ModelCallTelemetryRecord[];
  };
  metadata?: Record<string, unknown>;
}

export interface BuildEvaluationRunTraceInput {
  traceId: string;
  startedAt: string;
  completedAt: string;
  trigger: EvaluationRunTrace["trigger"];
  evaluation: EvaluateDueContactIntentsResult;
  routing?: RequestRelevantEvaluationsResult;
  modelCalls?: readonly ModelCallTelemetryRecord[];
  metadata?: Record<string, unknown>;
}

export class InvalidTelemetryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTelemetryInputError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidTelemetryInputError(`${label} must be a valid date-time`);
  }
  return parsed;
}

function sumComplete(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null)
    ? values.reduce((total, value) => total + value, 0)
    : null;
}

export function summarizeModelUsage(
  records: readonly ModelCallTelemetryRecord[],
): ModelUsageTotals {
  for (const record of records) {
    if (record.schemaName.trim().length === 0 || record.requestId.trim().length === 0) {
      throw new InvalidTelemetryInputError(
        "Model call schemaName and requestId must not be empty",
      );
    }
    if (!Number.isInteger(record.attempts) || record.attempts <= 0) {
      throw new InvalidTelemetryInputError(
        `Model call ${record.requestId} attempts must be a positive integer`,
      );
    }
    for (const [name, value] of Object.entries(record.usage)) {
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        throw new InvalidTelemetryInputError(
          `Model call ${record.requestId} ${name} must be a non-negative integer or null`,
        );
      }
    }
    if (record.costUsd !== null && (!Number.isFinite(record.costUsd) || record.costUsd < 0)) {
      throw new InvalidTelemetryInputError(
        `Model call ${record.requestId} costUsd must be non-negative or null`,
      );
    }
  }
  const inputTokens = sumComplete(records.map((record) => record.usage.inputTokens));
  const outputTokens = sumComplete(records.map((record) => record.usage.outputTokens));
  const totalTokens = sumComplete(records.map((record) => record.usage.totalTokens));
  const costUsd = sumComplete(records.map((record) => record.costUsd));
  return {
    calls: records.length,
    attempts: records.reduce((total, record) => total + record.attempts, 0),
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    usageComplete:
      inputTokens !== null && outputTokens !== null && totalTokens !== null,
    costComplete: costUsd !== null,
  };
}

function traceItem(item: DueEvaluationItemResult): EvaluationTraceItem {
  if ("decision" in item) {
    return {
      intentId: item.intentId,
      previousRevision: item.previousRevision,
      outcome: item.outcome,
      source: item.source,
      action: item.decision.action,
      decisionId: item.decision.id,
      errorCode: null,
      retryAt: null,
      retryExhausted: null,
    };
  }
  const failure = item.failureRecord?.failure;
  return {
    intentId: item.intentId,
    previousRevision: item.previousRevision,
    outcome: item.outcome,
    source: null,
    action: null,
    decisionId: null,
    errorCode: item.error.name || "Error",
    retryAt: failure?.nextEvaluationAt ?? null,
    retryExhausted: failure?.exhausted ?? null,
  };
}

export function buildEvaluationRunTrace(
  input: BuildEvaluationRunTraceInput,
): EvaluationRunTrace {
  if (input.traceId.trim().length === 0) {
    throw new InvalidTelemetryInputError("traceId must not be empty");
  }
  const startedAtMs = instant(input.startedAt, "startedAt");
  const completedAtMs = instant(input.completedAt, "completedAt");
  if (completedAtMs < startedAtMs) {
    throw new InvalidTelemetryInputError("completedAt cannot predate startedAt");
  }
  const calls = clone([...(input.modelCalls ?? [])]);
  const routing = input.routing
    ? {
        routerCalled: input.routing.routing.routerCalled,
        activeIntentCount: input.routing.routing.activeIntentCount,
        eventCount: input.routing.routing.eventCount,
        selections: input.routing.routing.selections.map((selection) => {
          const persisted = input.routing?.requests.find(
            (item) => item.selection.intentId === selection.intentId,
          );
          return {
            intentId: selection.intentId,
            eventIds: [...selection.eventIds],
            effect: selection.effect,
            confidence: selection.confidence,
            requestId: persisted?.request.id ?? null,
            persistenceOutcome: persisted?.persistence.outcome ?? null,
          };
        }),
      }
    : null;
  const base: EvaluationRunTrace = {
    schemaVersion: "0.1.0",
    traceId: input.traceId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: completedAtMs - startedAtMs,
    trigger: input.trigger,
    routing,
    evaluation: {
      evaluatedAt: input.evaluation.evaluatedAt,
      dueCount: input.evaluation.dueCount,
      work: clone(input.evaluation.work),
      items: input.evaluation.results.map(traceItem),
    },
    model: {
      totals: summarizeModelUsage(calls),
      calls,
    },
  };
  return input.metadata ? { ...base, metadata: clone(input.metadata) } : base;
}
