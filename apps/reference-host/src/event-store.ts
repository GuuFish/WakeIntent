import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type {
  ContactIntent,
  ConversationEvent,
  RelevanceRoutingSelection,
} from "@wakeintent/core";
import {
  validateContactIntent,
  validateConversationEvent,
} from "@wakeintent/schemas";

export interface ConversationIngestionPlan {
  intents: ContactIntent[];
  selections: RelevanceRoutingSelection[];
}

export interface ConversationEventBatch {
  idempotencyKey: string;
  fingerprint: string;
  conversationId: string;
  eventIds: string[];
  acceptedAt: string;
  status: "pending" | "completed";
  plan: ConversationIngestionPlan | null;
  completedAt: string | null;
}

export interface ConversationEventSnapshot {
  schemaVersion: "0.1.0";
  events: ConversationEvent[];
  batches: ConversationEventBatch[];
}

export interface AppendConversationEventsInput {
  events: ConversationEvent[];
  idempotencyKey: string;
  fingerprint: string;
  acceptedAt: string;
}

export interface AppendConversationEventsResult {
  outcome: "created" | "resume" | "duplicate";
  batch: ConversationEventBatch;
  events: ConversationEvent[];
}

export interface ConversationEventQuery {
  conversationId?: string;
  after?: string;
  atOrBefore?: string;
  limit?: number;
}

export class InvalidConversationEventStoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConversationEventStoreInputError";
  }
}

export class ConversationEventStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationEventStoreConflictError";
  }
}

export class InvalidConversationEventStoreFileError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`Invalid WakeIntent event store ${filePath}: ${message}`);
    this.name = "InvalidConversationEventStoreFileError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConversationEventStorePersistenceError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Could not persist WakeIntent event store ${filePath}`);
    this.name = "ConversationEventStorePersistenceError";
    this.cause = cause;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidConversationEventStoreInputError(`${label} must be a non-empty string`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InvalidConversationEventStoreInputError(`${label} must be a valid date-time`);
  }
}

function validationDetails(
  errors: ReadonlyArray<{ instancePath: string; message?: string }>,
): string {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function validateSelection(
  value: unknown,
  label: string,
): asserts value is RelevanceRoutingSelection {
  if (!isObject(value)) {
    throw new InvalidConversationEventStoreInputError(`${label} must be an object`);
  }
  requireNonEmpty(value.intentId, `${label}.intentId`);
  if (
    !Array.isArray(value.eventIds) ||
    value.eventIds.length === 0 ||
    value.eventIds.some((eventId) => typeof eventId !== "string" || eventId.length === 0)
  ) {
    throw new InvalidConversationEventStoreInputError(
      `${label}.eventIds must contain non-empty strings`,
    );
  }
  if (!["reevaluate", "cancel", "resolve"].includes(String(value.effect))) {
    throw new InvalidConversationEventStoreInputError(`${label}.effect is unsupported`);
  }
  requireNonEmpty(value.reason, `${label}.reason`);
  if (
    typeof value.confidence !== "number" ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new InvalidConversationEventStoreInputError(
      `${label}.confidence must be between 0 and 1`,
    );
  }
}

function validatePlan(value: unknown, label: string): ConversationIngestionPlan {
  if (!isObject(value) || !Array.isArray(value.intents) || !Array.isArray(value.selections)) {
    throw new InvalidConversationEventStoreInputError(`${label} has an invalid shape`);
  }
  for (const [index, intent] of value.intents.entries()) {
    const validation = validateContactIntent(intent);
    if (!validation.valid) {
      throw new InvalidConversationEventStoreInputError(
        `${label}.intents[${index}] is invalid: ${validationDetails(validation.errors)}`,
      );
    }
  }
  for (const [index, selection] of value.selections.entries()) {
    validateSelection(selection, `${label}.selections[${index}]`);
  }
  return clone(value as unknown as ConversationIngestionPlan);
}

function validatePlanForBatch(
  plan: ConversationIngestionPlan,
  batch: Pick<ConversationEventBatch, "eventIds">,
  label: string,
): void {
  const batchEventIds = new Set(batch.eventIds);
  for (const [selectionIndex, selection] of plan.selections.entries()) {
    for (const eventId of selection.eventIds) {
      if (!batchEventIds.has(eventId)) {
        throw new InvalidConversationEventStoreInputError(
          `${label}.selections[${selectionIndex}] references event ${eventId} outside its batch`,
        );
      }
    }
  }
}

function parseSnapshot(value: unknown, filePath: string): ConversationEventSnapshot {
  try {
    if (
      !isObject(value) ||
      value.schemaVersion !== "0.1.0" ||
      !Array.isArray(value.events) ||
      !Array.isArray(value.batches)
    ) {
      throw new InvalidConversationEventStoreInputError(
        "top level must be a 0.1.0 snapshot with events and batches arrays",
      );
    }
    const events = value.events.map((event, index) => {
      const validation = validateConversationEvent(event);
      if (!validation.valid) {
        throw new InvalidConversationEventStoreInputError(
          `events[${index}] is invalid: ${validationDetails(validation.errors)}`,
        );
      }
      return clone(event as ConversationEvent);
    });
    if (new Set(events.map((event) => event.id)).size !== events.length) {
      throw new InvalidConversationEventStoreInputError("events contains duplicate ids");
    }
    const knownEventIds = new Set(events.map((event) => event.id));
    const batches = value.batches.map((raw, index): ConversationEventBatch => {
      if (!isObject(raw) || !Array.isArray(raw.eventIds) || raw.eventIds.length === 0) {
        throw new InvalidConversationEventStoreInputError(`batches[${index}] has an invalid shape`);
      }
      requireNonEmpty(raw.idempotencyKey, `batches[${index}].idempotencyKey`);
      requireNonEmpty(raw.fingerprint, `batches[${index}].fingerprint`);
      requireNonEmpty(raw.conversationId, `batches[${index}].conversationId`);
      requireTimestamp(raw.acceptedAt, `batches[${index}].acceptedAt`);
      if (
        !raw.eventIds.every(
          (eventId) => typeof eventId === "string" && knownEventIds.has(eventId),
        )
      ) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}] references an unknown event`,
        );
      }
      const eventIds = raw.eventIds as string[];
      if (new Set(eventIds).size !== eventIds.length) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}].eventIds contains duplicates`,
        );
      }
      const batchEvents = events.filter((event) => eventIds.includes(event.id));
      if (batchEvents.some((event) => event.conversationId !== raw.conversationId)) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}] references an event from another conversation`,
        );
      }
      if (raw.status !== "pending" && raw.status !== "completed") {
        throw new InvalidConversationEventStoreInputError(`batches[${index}].status is unsupported`);
      }
      const plan = raw.plan === null ? null : validatePlan(raw.plan, `batches[${index}].plan`);
      if (plan !== null) {
        validatePlanForBatch(plan, raw as unknown as ConversationEventBatch, `batches[${index}].plan`);
      }
      if (raw.status === "completed" && plan === null) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}] cannot be completed without a plan`,
        );
      }
      if (raw.completedAt !== null) {
        requireTimestamp(raw.completedAt, `batches[${index}].completedAt`);
      }
      if ((raw.status === "completed") !== (raw.completedAt !== null)) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}] status and completedAt disagree`,
        );
      }
      if (
        typeof raw.completedAt === "string" &&
        Date.parse(raw.completedAt) < Date.parse(raw.acceptedAt as string)
      ) {
        throw new InvalidConversationEventStoreInputError(
          `batches[${index}].completedAt cannot predate acceptedAt`,
        );
      }
      return clone(raw as unknown as ConversationEventBatch);
    });
    if (new Set(batches.map((batch) => batch.idempotencyKey)).size !== batches.length) {
      throw new InvalidConversationEventStoreInputError("batches contains duplicate idempotency keys");
    }
    return { schemaVersion: "0.1.0", events, batches };
  } catch (error) {
    if (error instanceof InvalidConversationEventStoreInputError) {
      throw new InvalidConversationEventStoreFileError(filePath, error.message, error);
    }
    throw error;
  }
}

async function writeSnapshotAtomically(
  filePath: string,
  snapshot: ConversationEventSnapshot,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class JsonConversationEventStore {
  readonly filePath: string;
  #snapshot: ConversationEventSnapshot;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, snapshot: ConversationEventSnapshot) {
    this.filePath = filePath;
    this.#snapshot = snapshot;
  }

  static async open(filePath: string): Promise<JsonConversationEventStore> {
    const absolutePath = resolve(filePath);
    let snapshot: ConversationEventSnapshot = {
      schemaVersion: "0.1.0",
      events: [],
      batches: [],
    };
    try {
      const raw = await readFile(absolutePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new InvalidConversationEventStoreFileError(
          absolutePath,
          "file is not valid JSON",
          error,
        );
      }
      snapshot = parseSnapshot(parsed, absolutePath);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        // Missing storage is initialized on the first accepted event batch.
      } else if (error instanceof InvalidConversationEventStoreFileError) {
        throw error;
      } else {
        throw new InvalidConversationEventStoreFileError(
          absolutePath,
          error instanceof Error ? error.message : "could not read snapshot",
          error,
        );
      }
    }
    return new JsonConversationEventStore(absolutePath, snapshot);
  }

  async appendBatch(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.fingerprint, "fingerprint");
    requireTimestamp(input.acceptedAt, "acceptedAt");
    if (input.events.length === 0) {
      throw new InvalidConversationEventStoreInputError("events must not be empty");
    }
    const conversationId = input.events[0]?.conversationId;
    requireNonEmpty(conversationId, "events[0].conversationId");
    for (const [index, event] of input.events.entries()) {
      const validation = validateConversationEvent(event);
      if (!validation.valid) {
        throw new InvalidConversationEventStoreInputError(
          `events[${index}] is invalid: ${validationDetails(validation.errors)}`,
        );
      }
      if (event.conversationId !== conversationId) {
        throw new InvalidConversationEventStoreInputError(
          "one event batch cannot span multiple conversations",
        );
      }
      if (Date.parse(event.occurredAt) > Date.parse(input.acceptedAt)) {
        throw new InvalidConversationEventStoreInputError(
          `event ${event.id} cannot occur after acceptedAt`,
        );
      }
    }
    if (new Set(input.events.map((event) => event.id)).size !== input.events.length) {
      throw new InvalidConversationEventStoreInputError("events contains duplicate ids");
    }

    return this.#mutate((snapshot) => {
      const prior = snapshot.batches.find(
        (batch) => batch.idempotencyKey === input.idempotencyKey,
      );
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) {
          throw new ConversationEventStoreConflictError(
            `Idempotency key ${input.idempotencyKey} was reused with different input`,
          );
        }
        const eventIds = new Set(prior.eventIds);
        return {
          outcome: prior.status === "completed" ? "duplicate" : "resume",
          batch: clone(prior),
          events: clone(snapshot.events.filter((event) => eventIds.has(event.id))),
        };
      }
      for (const event of input.events) {
        if (snapshot.events.some((existing) => existing.id === event.id)) {
          throw new ConversationEventStoreConflictError(
            `Conversation event ${event.id} already exists under another batch`,
          );
        }
      }
      const batch: ConversationEventBatch = {
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
        conversationId,
        eventIds: input.events.map((event) => event.id),
        acceptedAt: input.acceptedAt,
        status: "pending",
        plan: null,
        completedAt: null,
      };
      snapshot.events.push(...clone(input.events));
      snapshot.batches.push(batch);
      return { outcome: "created", batch: clone(batch), events: clone(input.events) };
    });
  }

  async recordPlan(
    idempotencyKey: string,
    plan: ConversationIngestionPlan,
  ): Promise<ConversationEventBatch> {
    requireNonEmpty(idempotencyKey, "idempotencyKey");
    const validatedPlan = validatePlan(plan, "plan");
    return this.#mutate((snapshot) => {
      const batch = snapshot.batches.find((item) => item.idempotencyKey === idempotencyKey);
      if (!batch) {
        throw new ConversationEventStoreConflictError(`Batch ${idempotencyKey} was not found`);
      }
      validatePlanForBatch(validatedPlan, batch, "plan");
      if (batch.plan !== null) {
        if (JSON.stringify(batch.plan) !== JSON.stringify(validatedPlan)) {
          throw new ConversationEventStoreConflictError(
            `Batch ${idempotencyKey} already has a different processing plan`,
          );
        }
        return clone(batch);
      }
      batch.plan = clone(validatedPlan);
      return clone(batch);
    });
  }

  async completeBatch(
    idempotencyKey: string,
    completedAt: string,
  ): Promise<ConversationEventBatch> {
    requireNonEmpty(idempotencyKey, "idempotencyKey");
    requireTimestamp(completedAt, "completedAt");
    return this.#mutate((snapshot) => {
      const batch = snapshot.batches.find((item) => item.idempotencyKey === idempotencyKey);
      if (!batch) {
        throw new ConversationEventStoreConflictError(`Batch ${idempotencyKey} was not found`);
      }
      if (batch.plan === null) {
        throw new ConversationEventStoreConflictError(
          `Batch ${idempotencyKey} cannot complete before its processing plan is saved`,
        );
      }
      if (batch.status === "completed") {
        return clone(batch);
      }
      if (Date.parse(completedAt) < Date.parse(batch.acceptedAt)) {
        throw new InvalidConversationEventStoreInputError(
          "completedAt cannot predate acceptedAt",
        );
      }
      batch.status = "completed";
      batch.completedAt = completedAt;
      return clone(batch);
    });
  }

  async getBatch(idempotencyKey: string): Promise<ConversationEventBatch | null> {
    requireNonEmpty(idempotencyKey, "idempotencyKey");
    await this.#mutationTail;
    const batch = this.#snapshot.batches.find(
      (item) => item.idempotencyKey === idempotencyKey,
    );
    return batch ? clone(batch) : null;
  }

  async listEvents(query: ConversationEventQuery = {}): Promise<ConversationEvent[]> {
    await this.#mutationTail;
    if (query.after !== undefined) requireTimestamp(query.after, "after");
    if (query.atOrBefore !== undefined) {
      requireTimestamp(query.atOrBefore, "atOrBefore");
    }
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
      throw new InvalidConversationEventStoreInputError("limit must be a positive integer");
    }
    const after = query.after === undefined ? null : Date.parse(query.after);
    const atOrBefore =
      query.atOrBefore === undefined ? null : Date.parse(query.atOrBefore);
    const events = this.#snapshot.events
      .filter((event) => {
        if (query.conversationId !== undefined && event.conversationId !== query.conversationId) {
          return false;
        }
        const occurredAt = Date.parse(event.occurredAt);
        return (
          (after === null || occurredAt > after) &&
          (atOrBefore === null || occurredAt <= atOrBefore)
        );
      })
      .sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.id.localeCompare(right.id),
      );
    return clone(query.limit === undefined ? events : events.slice(-query.limit));
  }

  async #mutate<T>(operation: (snapshot: ConversationEventSnapshot) => T): Promise<T> {
    const pending = this.#mutationTail.then(async () => {
      const staged = clone(this.#snapshot);
      const result = operation(staged);
      try {
        await writeSnapshotAtomically(this.filePath, staged);
      } catch (error) {
        throw new ConversationEventStorePersistenceError(this.filePath, error);
      }
      this.#snapshot = staged;
      return result;
    });
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
