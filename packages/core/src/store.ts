import { activateIntent as applyActivation, applyDecision } from "./lifecycle.js";
import type {
  ContactDecision,
  ContactIntent,
  ContactIntentActivation,
  ContactIntentAuditEvent,
  ContactIntentEvaluationFailure,
  ContactIntentEvaluationRequest,
  ContactTarget,
  IntentStatus,
} from "./types.js";

export interface StoredContactIntent {
  intent: ContactIntent;
  revision: number;
  nextEvaluationAt: string | null;
}

export interface CreateContactIntentInput {
  intent: ContactIntent;
  nextEvaluationAt: string | null;
  idempotencyKey: string;
}

export interface ActivateContactIntentInput {
  intentId: string;
  expectedRevision: number;
  activation: ContactIntentActivation;
  idempotencyKey: string;
}

export interface CommitContactDecisionInput {
  intentId: string;
  expectedRevision: number;
  decision: ContactDecision;
  idempotencyKey: string;
}

export interface RecordEvaluationFailureInput {
  intentId: string;
  expectedRevision: number;
  failure: ContactIntentEvaluationFailure;
  idempotencyKey: string;
}

export interface RequestContactIntentEvaluationInput {
  intentId: string;
  expectedRevision: number;
  request: ContactIntentEvaluationRequest;
  idempotencyKey: string;
}

export interface ContactIntentQuery {
  statuses?: IntentStatus[];
  target?: ContactTarget;
  dueAtOrBefore?: string;
  scheduledOnly?: boolean;
  limit?: number;
}

export interface CreateContactIntentResult {
  outcome: "created" | "duplicate";
  record: StoredContactIntent;
}

export interface ActivateContactIntentResult {
  outcome: "activated" | "duplicate";
  record: StoredContactIntent;
  activation: ContactIntentActivation;
}

export interface CommitContactDecisionResult {
  outcome: "committed" | "duplicate";
  record: StoredContactIntent;
  decision: ContactDecision;
}

export interface RecordEvaluationFailureResult {
  outcome: "recorded" | "duplicate";
  record: StoredContactIntent;
  failure: ContactIntentEvaluationFailure;
}

export interface RequestContactIntentEvaluationResult {
  outcome: "requested" | "duplicate";
  record: StoredContactIntent;
  request: ContactIntentEvaluationRequest;
}

export interface StoreIdempotencyEntry {
  scope:
    | "create-intent"
    | "activate-intent"
    | "commit-decision"
    | "record-failure"
    | "request-evaluation";
  key: string;
  fingerprint: string;
  intentId: string;
  operationId: string | null;
}

export interface ContactIntentStoreSnapshot {
  schemaVersion: "0.1.3";
  records: StoredContactIntent[];
  events: ContactIntentAuditEvent[];
  idempotency: StoreIdempotencyEntry[];
}

export interface ContactIntentStore {
  createIntent(
    input: CreateContactIntentInput,
  ): Promise<CreateContactIntentResult>;
  activateIntent(
    input: ActivateContactIntentInput,
  ): Promise<ActivateContactIntentResult>;
  getIntent(intentId: string): Promise<StoredContactIntent | null>;
  listIntents(query?: ContactIntentQuery): Promise<StoredContactIntent[]>;
  commitDecision(
    input: CommitContactDecisionInput,
  ): Promise<CommitContactDecisionResult>;
  recordEvaluationFailure(
    input: RecordEvaluationFailureInput,
  ): Promise<RecordEvaluationFailureResult>;
  requestEvaluation(
    input: RequestContactIntentEvaluationInput,
  ): Promise<RequestContactIntentEvaluationResult>;
  listAuditEvents(intentId: string): Promise<ContactIntentAuditEvent[]>;
  listDecisions(intentId: string): Promise<ContactDecision[]>;
}

export class InvalidStoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStoreInputError";
  }
}

export class ContactIntentNotFoundError extends Error {
  constructor(intentId: string) {
    super(`Contact intent ${intentId} was not found`);
    this.name = "ContactIntentNotFoundError";
  }
}

export class ContactIntentStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactIntentStoreConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(scope: StoreIdempotencyEntry["scope"], key: string) {
    super(`Idempotency key ${key} was already used with different input in ${scope}`);
    this.name = "IdempotencyConflictError";
  }
}

const TERMINAL_STATUSES = new Set<IntentStatus>([
  "resolved",
  "cancelled",
  "expired",
]);

const TERMINAL_STATUS_BY_ACTION: Partial<
  Record<ContactDecision["action"], IntentStatus>
> = {
  cancel: "cancelled",
  expire: "expired",
  resolve: "resolved",
};

const EVALUATION_FAILURE_STAGES = new Set([
  "context",
  "semantic",
  "evaluation",
]);

function validateEvaluationFailureShape(
  failure: ContactIntentEvaluationFailure,
): void {
  if (!EVALUATION_FAILURE_STAGES.has(failure.stage)) {
    throw new InvalidStoreInputError(
      `Failure ${failure.id} has unsupported stage ${String(failure.stage)}`,
    );
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(failure.code)) {
    throw new InvalidStoreInputError(
      `Failure ${failure.id} code must be a short sanitized identifier`,
    );
  }
}

function validateEvaluationRequestShape(
  request: ContactIntentEvaluationRequest,
): void {
  requireNonEmpty(request.id, "request.id");
  requireNonEmpty(request.intentId, "request.intentId");
  requireNonEmpty(request.reason, "request.reason");
  requireNonEmpty(request.policyVersion, "request.policyVersion");
  if (!["reevaluate", "cancel", "resolve"].includes(request.effect)) {
    throw new InvalidStoreInputError(
      `Evaluation request ${request.id} has unsupported effect ${String(request.effect)}`,
    );
  }
  if (
    !Number.isFinite(request.confidence) ||
    request.confidence < 0 ||
    request.confidence > 1
  ) {
    throw new InvalidStoreInputError(
      `Evaluation request ${request.id} confidence must be between 0 and 1`,
    );
  }
  if (
    !Array.isArray(request.eventIds) ||
    request.eventIds.length === 0 ||
    request.eventIds.some((eventId) => eventId.trim().length === 0) ||
    new Set(request.eventIds).size !== request.eventIds.length
  ) {
    throw new InvalidStoreInputError(
      `Evaluation request ${request.id} must cite unique non-empty event ids`,
    );
  }
  timestamp(request.requestedAt, "request.requestedAt");
  timestamp(request.nextEvaluationAt, "request.nextEvaluationAt");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new InvalidStoreInputError(`${name} must not be empty`);
  }
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidStoreInputError(`${name} must be a valid date-time`);
  }
  return parsed;
}

function validateNextEvaluationAt(
  intent: ContactIntent,
  nextEvaluationAt: string | null,
  allowBeforeNotBefore = false,
): void {
  if (nextEvaluationAt !== null) {
    timestamp(nextEvaluationAt, "nextEvaluationAt");
  }
  if (intent.status === "candidate" && nextEvaluationAt !== null) {
    throw new InvalidStoreInputError(
      "Candidate intents cannot be scheduled before activation",
    );
  }
  if (TERMINAL_STATUSES.has(intent.status) && nextEvaluationAt !== null) {
    throw new InvalidStoreInputError(
      `Terminal intent ${intent.id} cannot have a next evaluation time`,
    );
  }
  if (
    intent.status === "active" &&
    nextEvaluationAt !== null &&
    !allowBeforeNotBefore &&
    intent.notBefore !== null &&
    timestamp(nextEvaluationAt, "nextEvaluationAt") <
      timestamp(intent.notBefore, "intent.notBefore")
  ) {
    throw new InvalidStoreInputError(
      `Intent ${intent.id} cannot be evaluated before notBefore`,
    );
  }
}

function idempotencyMapKey(
  scope: StoreIdempotencyEntry["scope"],
  key: string,
): string {
  return `${scope}\u0000${key}`;
}

function targetEquals(left: ContactTarget, right: ContactTarget): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function auditEventId(event: ContactIntentAuditEvent): string {
  if (event.kind === "activated") return event.activation.id;
  if (event.kind === "decision") return event.decision.id;
  if (event.kind === "evaluation-failed") return event.failure.id;
  return event.request.id;
}

function auditEventIntentId(event: ContactIntentAuditEvent): string {
  if (event.kind === "activated") return event.activation.intentId;
  if (event.kind === "decision") return event.decision.intentId;
  if (event.kind === "evaluation-failed") return event.failure.intentId;
  return event.request.intentId;
}

function auditEventTime(event: ContactIntentAuditEvent): string {
  if (event.kind === "activated") return event.activation.activatedAt;
  if (event.kind === "decision") return event.decision.evaluatedAt;
  if (event.kind === "evaluation-failed") return event.failure.failedAt;
  return event.request.requestedAt;
}

export class InMemoryContactIntentStore implements ContactIntentStore {
  readonly #records = new Map<string, StoredContactIntent>();
  readonly #events = new Map<string, ContactIntentAuditEvent[]>();
  readonly #eventIds = new Map<string, ContactIntentAuditEvent>();
  readonly #idempotency = new Map<string, StoreIdempotencyEntry>();

  constructor(snapshot?: ContactIntentStoreSnapshot) {
    if (snapshot) {
      this.#restore(snapshot);
    }
  }

  async createIntent(
    input: CreateContactIntentInput,
  ): Promise<CreateContactIntentResult> {
    requireNonEmpty(input.intent.id, "intent.id");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (TERMINAL_STATUSES.has(input.intent.status)) {
      throw new InvalidStoreInputError(
        `New intent ${input.intent.id} must be candidate or active`,
      );
    }
    validateNextEvaluationAt(input.intent, input.nextEvaluationAt);

    const fingerprint = stableStringify({
      intent: input.intent,
      nextEvaluationAt: input.nextEvaluationAt,
    });
    const mapKey = idempotencyMapKey("create-intent", input.idempotencyKey);
    const prior = this.#idempotency.get(mapKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("create-intent", input.idempotencyKey);
      }
      const record = this.#records.get(prior.intentId);
      if (!record) {
        throw new ContactIntentStoreConflictError(
          `Idempotency record for ${input.idempotencyKey} references a missing intent`,
        );
      }
      return { outcome: "duplicate", record: clone(record) };
    }

    if (this.#records.has(input.intent.id)) {
      throw new ContactIntentStoreConflictError(
        `Contact intent ${input.intent.id} already exists`,
      );
    }

    const record: StoredContactIntent = {
      intent: clone(input.intent),
      revision: 1,
      nextEvaluationAt: input.nextEvaluationAt,
    };
    this.#records.set(input.intent.id, record);
    this.#events.set(input.intent.id, []);
    this.#idempotency.set(mapKey, {
      scope: "create-intent",
      key: input.idempotencyKey,
      fingerprint,
      intentId: input.intent.id,
      operationId: null,
    });
    return { outcome: "created", record: clone(record) };
  }

  async activateIntent(
    input: ActivateContactIntentInput,
  ): Promise<ActivateContactIntentResult> {
    requireNonEmpty(input.intentId, "intentId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.activation.id, "activation.id");
    requireNonEmpty(input.activation.reason, "activation.reason");
    requireNonEmpty(input.activation.policyVersion, "activation.policyVersion");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new InvalidStoreInputError("expectedRevision must be a positive integer");
    }
    if (input.activation.intentId !== input.intentId) {
      throw new InvalidStoreInputError(
        `Activation ${input.activation.id} targets ${input.activation.intentId}, not ${input.intentId}`,
      );
    }
    const activatedAt = timestamp(
      input.activation.activatedAt,
      "activation.activatedAt",
    );
    const nextEvaluationAt = timestamp(
      input.activation.nextEvaluationAt,
      "activation.nextEvaluationAt",
    );
    if (nextEvaluationAt < activatedAt) {
      throw new InvalidStoreInputError(
        `Activation ${input.activation.id} cannot schedule an evaluation in its past`,
      );
    }

    const fingerprint = stableStringify({
      intentId: input.intentId,
      expectedRevision: input.expectedRevision,
      activation: input.activation,
    });
    const mapKey = idempotencyMapKey("activate-intent", input.idempotencyKey);
    const prior = this.#idempotency.get(mapKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("activate-intent", input.idempotencyKey);
      }
      const record = this.#records.get(prior.intentId);
      const event = prior.operationId
        ? this.#eventIds.get(prior.operationId)
        : undefined;
      if (!record || event?.kind !== "activated") {
        throw new ContactIntentStoreConflictError(
          `Idempotency record for ${input.idempotencyKey} references missing activation data`,
        );
      }
      return {
        outcome: "duplicate",
        record: clone(record),
        activation: clone(event.activation),
      };
    }

    const current = this.#records.get(input.intentId);
    if (!current) throw new ContactIntentNotFoundError(input.intentId);
    if (current.revision !== input.expectedRevision) {
      throw new ContactIntentStoreConflictError(
        `Expected revision ${input.expectedRevision} for ${input.intentId}, found ${current.revision}`,
      );
    }
    if (current.intent.status !== "candidate") {
      throw new InvalidStoreInputError(
        `Only candidate intents can be activated; ${input.intentId} is ${current.intent.status}`,
      );
    }
    if (activatedAt < timestamp(current.intent.updatedAt, "intent.updatedAt")) {
      throw new InvalidStoreInputError(
        `Activation ${input.activation.id} predates the current intent state`,
      );
    }
    if (this.#eventIds.has(input.activation.id)) {
      throw new ContactIntentStoreConflictError(
        `Audit event ${input.activation.id} already exists`,
      );
    }

    const activatedIntent = applyActivation(
      current.intent,
      input.activation.activatedAt,
    );
    validateNextEvaluationAt(
      activatedIntent,
      input.activation.nextEvaluationAt,
    );
    const updated: StoredContactIntent = {
      intent: activatedIntent,
      revision: current.revision + 1,
      nextEvaluationAt: input.activation.nextEvaluationAt,
    };
    const activation = clone(input.activation);
    const event: ContactIntentAuditEvent = { kind: "activated", activation };
    this.#records.set(input.intentId, clone(updated));
    this.#events.get(input.intentId)?.push(event);
    this.#eventIds.set(activation.id, event);
    this.#idempotency.set(mapKey, {
      scope: "activate-intent",
      key: input.idempotencyKey,
      fingerprint,
      intentId: input.intentId,
      operationId: activation.id,
    });
    return {
      outcome: "activated",
      record: clone(updated),
      activation: clone(activation),
    };
  }

  async getIntent(intentId: string): Promise<StoredContactIntent | null> {
    requireNonEmpty(intentId, "intentId");
    const record = this.#records.get(intentId);
    return record ? clone(record) : null;
  }

  async listIntents(query: ContactIntentQuery = {}): Promise<StoredContactIntent[]> {
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) {
      throw new InvalidStoreInputError("limit must be a positive integer");
    }
    const dueBoundary =
      query.dueAtOrBefore === undefined
        ? null
        : timestamp(query.dueAtOrBefore, "dueAtOrBefore");
    const statuses = query.statuses ? new Set(query.statuses) : null;

    const matches = [...this.#records.values()].filter((record) => {
      if (statuses && !statuses.has(record.intent.status)) return false;
      if (query.target && !targetEquals(record.intent.target, query.target)) return false;
      if (query.scheduledOnly && record.nextEvaluationAt === null) return false;
      if (dueBoundary !== null) {
        if (record.intent.status !== "active" || record.nextEvaluationAt === null) {
          return false;
        }
        if (timestamp(record.nextEvaluationAt, "stored nextEvaluationAt") > dueBoundary) {
          return false;
        }
      }
      return true;
    });

    matches.sort((left, right) => {
      const leftDue = left.nextEvaluationAt
        ? timestamp(left.nextEvaluationAt, "stored nextEvaluationAt")
        : Number.POSITIVE_INFINITY;
      const rightDue = right.nextEvaluationAt
        ? timestamp(right.nextEvaluationAt, "stored nextEvaluationAt")
        : Number.POSITIVE_INFINITY;
      return (
        leftDue - rightDue ||
        right.intent.priority - left.intent.priority ||
        timestamp(left.intent.createdAt, "intent.createdAt") -
          timestamp(right.intent.createdAt, "intent.createdAt") ||
        left.intent.id.localeCompare(right.intent.id)
      );
    });

    const limited = query.limit === undefined ? matches : matches.slice(0, query.limit);
    return clone(limited);
  }

  async commitDecision(
    input: CommitContactDecisionInput,
  ): Promise<CommitContactDecisionResult> {
    requireNonEmpty(input.intentId, "intentId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.decision.id, "decision.id");
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new InvalidStoreInputError("expectedRevision must be a positive integer");
    }
    if (input.decision.intentId !== input.intentId) {
      throw new InvalidStoreInputError(
        `Decision ${input.decision.id} targets ${input.decision.intentId}, not ${input.intentId}`,
      );
    }
    if (input.decision.nextEvaluationAt !== null) {
      timestamp(input.decision.nextEvaluationAt, "decision.nextEvaluationAt");
    }

    const fingerprint = stableStringify({
      intentId: input.intentId,
      expectedRevision: input.expectedRevision,
      decision: input.decision,
    });
    const mapKey = idempotencyMapKey("commit-decision", input.idempotencyKey);
    const prior = this.#idempotency.get(mapKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(
          "commit-decision",
          input.idempotencyKey,
        );
      }
      const record = this.#records.get(prior.intentId);
      const event = prior.operationId
        ? this.#eventIds.get(prior.operationId)
        : undefined;
      if (!record || event?.kind !== "decision") {
        throw new ContactIntentStoreConflictError(
          `Idempotency record for ${input.idempotencyKey} references missing data`,
        );
      }
      return {
        outcome: "duplicate",
        record: clone(record),
        decision: clone(event.decision),
      };
    }

    const current = this.#records.get(input.intentId);
    if (!current) throw new ContactIntentNotFoundError(input.intentId);
    if (current.revision !== input.expectedRevision) {
      throw new ContactIntentStoreConflictError(
        `Expected revision ${input.expectedRevision} for ${input.intentId}, found ${current.revision}`,
      );
    }
    if (this.#eventIds.has(input.decision.id)) {
      throw new ContactIntentStoreConflictError(
        `Audit event ${input.decision.id} already exists`,
      );
    }
    if (current.intent.status !== "active") {
      throw new InvalidStoreInputError(
        `Only active intents can be evaluated; ${input.intentId} is ${current.intent.status}`,
      );
    }
    const evaluatedAt = timestamp(input.decision.evaluatedAt, "decision.evaluatedAt");
    if (evaluatedAt < timestamp(current.intent.updatedAt, "intent.updatedAt")) {
      throw new InvalidStoreInputError(
        `Decision ${input.decision.id} predates the current intent state`,
      );
    }
    if (
      input.decision.nextEvaluationAt !== null &&
      timestamp(input.decision.nextEvaluationAt, "decision.nextEvaluationAt") <
        evaluatedAt
    ) {
      throw new InvalidStoreInputError(
        `Decision ${input.decision.id} cannot schedule an evaluation in its past`,
      );
    }

    const updatedIntent = applyDecision(current.intent, input.decision);
    validateNextEvaluationAt(updatedIntent, input.decision.nextEvaluationAt);
    const updated: StoredContactIntent = {
      intent: updatedIntent,
      revision: current.revision + 1,
      nextEvaluationAt: input.decision.nextEvaluationAt,
    };
    const decision = clone(input.decision);
    const event: ContactIntentAuditEvent = { kind: "decision", decision };
    this.#records.set(input.intentId, clone(updated));
    this.#events.get(input.intentId)?.push(event);
    this.#eventIds.set(decision.id, event);
    this.#idempotency.set(mapKey, {
      scope: "commit-decision",
      key: input.idempotencyKey,
      fingerprint,
      intentId: input.intentId,
      operationId: decision.id,
    });
    return {
      outcome: "committed",
      record: clone(updated),
      decision: clone(decision),
    };
  }

  async recordEvaluationFailure(
    input: RecordEvaluationFailureInput,
  ): Promise<RecordEvaluationFailureResult> {
    requireNonEmpty(input.intentId, "intentId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.failure.id, "failure.id");
    requireNonEmpty(input.failure.code, "failure.code");
    requireNonEmpty(input.failure.policyVersion, "failure.policyVersion");
    validateEvaluationFailureShape(input.failure);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new InvalidStoreInputError("expectedRevision must be a positive integer");
    }
    if (input.failure.intentId !== input.intentId) {
      throw new InvalidStoreInputError(
        `Failure ${input.failure.id} targets ${input.failure.intentId}, not ${input.intentId}`,
      );
    }
    if (!Number.isInteger(input.failure.attempt) || input.failure.attempt <= 0) {
      throw new InvalidStoreInputError("failure.attempt must be a positive integer");
    }
    const failedAt = timestamp(input.failure.failedAt, "failure.failedAt");
    if (input.failure.exhausted !== (input.failure.nextEvaluationAt === null)) {
      throw new InvalidStoreInputError(
        "An exhausted failure must have no retry time, and a retryable failure must have one",
      );
    }
    if (
      input.failure.nextEvaluationAt !== null &&
      timestamp(input.failure.nextEvaluationAt, "failure.nextEvaluationAt") <= failedAt
    ) {
      throw new InvalidStoreInputError(
        `Failure ${input.failure.id} must schedule its retry after failedAt`,
      );
    }

    const fingerprint = stableStringify({
      intentId: input.intentId,
      expectedRevision: input.expectedRevision,
      failure: input.failure,
    });
    const mapKey = idempotencyMapKey("record-failure", input.idempotencyKey);
    const prior = this.#idempotency.get(mapKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError("record-failure", input.idempotencyKey);
      }
      const record = this.#records.get(prior.intentId);
      const event = prior.operationId
        ? this.#eventIds.get(prior.operationId)
        : undefined;
      if (!record || event?.kind !== "evaluation-failed") {
        throw new ContactIntentStoreConflictError(
          `Idempotency record for ${input.idempotencyKey} references missing failure data`,
        );
      }
      return {
        outcome: "duplicate",
        record: clone(record),
        failure: clone(event.failure),
      };
    }

    const current = this.#records.get(input.intentId);
    if (!current) throw new ContactIntentNotFoundError(input.intentId);
    if (current.revision !== input.expectedRevision) {
      throw new ContactIntentStoreConflictError(
        `Expected revision ${input.expectedRevision} for ${input.intentId}, found ${current.revision}`,
      );
    }
    if (current.intent.status !== "active") {
      throw new InvalidStoreInputError(
        `Only active intents can record evaluation failures; ${input.intentId} is ${current.intent.status}`,
      );
    }
    const existingEvents = this.#events.get(input.intentId) ?? [];
    const lastEvent = existingEvents.at(-1);
    if (
      lastEvent &&
      failedAt < timestamp(auditEventTime(lastEvent), "last audit event time")
    ) {
      throw new InvalidStoreInputError(
        `Failure ${input.failure.id} predates the current audit history`,
      );
    }
    let consecutiveFailures = 0;
    for (let index = existingEvents.length - 1; index >= 0; index -= 1) {
      if (existingEvents[index]?.kind !== "evaluation-failed") break;
      consecutiveFailures += 1;
    }
    if (input.failure.attempt !== consecutiveFailures + 1) {
      throw new InvalidStoreInputError(
        `Failure ${input.failure.id} attempt must be ${consecutiveFailures + 1}`,
      );
    }
    if (this.#eventIds.has(input.failure.id)) {
      throw new ContactIntentStoreConflictError(
        `Audit event ${input.failure.id} already exists`,
      );
    }

    const failure = clone(input.failure);
    const event: ContactIntentAuditEvent = {
      kind: "evaluation-failed",
      failure,
    };
    const updated: StoredContactIntent = {
      intent: clone(current.intent),
      revision: current.revision + 1,
      nextEvaluationAt: failure.nextEvaluationAt,
    };
    this.#records.set(input.intentId, clone(updated));
    this.#events.get(input.intentId)?.push(event);
    this.#eventIds.set(failure.id, event);
    this.#idempotency.set(mapKey, {
      scope: "record-failure",
      key: input.idempotencyKey,
      fingerprint,
      intentId: input.intentId,
      operationId: failure.id,
    });
    return {
      outcome: "recorded",
      record: clone(updated),
      failure: clone(failure),
    };
  }

  async requestEvaluation(
    input: RequestContactIntentEvaluationInput,
  ): Promise<RequestContactIntentEvaluationResult> {
    requireNonEmpty(input.intentId, "intentId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    validateEvaluationRequestShape(input.request);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new InvalidStoreInputError("expectedRevision must be a positive integer");
    }
    if (input.request.intentId !== input.intentId) {
      throw new InvalidStoreInputError(
        `Evaluation request ${input.request.id} targets ${input.request.intentId}, not ${input.intentId}`,
      );
    }

    const fingerprint = stableStringify({
      intentId: input.intentId,
      request: input.request,
    });
    const mapKey = idempotencyMapKey("request-evaluation", input.idempotencyKey);
    const prior = this.#idempotency.get(mapKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(
          "request-evaluation",
          input.idempotencyKey,
        );
      }
      const record = this.#records.get(prior.intentId);
      const event = prior.operationId
        ? this.#eventIds.get(prior.operationId)
        : undefined;
      if (!record || event?.kind !== "evaluation-requested") {
        throw new ContactIntentStoreConflictError(
          `Idempotency record for ${input.idempotencyKey} references missing evaluation request data`,
        );
      }
      return {
        outcome: "duplicate",
        record: clone(record),
        request: clone(event.request),
      };
    }

    const current = this.#records.get(input.intentId);
    if (!current) throw new ContactIntentNotFoundError(input.intentId);
    if (current.revision !== input.expectedRevision) {
      throw new ContactIntentStoreConflictError(
        `Expected revision ${input.expectedRevision} for ${input.intentId}, found ${current.revision}`,
      );
    }
    if (current.intent.status !== "active") {
      throw new InvalidStoreInputError(
        `Only active intents can request evaluation; ${input.intentId} is ${current.intent.status}`,
      );
    }
    validateNextEvaluationAt(current.intent, input.request.nextEvaluationAt, true);
    const existingEvents = this.#events.get(input.intentId) ?? [];
    const lastEvent = existingEvents.at(-1);
    if (
      lastEvent &&
      timestamp(input.request.requestedAt, "request.requestedAt") <
        timestamp(auditEventTime(lastEvent), "last audit event time")
    ) {
      throw new InvalidStoreInputError(
        `Evaluation request ${input.request.id} predates the current audit history`,
      );
    }
    if (this.#eventIds.has(input.request.id)) {
      throw new ContactIntentStoreConflictError(
        `Audit event ${input.request.id} already exists`,
      );
    }

    const projectedNextEvaluationAt =
      current.nextEvaluationAt !== null &&
      timestamp(current.nextEvaluationAt, "current.nextEvaluationAt") <
        timestamp(input.request.nextEvaluationAt, "request.nextEvaluationAt")
        ? current.nextEvaluationAt
        : input.request.nextEvaluationAt;
    const request = clone({
      ...input.request,
      nextEvaluationAt: projectedNextEvaluationAt,
    });
    const event: ContactIntentAuditEvent = {
      kind: "evaluation-requested",
      request,
    };
    const updated: StoredContactIntent = {
      intent: clone(current.intent),
      revision: current.revision + 1,
      nextEvaluationAt: request.nextEvaluationAt,
    };
    this.#records.set(input.intentId, clone(updated));
    this.#events.get(input.intentId)?.push(event);
    this.#eventIds.set(request.id, event);
    this.#idempotency.set(mapKey, {
      scope: "request-evaluation",
      key: input.idempotencyKey,
      fingerprint,
      intentId: input.intentId,
      operationId: request.id,
    });
    return {
      outcome: "requested",
      record: clone(updated),
      request: clone(request),
    };
  }

  async listAuditEvents(intentId: string): Promise<ContactIntentAuditEvent[]> {
    requireNonEmpty(intentId, "intentId");
    if (!this.#records.has(intentId)) {
      throw new ContactIntentNotFoundError(intentId);
    }
    return clone(this.#events.get(intentId) ?? []);
  }

  async listDecisions(intentId: string): Promise<ContactDecision[]> {
    return (await this.listAuditEvents(intentId))
      .filter(
        (event): event is Extract<ContactIntentAuditEvent, { kind: "decision" }> =>
          event.kind === "decision",
      )
      .map((event) => event.decision);
  }

  exportSnapshot(): ContactIntentStoreSnapshot {
    return clone({
      schemaVersion: "0.1.3",
      records: [...this.#records.values()],
      events: [...this.#eventIds.values()],
      idempotency: [...this.#idempotency.values()],
    });
  }

  #restore(snapshot: ContactIntentStoreSnapshot): void {
    if (snapshot.schemaVersion !== "0.1.3") {
      throw new InvalidStoreInputError(
        `Unsupported store snapshot version ${String(snapshot.schemaVersion)}`,
      );
    }
    for (const record of snapshot.records) {
      if (this.#records.has(record.intent.id)) {
        throw new ContactIntentStoreConflictError(
          `Snapshot contains duplicate intent ${record.intent.id}`,
        );
      }
      if (!Number.isInteger(record.revision) || record.revision <= 0) {
        throw new InvalidStoreInputError(
          `Snapshot revision for ${record.intent.id} must be a positive integer`,
        );
      }
      validateNextEvaluationAt(record.intent, record.nextEvaluationAt, true);
      this.#records.set(record.intent.id, clone(record));
      this.#events.set(record.intent.id, []);
    }
    for (const rawEvent of snapshot.events) {
      const event = clone(rawEvent);
      const intentId = auditEventIntentId(event);
      const eventId = auditEventId(event);
      requireNonEmpty(eventId, "snapshot audit event id");
      if (!this.#records.has(intentId)) {
        throw new ContactIntentStoreConflictError(
          `Audit event ${eventId} references missing intent ${intentId}`,
        );
      }
      if (this.#eventIds.has(eventId)) {
        throw new ContactIntentStoreConflictError(
          `Snapshot contains duplicate audit event ${eventId}`,
        );
      }
      this.#eventIds.set(eventId, event);
      this.#events.get(intentId)?.push(event);
    }
    for (const entry of snapshot.idempotency) {
      requireNonEmpty(entry.key, "snapshot idempotency key");
      requireNonEmpty(entry.fingerprint, "snapshot idempotency fingerprint");
      const key = idempotencyMapKey(entry.scope, entry.key);
      if (this.#idempotency.has(key)) {
        throw new ContactIntentStoreConflictError(
          `Snapshot contains duplicate idempotency key ${entry.key} in ${entry.scope}`,
        );
      }
      if (!this.#records.has(entry.intentId)) {
        throw new ContactIntentStoreConflictError(
          `Idempotency key ${entry.key} references missing intent ${entry.intentId}`,
        );
      }
      if (entry.scope === "create-intent" && entry.operationId !== null) {
        throw new ContactIntentStoreConflictError(
          `Create idempotency key ${entry.key} cannot reference an audit event`,
        );
      }
      if (entry.scope !== "create-intent" && entry.operationId === null) {
        throw new ContactIntentStoreConflictError(
          `Idempotency key ${entry.key} must reference an audit event`,
        );
      }
      this.#idempotency.set(key, clone(entry));
    }

    const createEntriesByIntent = new Map<string, number>();
    const eventEntriesById = new Map<string, number>();
    for (const entry of snapshot.idempotency) {
      if (entry.scope === "create-intent") {
        createEntriesByIntent.set(
          entry.intentId,
          (createEntriesByIntent.get(entry.intentId) ?? 0) + 1,
        );
        continue;
      }
      const event = entry.operationId
        ? this.#eventIds.get(entry.operationId)
        : undefined;
      const expectedKind =
        entry.scope === "activate-intent"
          ? "activated"
          : entry.scope === "record-failure"
            ? "evaluation-failed"
            : entry.scope === "request-evaluation"
              ? "evaluation-requested"
              : "decision";
      if (
        !event ||
        event.kind !== expectedKind ||
        auditEventIntentId(event) !== entry.intentId
      ) {
        throw new ContactIntentStoreConflictError(
          `Idempotency key ${entry.key} does not match audit event ${String(entry.operationId)}`,
        );
      }
      const eventId = auditEventId(event);
      eventEntriesById.set(
        eventId,
        (eventEntriesById.get(eventId) ?? 0) + 1,
      );
    }

    for (const record of this.#records.values()) {
      const events = this.#events.get(record.intent.id) ?? [];
      if (events.length !== record.revision - 1) {
        throw new ContactIntentStoreConflictError(
          `Intent ${record.intent.id} revision does not match its audit history`,
        );
      }
      if ((createEntriesByIntent.get(record.intent.id) ?? 0) !== 1) {
        throw new ContactIntentStoreConflictError(
          `Intent ${record.intent.id} must have exactly one create idempotency entry`,
        );
      }
      const hasActivation = events.some((event) => event.kind === "activated");
      let inferredStatus: IntentStatus = hasActivation
        ? "candidate"
        : record.intent.status === "candidate"
          ? "candidate"
          : "active";
      let priorTime = timestamp(record.intent.createdAt, "intent.createdAt");
      let expectedProjection: string | null | undefined;
      let expectedUpdatedAt = record.intent.createdAt;
      let consecutiveFailures = 0;
      for (const [index, event] of events.entries()) {
        const eventId = auditEventId(event);
        if ((eventEntriesById.get(eventId) ?? 0) !== 1) {
          throw new ContactIntentStoreConflictError(
            `Audit event ${eventId} must have exactly one idempotency entry`,
          );
        }
        const currentTime = timestamp(
          auditEventTime(event),
          `audit event ${eventId} time`,
        );
        if (currentTime < priorTime) {
          throw new ContactIntentStoreConflictError(
            `Intent ${record.intent.id} audit events are not chronological`,
          );
        }
        priorTime = currentTime;

        if (event.kind === "activated") {
          if (inferredStatus !== "candidate" || index !== 0) {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has an invalid activation position`,
            );
          }
          inferredStatus = "active";
          expectedProjection = event.activation.nextEvaluationAt;
          expectedUpdatedAt = event.activation.activatedAt;
          consecutiveFailures = 0;
        } else if (event.kind === "decision") {
          if (inferredStatus !== "active") {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has a decision while ${inferredStatus}`,
            );
          }
          inferredStatus =
            TERMINAL_STATUS_BY_ACTION[event.decision.action] ?? "active";
          expectedProjection = event.decision.nextEvaluationAt;
          expectedUpdatedAt = event.decision.evaluatedAt;
          consecutiveFailures = 0;
          if (TERMINAL_STATUSES.has(inferredStatus) && index !== events.length - 1) {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has events after a terminal decision`,
            );
          }
        } else if (event.kind === "evaluation-failed") {
          if (inferredStatus !== "active") {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has an evaluation failure while ${inferredStatus}`,
            );
          }
          const { failure } = event;
          try {
            validateEvaluationFailureShape(failure);
          } catch (error) {
            throw new ContactIntentStoreConflictError(
              error instanceof Error
                ? error.message
                : `Intent ${record.intent.id} has an invalid evaluation failure`,
            );
          }
          if (failure.attempt !== consecutiveFailures + 1) {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has a non-consecutive failure attempt`,
            );
          }
          if (failure.exhausted !== (failure.nextEvaluationAt === null)) {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has an inconsistent exhausted failure`,
            );
          }
          if (
            failure.nextEvaluationAt !== null &&
            timestamp(failure.nextEvaluationAt, "failure.nextEvaluationAt") <= currentTime
          ) {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} failure retry must be after failedAt`,
            );
          }
          consecutiveFailures += 1;
          expectedProjection = failure.nextEvaluationAt;
        } else {
          if (inferredStatus !== "active") {
            throw new ContactIntentStoreConflictError(
              `Intent ${record.intent.id} has an evaluation request while ${inferredStatus}`,
            );
          }
          try {
            validateEvaluationRequestShape(event.request);
          } catch (error) {
            throw new ContactIntentStoreConflictError(
              error instanceof Error
                ? error.message
                : `Intent ${record.intent.id} has an invalid evaluation request`,
            );
          }
          consecutiveFailures = 0;
          expectedProjection = event.request.nextEvaluationAt;
        }
      }
      if (inferredStatus !== record.intent.status) {
        throw new ContactIntentStoreConflictError(
          `Intent ${record.intent.id} state does not match its audit history`,
        );
      }
      if (
        expectedProjection !== undefined &&
        expectedProjection !== record.nextEvaluationAt
      ) {
        throw new ContactIntentStoreConflictError(
          `Intent ${record.intent.id} schedule does not match its last audit event`,
        );
      }
      if (
        timestamp(record.intent.updatedAt, "intent.updatedAt") !==
        timestamp(expectedUpdatedAt, "expected updatedAt")
      ) {
        throw new ContactIntentStoreConflictError(
          `Intent ${record.intent.id} updatedAt does not match its audit history`,
        );
      }
    }
  }
}
