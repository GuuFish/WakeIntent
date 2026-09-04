import {
  OpenAICompatibleStructuredClient,
  type ModelCallRecord,
} from "@wakeintent/model-openai-compatible";
import type { EvalAction, EvalPrediction, EvalScenario } from "./types.js";

export const MEMORY_HEARTBEAT_PROMPT_VERSION = "0.1.0";

const memorySchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          dueAt: { type: ["string", "null"] },
        },
        required: ["summary", "evidenceRefs", "dueAt"],
      },
    },
  },
  required: ["memories"],
};

const heartbeatDecisionSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["contact", "defer", "cancel", "expire", "silent", "resolve"],
    },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    nextEvaluationAt: { type: ["string", "null"] },
  },
  required: [
    "action",
    "reason",
    "evidenceRefs",
    "confidence",
    "nextEvaluationAt",
  ],
};

interface BaselineMemory {
  summary: string;
  evidenceRefs: string[];
  dueAt: string | null;
}

interface MemoryResponse {
  memories: BaselineMemory[];
}

interface HeartbeatResponse {
  action: Exclude<EvalAction, "none">;
  reason: string;
  evidenceRefs: string[];
  confidence: number;
  nextEvaluationAt: string | null;
}

export class MemoryHeartbeatBaseline {
  readonly #client: OpenAICompatibleStructuredClient;

  constructor(client: OpenAICompatibleStructuredClient) {
    this.#client = client;
  }

  async run(scenario: EvalScenario): Promise<EvalPrediction> {
    const startedAt = performance.now();
    let modelCalls = 0;
    let memories: BaselineMemory[] = [];
    const recordStart = this.#client.getCallRecords().length;
    const getRecords = (): ModelCallRecord[] =>
      this.#client.getCallRecords().slice(recordStart).map((record) => ({
        ...record,
        usage: { ...record.usage },
      }));
    try {
      modelCalls += 1;
      const memoryResult = await this.#client.generate<MemoryResponse>({
        schemaName: "heartbeat_memories",
        schema: memorySchema,
        instructions:
          "Save only concise memories that could help a future heartbeat decide whether to follow up with the user. This baseline is ordinary memory plus heartbeat, not a lifecycle engine. Each memory may contain a summary, source event IDs, and one due time. Do not add expiry, cancellation, priority, interruption-cost, status, or lifecycle fields. Return no memory for past facts, vague wishes, or small talk without a justified future follow-up.",
        input: {
          now: scenario.initialEvents.at(-1)?.occurredAt ?? scenario.evaluationTime,
          events: scenario.initialEvents,
          target: scenario.target,
          timeZone: scenario.timeZone,
        },
        phase: "extraction",
      });
      memories = memoryResult.memories;

      if (memories.length === 0) {
        return {
          system: "memory-heartbeat",
          scenarioId: scenario.id,
          createdIntentStatus: "none",
          candidateCount: 0,
          action: "none",
          reason: "No future follow-up memory was stored.",
          evidenceRefs: [],
          confidence: 1,
          modelCalls,
          latencyMs: performance.now() - startedAt,
          error: null,
          modelCallRecords: getRecords(),
          artifacts: { memories },
        };
      }

      modelCalls += 1;
      const decision = await this.#client.generate<HeartbeatResponse>({
        schemaName: "heartbeat_decision",
        schema: heartbeatDecisionSchema,
        instructions:
          "At this heartbeat, decide whether the stored future-follow-up memories justify contacting the user now. Use the raw latest conversation, current time, and user policy state. Choose contact only when useful now; otherwise choose defer, cancel, expire, silent, or resolve. Use only supplied event IDs as evidence. Do not assume lifecycle fields that are absent from memory.",
        input: {
          memories,
          initialEvents: scenario.initialEvents,
          latestEvents: scenario.latestEvents,
          now: scenario.evaluationTime,
          userState: scenario.userState,
          target: scenario.target,
          timeZone: scenario.timeZone,
        },
        phase: "decision",
      });

      return {
        system: "memory-heartbeat",
        scenarioId: scenario.id,
        createdIntentStatus: "active",
        candidateCount: memories.length,
        action: decision.action,
        reason: decision.reason,
        evidenceRefs: decision.evidenceRefs,
        confidence: decision.confidence,
        modelCalls,
        latencyMs: performance.now() - startedAt,
        error: null,
        modelCallRecords: getRecords(),
        artifacts: { memories, decision },
      };
    } catch (error) {
      return {
        system: "memory-heartbeat",
        scenarioId: scenario.id,
        createdIntentStatus: "none",
        candidateCount: 0,
        action: "none",
        reason: "Baseline execution failed.",
        evidenceRefs: [],
        confidence: 0,
        modelCalls,
        latencyMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        modelCallRecords: getRecords(),
        artifacts: { memories },
      };
    }
  }
}
