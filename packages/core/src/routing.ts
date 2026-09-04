import type {
  ContactIntentStore,
  RequestContactIntentEvaluationResult,
} from "./store.js";
import type {
  ContactIntent,
  ContactIntentEvaluationRequest,
  ConversationEvent,
} from "./types.js";

export type RelevanceEffect = "reevaluate" | "cancel" | "resolve";

export interface RelevanceRoutingInput {
  intents: ContactIntent[];
  events: ConversationEvent[];
  now: string;
}

export interface RelevanceRoutingSelection {
  intentId: string;
  eventIds: string[];
  effect: RelevanceEffect;
  reason: string;
  confidence: number;
}

export interface RelevanceRouter {
  selectRelevant(
    input: RelevanceRoutingInput,
  ): Promise<RelevanceRoutingSelection[]>;
}

export interface RouteConversationEventsInput extends RelevanceRoutingInput {
  router: RelevanceRouter;
}

export interface RoutedContactIntent {
  intent: ContactIntent;
  events: ConversationEvent[];
  selection: RelevanceRoutingSelection;
}

export interface RouteConversationEventsResult {
  routerCalled: boolean;
  activeIntentCount: number;
  eventCount: number;
  selections: RelevanceRoutingSelection[];
  routed: RoutedContactIntent[];
}

export interface RequestRelevantEvaluationsInput {
  store: ContactIntentStore;
  events: ConversationEvent[];
  now: string;
  router: RelevanceRouter;
  routeRunId: string;
  policyVersion: string;
}

export interface RequestRelevantEvaluationItem {
  selection: RelevanceRoutingSelection;
  request: ContactIntentEvaluationRequest;
  persistence: RequestContactIntentEvaluationResult;
}

export interface RequestRelevantEvaluationsResult {
  routing: RouteConversationEventsResult;
  requests: RequestRelevantEvaluationItem[];
}

export class InvalidRelevanceRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRelevanceRouteError";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidRelevanceRouteError(`${label} must be a valid date-time`);
  }
  return parsed;
}

function validateUniqueIds<T extends { id: string }>(
  values: T[],
  label: string,
): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (value.id.trim().length === 0) {
      throw new InvalidRelevanceRouteError(`${label} id must not be empty`);
    }
    if (ids.has(value.id)) {
      throw new InvalidRelevanceRouteError(
        `${label} contains duplicate id ${value.id}`,
      );
    }
    ids.add(value.id);
  }
}

/**
 * Selects active intents affected by new conversation events. The result is
 * validated as untrusted adapter output. Scheduling and reevaluation remain
 * separate operations so a host can persist routed work with its own runtime.
 */
export async function routeConversationEvents(
  input: RouteConversationEventsInput,
): Promise<RouteConversationEventsResult> {
  const nowMs = parseInstant(input.now, "now");
  validateUniqueIds(input.intents, "intents");
  validateUniqueIds(input.events, "events");
  for (const event of input.events) {
    if (parseInstant(event.occurredAt, `event ${event.id} occurredAt`) > nowMs) {
      throw new InvalidRelevanceRouteError(
        `Event ${event.id} cannot occur after routing time`,
      );
    }
  }

  const active = input.intents.filter((intent) => intent.status === "active");
  if (active.length === 0 || input.events.length === 0) {
    return {
      routerCalled: false,
      activeIntentCount: active.length,
      eventCount: input.events.length,
      selections: [],
      routed: [],
    };
  }

  const selections = await input.router.selectRelevant({
    intents: clone(active),
    events: clone(input.events),
    now: input.now,
  });
  if (!Array.isArray(selections)) {
    throw new InvalidRelevanceRouteError("Router result must be an array");
  }

  const intentsById = new Map(active.map((intent) => [intent.id, intent]));
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  const selectedIntentIds = new Set<string>();
  const normalized: RelevanceRoutingSelection[] = [];
  const routed: RoutedContactIntent[] = [];

  for (const selection of selections) {
    const intent = intentsById.get(selection.intentId);
    if (!intent) {
      throw new InvalidRelevanceRouteError(
        `Router selected unknown or inactive intent ${selection.intentId}`,
      );
    }
    if (selectedIntentIds.has(selection.intentId)) {
      throw new InvalidRelevanceRouteError(
        `Router selected intent ${selection.intentId} more than once`,
      );
    }
    if (!Array.isArray(selection.eventIds) || selection.eventIds.length === 0) {
      throw new InvalidRelevanceRouteError(
        `Route for ${selection.intentId} must cite at least one event`,
      );
    }
    if (new Set(selection.eventIds).size !== selection.eventIds.length) {
      throw new InvalidRelevanceRouteError(
        `Route for ${selection.intentId} contains duplicate event ids`,
      );
    }
    const selectedEvents = selection.eventIds.map((eventId) => {
      const event = eventsById.get(eventId);
      if (!event) {
        throw new InvalidRelevanceRouteError(
          `Route for ${selection.intentId} cites unknown event ${eventId}`,
        );
      }
      return event;
    });
    if (!["reevaluate", "cancel", "resolve"].includes(selection.effect)) {
      throw new InvalidRelevanceRouteError(
        `Route for ${selection.intentId} has unsupported effect ${String(selection.effect)}`,
      );
    }
    if (selection.reason.trim().length === 0) {
      throw new InvalidRelevanceRouteError(
        `Route for ${selection.intentId} must explain why it matters`,
      );
    }
    if (
      !Number.isFinite(selection.confidence) ||
      selection.confidence < 0 ||
      selection.confidence > 1
    ) {
      throw new InvalidRelevanceRouteError(
        `Route for ${selection.intentId} confidence must be between 0 and 1`,
      );
    }

    const normalizedSelection = clone(selection);
    selectedIntentIds.add(selection.intentId);
    normalized.push(normalizedSelection);
    routed.push({
      intent: clone(intent),
      events: clone(selectedEvents),
      selection: clone(normalizedSelection),
    });
  }

  return {
    routerCalled: true,
    activeIntentCount: active.length,
    eventCount: input.events.length,
    selections: normalized,
    routed,
  };
}

/**
 * Routes new events against stored active intents and atomically pulls affected
 * evaluation schedules forward. Replaying the same routeRunId is idempotent.
 */
export async function requestRelevantEvaluations(
  input: RequestRelevantEvaluationsInput,
): Promise<RequestRelevantEvaluationsResult> {
  if (input.routeRunId.trim().length === 0) {
    throw new InvalidRelevanceRouteError("routeRunId must not be empty");
  }
  if (input.policyVersion.trim().length === 0) {
    throw new InvalidRelevanceRouteError("policyVersion must not be empty");
  }
  const records = await input.store.listIntents({ statuses: ["active"] });
  const routing = await routeConversationEvents({
    intents: records.map((record) => record.intent),
    events: input.events,
    now: input.now,
    router: input.router,
  });
  const recordsById = new Map(
    records.map((record) => [record.intent.id, record]),
  );
  const requests: RequestRelevantEvaluationItem[] = [];

  for (const routed of routing.routed) {
    const record = recordsById.get(routed.intent.id);
    if (!record) {
      throw new InvalidRelevanceRouteError(
        `Routed intent ${routed.intent.id} disappeared before persistence`,
      );
    }
    const request: ContactIntentEvaluationRequest = {
      id: `evaluation-request:${input.routeRunId}:${record.intent.id}`,
      intentId: record.intent.id,
      requestedAt: input.now,
      eventIds: [...routed.selection.eventIds],
      effect: routed.selection.effect,
      reason: routed.selection.reason,
      confidence: routed.selection.confidence,
      nextEvaluationAt: input.now,
      policyVersion: input.policyVersion,
      metadata: { source: "conversation-event-route" },
    };
    const persistence = await input.store.requestEvaluation({
      intentId: record.intent.id,
      expectedRevision: record.revision,
      request,
      idempotencyKey: `route:${input.routeRunId}:${record.intent.id}`,
    });
    requests.push({
      selection: clone(routed.selection),
      request: clone(persistence.request),
      persistence,
    });
  }

  return { routing, requests };
}
