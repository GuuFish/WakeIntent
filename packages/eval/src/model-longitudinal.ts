import type {
  ContactPolicyState,
  ContactTarget,
  ConversationEvent,
} from "@wakeintent/core";
import {
  OpenAICompatibleStructuredClient,
  type StructuredRequest,
} from "@wakeintent/model-openai-compatible";
import type {
  BaselineTimelineDecider,
  BaselineTimelineDecision,
  BaselineTimelineMemory,
  RelevanceRouter,
  RelevanceRoutingInput,
  RelevanceRoutingSelection,
} from "./longitudinal.js";

export const RELEVANCE_ROUTER_PROMPT_VERSION = "0.2.0";
export const LONGITUDINAL_BASELINE_PROMPT_VERSION = "0.1.0";

type StructuredClient = Pick<OpenAICompatibleStructuredClient, "generate">;

export type RelevanceMatch = RelevanceRoutingSelection;

export interface RelevanceRouteAudit {
  at: string;
  source: "deterministic" | "model";
  matches: RelevanceMatch[];
}

interface RelevanceResponse {
  matches: RelevanceMatch[];
}

const relevanceInstructions =
  "Route new conversation events to active contact intents whose validity, timing, priority, interruption cost, cancellation, or resolution may have changed. Detect indirect goal supersession, not only explicit reminder cancellation. For each match, use effect cancel only when the user withdrew the follow-up or abandoned the underlying plan, resolve only when the intended outcome is already known or completed, and reevaluate for timing, policy, priority, interruption, mixed, or uncertain changes. Do not select an intent for superficial topic overlap that cannot change a future contact decision. Use only supplied intent IDs and event IDs. Return an empty match list when no intent needs early reevaluation.";

function relevanceSchema(
  intentIds: string[],
  eventIds: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            intentId: { type: "string", enum: intentIds },
            eventIds: {
              type: "array",
              minItems: 1,
              items: { type: "string", enum: eventIds },
            },
            effect: {
              type: "string",
              enum: ["reevaluate", "cancel", "resolve"],
            },
            reason: { type: "string", maxLength: 180 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: [
            "intentId",
            "eventIds",
            "effect",
            "reason",
            "confidence",
          ],
        },
      },
    },
    required: ["matches"],
  };
}

export class ModelRelevanceRouter implements RelevanceRouter {
  readonly #client: StructuredClient;
  readonly #audits: RelevanceRouteAudit[] = [];

  constructor(client: StructuredClient) {
    this.#client = client;
  }

  getAudits(): readonly RelevanceRouteAudit[] {
    return this.#audits.map((audit) => ({
      at: audit.at,
      source: audit.source,
      matches: audit.matches.map((match) => ({
        ...match,
        eventIds: [...match.eventIds],
      })),
    }));
  }

  async selectRelevant(
    input: RelevanceRoutingInput,
  ): Promise<RelevanceRoutingSelection[]> {
    if (input.intents.length === 0 || input.events.length === 0) return [];
    const intentIds = input.intents.map((intent) => intent.id);
    const eventIds = input.events.map((event) => event.id);
    const response = await this.#client.generate<RelevanceResponse>({
      schemaName: "wakeintent_relevance_route",
      schema: relevanceSchema(intentIds, eventIds),
      instructions: relevanceInstructions,
      input: {
        now: input.now,
        intents: input.intents.map((intent) => ({
          id: intent.id,
          subject: intent.subject,
          reason: intent.reason,
          evidence: intent.evidence,
          notBefore: intent.notBefore,
          expiresAt: intent.expiresAt,
          cancellationHints: intent.cancellationHints,
          priority: intent.priority,
          interruptionCost: intent.interruptionCost,
        })),
        events: input.events,
      },
      phase: "extraction",
    } satisfies StructuredRequest);
    const matches = consolidateMatches(response.matches);
    this.#audits.push({
      at: input.now,
      source: "model",
      matches: matches.map((match) => ({
        ...match,
        eventIds: [...match.eventIds],
      })),
    });
    return matches;
  }
}

function consolidateMatches(matches: RelevanceMatch[]): RelevanceMatch[] {
  const consolidated = new Map<string, RelevanceMatch>();
  for (const match of matches) {
    const previous = consolidated.get(match.intentId);
    if (!previous) {
      consolidated.set(match.intentId, {
        ...match,
        eventIds: [...new Set(match.eventIds)],
      });
      continue;
    }
    consolidated.set(match.intentId, {
      intentId: match.intentId,
      eventIds: [...new Set([...previous.eventIds, ...match.eventIds])],
      effect:
        previous.effect === match.effect ? match.effect : "reevaluate",
      reason: `${previous.reason}; ${match.reason}`.slice(0, 180),
      confidence: Math.min(previous.confidence, match.confidence),
    });
  }
  return [...consolidated.values()];
}

const impactCuePattern =
  /(?:不去(?:了)?|不参加(?:了)?|不用(?:再)?|取消(?:了)?|改期(?:了)?|已经完成|完成了|做完了|已经结束|结束了|已送达|送到了|取到了|收到了|暂停(?:了)?|推迟(?:了)?|延期(?:了)?|不要再|别再|no longer|cancel(?:led)?|finished|completed|done|has arrived|arrived|received|stopped|postponed|delayed)/iu;
const cancellationCuePattern =
  /(?:不去(?:了)?|不参加(?:了)?|不用(?:再)?|取消(?:了)?|不要再|别再|no longer|cancel(?:led)?|stopped)/iu;
const resolutionCuePattern =
  /(?:已经完成|完成了|做完了|已经结束|结束了|已送达|送到了|取到了|收到了|finished|completed|done|has arrived|arrived|received)/iu;

function localEffect(events: ConversationEvent[]): RelevanceMatch["effect"] {
  const text = events.map((event) => event.content).join(" ");
  const cancellation = cancellationCuePattern.test(text);
  const resolution = resolutionCuePattern.test(text);
  if (cancellation === resolution) return "reevaluate";
  return cancellation ? "cancel" : "resolve";
}

const latinStopWords = new Set([
  "about",
  "after",
  "already",
  "before",
  "could",
  "follow",
  "future",
  "have",
  "needed",
  "should",
  "their",
  "there",
  "this",
  "user",
  "when",
  "with",
]);

function lexicalFeatures(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const features = new Set<string>();
  for (const segment of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = [...segment];
    for (let index = 0; index < characters.length - 1; index += 1) {
      features.add(`han:${characters[index]}${characters[index + 1]}`);
    }
  }
  for (const word of normalized.match(/[\p{Script=Latin}\p{Number}]+/gu) ?? []) {
    if (word.length >= 4 && !latinStopWords.has(word)) {
      features.add(`latin:${word}`);
    }
  }
  return features;
}

function overlap(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((item) => right.has(item));
}

export class HybridRelevanceRouter implements RelevanceRouter {
  readonly #fallback: ModelRelevanceRouter;
  readonly #audits: RelevanceRouteAudit[] = [];

  constructor(fallback: ModelRelevanceRouter) {
    this.#fallback = fallback;
  }

  getAudits(): readonly RelevanceRouteAudit[] {
    return this.#audits.map((audit) => ({
      at: audit.at,
      source: audit.source,
      matches: audit.matches.map((match) => ({
        ...match,
        eventIds: [...match.eventIds],
      })),
    }));
  }

  async selectRelevant(
    input: RelevanceRoutingInput,
  ): Promise<RelevanceRoutingSelection[]> {
    const impactfulEvents = input.events.filter((event) =>
      impactCuePattern.test(event.content),
    );
    const deterministicMatches: RelevanceMatch[] = [];
    for (const intent of input.intents) {
      const intentText = [
        intent.subject,
        intent.reason,
        ...intent.cancellationHints,
        ...intent.evidence.map((item) => item.quote ?? ""),
      ].join(" ");
      const intentFeatures = lexicalFeatures(intentText);
      const matchedEvents: string[] = [];
      let strongestOverlap: string[] = [];
      for (const event of impactfulEvents) {
        const shared = overlap(intentFeatures, lexicalFeatures(event.content));
        const hanMatches = shared.filter((item) => item.startsWith("han:")).length;
        const latinMatches = shared.filter((item) => item.startsWith("latin:")).length;
        if (hanMatches >= 2 || latinMatches >= 1) {
          matchedEvents.push(event.id);
          if (shared.length > strongestOverlap.length) strongestOverlap = shared;
        }
      }
      if (matchedEvents.length > 0) {
        const matchedEventSet = new Set(matchedEvents);
        deterministicMatches.push({
          intentId: intent.id,
          eventIds: matchedEvents,
          effect: localEffect(
            impactfulEvents.filter((event) => matchedEventSet.has(event.id)),
          ),
          reason: `Impact cue plus topic anchors: ${strongestOverlap
            .slice(0, 4)
            .map((item) => item.replace(/^(?:han|latin):/u, ""))
            .join(", ")}`,
          confidence: 1,
        });
      }
    }
    if (deterministicMatches.length > 0) {
      this.#audits.push({
        at: input.now,
        source: "deterministic",
        matches: deterministicMatches,
      });
      return deterministicMatches;
    }

    const previousAuditCount = this.#fallback.getAudits().length;
    const selected = await this.#fallback.selectRelevant(input);
    const fallbackAudit = this.#fallback.getAudits()[previousAuditCount];
    if (fallbackAudit) {
      this.#audits.push({
        at: fallbackAudit.at,
        source: "model",
        matches: fallbackAudit.matches.map((match) => ({
          ...match,
          eventIds: [...match.eventIds],
        })),
      });
    }
    return selected;
  }
}

interface BaselineMemoryResponse {
  memories: Array<{
    summary: string;
    evidenceRefs: string[];
    dueAt: string;
  }>;
}

interface BaselineDecisionResponse {
  decisions: BaselineTimelineDecision[];
}

const baselineMemorySchema: Record<string, unknown> = {
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
          dueAt: { type: "string" },
        },
        required: ["summary", "evidenceRefs", "dueAt"],
      },
    },
  },
  required: ["memories"],
};

function baselineDecisionSchema(memoryIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      decisions: {
        type: "array",
        minItems: memoryIds.length,
        maxItems: memoryIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            memoryId: { type: "string", enum: memoryIds },
            action: {
              type: "string",
              enum: ["contact", "defer", "cancel", "expire", "silent", "resolve"],
            },
            reason: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
            nextEvaluationAt: { type: ["string", "null"] },
          },
          required: [
            "memoryId",
            "action",
            "reason",
            "evidenceRefs",
            "nextEvaluationAt",
          ],
        },
      },
    },
    required: ["decisions"],
  };
}

export interface BaselineMemoryExtractionInput {
  events: ConversationEvent[];
  target: ContactTarget;
  now: string;
  timeZone: string;
}

export class ModelDueGatedBaselineAdapter implements BaselineTimelineDecider {
  readonly #client: StructuredClient;
  readonly #initialEvents: ConversationEvent[];
  readonly #target: ContactTarget;
  readonly #timeZone: string;

  constructor(
    client: StructuredClient,
    context: {
      initialEvents: ConversationEvent[];
      target: ContactTarget;
      timeZone: string;
    },
  ) {
    this.#client = client;
    this.#initialEvents = context.initialEvents.map((event) => ({ ...event }));
    this.#target = { ...context.target };
    this.#timeZone = context.timeZone;
  }

  async extract(
    input: BaselineMemoryExtractionInput,
  ): Promise<BaselineTimelineMemory[]> {
    const response = await this.#client.generate<BaselineMemoryResponse>({
      schemaName: "longitudinal_baseline_memories",
      schema: baselineMemorySchema,
      instructions:
        "Save concise future-follow-up memories for a strong due-gated heartbeat baseline. Each memory has only a summary, source event IDs, and one due time. Resolve explicit local times using the supplied IANA time zone. Do not add lifecycle status, cancellation rules, expiry, priority, or interruption-cost fields. Return no memory for facts without a justified future follow-up.",
      input,
      phase: "extraction",
    });
    const allowedEventIds = new Set(input.events.map((event) => event.id));
    return response.memories.map((memory, index) => {
      for (const eventId of memory.evidenceRefs) {
        if (!allowedEventIds.has(eventId)) {
          throw new Error(`Baseline memory references unknown event ${eventId}`);
        }
      }
      if (Number.isNaN(Date.parse(memory.dueAt))) {
        throw new Error("Baseline memory dueAt must be a valid instant");
      }
      return {
        id: `baseline-memory-${index + 1}`,
        summary: memory.summary,
        evidenceRefs: [...memory.evidenceRefs],
        dueAt: memory.dueAt,
      };
    });
  }

  async decide(input: {
    memories: BaselineTimelineMemory[];
    latestEvents: ConversationEvent[];
    now: string;
    userState: ContactPolicyState;
  }): Promise<BaselineTimelineDecision[]> {
    const response = await this.#client.generate<BaselineDecisionResponse>({
      schemaName: "longitudinal_baseline_decisions",
      schema: baselineDecisionSchema(input.memories.map((memory) => memory.id)),
      instructions:
        "At this due-gated heartbeat, return exactly one decision for every due memory. Use the initial conversation, accumulated latest events, current time, time zone, and user policy. Contact only if the follow-up is useful now; otherwise defer, cancel, expire, silent, or resolve. Use only supplied event IDs as evidence. This is a strong baseline: detect indirect supersession from the latest raw conversation even though the stored memory has no lifecycle fields.",
      input: {
        ...input,
        initialEvents: this.#initialEvents,
        target: this.#target,
        timeZone: this.#timeZone,
      },
      phase: "decision",
    });
    return response.decisions;
  }
}
