import type { Clock } from "./clock.js";
import type { ContactPolicyState } from "./hard-gates.js";
import type {
  ClearDoNotDisturbSignal,
  ContactPolicySignal,
  SetAuthorizationSignal,
  SetDoNotDisturbSignal,
} from "./policy-signals.js";
import type { ConversationEvent } from "./types.js";
import type { IdGenerator } from "./use-cases.js";

interface PolicySignalDraftBase {
  evidenceRef: string;
  reason: string;
}

export interface SetDoNotDisturbDraft extends PolicySignalDraftBase {
  kind: "set-do-not-disturb";
  doNotDisturbUntil: string;
}

export interface ClearDoNotDisturbDraft extends PolicySignalDraftBase {
  kind: "clear-do-not-disturb";
}

export interface SetAuthorizationDraft extends PolicySignalDraftBase {
  kind: "set-authorization";
  authorization: SetAuthorizationSignal["authorization"];
}

export type ContactPolicySignalDraft =
  | SetDoNotDisturbDraft
  | ClearDoNotDisturbDraft
  | SetAuthorizationDraft;

export interface PolicySignalGenerationInput {
  events: ConversationEvent[];
  now: string;
  timeZone?: string;
  currentPolicy?: ContactPolicyState;
}

export interface PolicySignalGenerator {
  generatePolicySignals(
    input: PolicySignalGenerationInput,
  ): Promise<ContactPolicySignalDraft[]>;
}

export interface ExtractContactPolicySignalsInput {
  events: ConversationEvent[];
  clock: Clock;
  idGenerator: IdGenerator;
  generator: PolicySignalGenerator;
  timeZone?: string;
  currentPolicy?: ContactPolicyState;
}

export class InvalidPolicySignalExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicySignalExtractionError";
  }
}

function parseInstant(value: string, label: string): number {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new InvalidPolicySignalExtractionError(
      `${label} must be a valid date-time`,
    );
  }
  return instant;
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidPolicySignalExtractionError(`${label} is required`);
  }
}

function draftKey(draft: ContactPolicySignalDraft): string {
  if (draft.kind === "set-do-not-disturb") {
    return `${draft.kind}:${draft.evidenceRef}:${draft.doNotDisturbUntil}`;
  }
  if (draft.kind === "set-authorization") {
    return `${draft.kind}:${draft.evidenceRef}:${draft.authorization}`;
  }
  return `${draft.kind}:${draft.evidenceRef}`;
}

export async function extractContactPolicySignals(
  input: ExtractContactPolicySignalsInput,
): Promise<ContactPolicySignal[]> {
  const now = input.clock.now();
  if (Number.isNaN(now.getTime())) {
    throw new InvalidPolicySignalExtractionError("clock returned an invalid date");
  }
  const eventsById = new Map<string, ConversationEvent>();
  for (const event of input.events) {
    if (eventsById.has(event.id)) {
      throw new InvalidPolicySignalExtractionError(
        "Conversation event ids must be unique",
      );
    }
    parseInstant(event.occurredAt, `event ${event.id} occurredAt`);
    eventsById.set(event.id, event);
  }

  const drafts = await input.generator.generatePolicySignals({
    events: input.events,
    now: now.toISOString(),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    ...(input.currentPolicy
      ? { currentPolicy: { ...input.currentPolicy } }
      : {}),
  });
  const seenDrafts = new Set<string>();
  const signals: ContactPolicySignal[] = [];

  for (const draft of drafts) {
    requireText(draft.evidenceRef, "draft.evidenceRef");
    requireText(draft.reason, "draft.reason");
    const event = eventsById.get(draft.evidenceRef);
    if (!event) {
      throw new InvalidPolicySignalExtractionError(
        `Policy signal references unknown event ${draft.evidenceRef}`,
      );
    }
    if (event.actor !== "user") {
      throw new InvalidPolicySignalExtractionError(
        `Policy signal evidence ${event.id} must be user-authored`,
      );
    }
    const key = draftKey(draft);
    if (seenDrafts.has(key)) continue;
    seenDrafts.add(key);

    const base = {
      schemaVersion: "0.1.0" as const,
      id: input.idGenerator("policy-signal"),
      evidenceRef: event.id,
      occurredAt: event.occurredAt,
      reason: draft.reason,
    };
    if (draft.kind === "set-do-not-disturb") {
      const until = parseInstant(
        draft.doNotDisturbUntil,
        "draft.doNotDisturbUntil",
      );
      if (until <= Date.parse(event.occurredAt)) {
        throw new InvalidPolicySignalExtractionError(
          "doNotDisturbUntil must be later than its evidence event",
        );
      }
      const signal: SetDoNotDisturbSignal = {
        ...base,
        kind: draft.kind,
        doNotDisturbUntil: draft.doNotDisturbUntil,
      };
      signals.push(signal);
    } else if (draft.kind === "clear-do-not-disturb") {
      const signal: ClearDoNotDisturbSignal = {
        ...base,
        kind: draft.kind,
      };
      signals.push(signal);
    } else {
      const signal: SetAuthorizationSignal = {
        ...base,
        kind: draft.kind,
        authorization: draft.authorization,
      };
      signals.push(signal);
    }
  }

  return signals;
}
