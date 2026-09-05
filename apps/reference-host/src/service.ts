import { createHash } from "node:crypto";

import {
  FakeClock,
  evaluateDueContactIntents,
  extractContactIntents,
  registerExtractedIntents,
  requestRelevantEvaluations,
  routeConversationEvents,
  type CandidateGenerator,
  type CancellationSignal,
  type ContactIntent,
  type ContactIntentStore,
  type ContactPolicyState,
  type ContactTarget,
  type ConversationEvent,
  type DueEvaluationContext,
  type EvaluateDueContactIntentsResult,
  type PolicyBlock,
  type RelevanceRouter,
  type RequestRelevantEvaluationsResult,
  type SemanticDecisionProposal,
  type SemanticReevaluator,
  type StoredContactIntent,
} from "@wakeintent/core";
import {
  ConversationEventStoreConflictError,
  JsonConversationEventStore,
  type ConversationEventBatch,
  type ConversationIngestionPlan,
} from "./event-store.js";
import {
  validateContactIntent,
  validateConversationEvent,
} from "@wakeintent/schemas";
import { openJsonContactIntentStore } from "@wakeintent/store-json";
import type { ModelCallRecord } from "@wakeintent/model-openai-compatible";

import {
  JsonOutboxStore,
  type DeliveryReceipt,
  type OutboxItem,
  type RecordDeliveryReceiptResult,
} from "./outbox.js";
import {
  reconcileContactDecisions,
  type ReconciliationResult,
} from "./reconcile.js";

export interface RegisterIntentInput {
  intent: ContactIntent;
  nextEvaluationAt: string | null;
  idempotencyKey: string;
}

export interface EvaluationContextInput extends DueEvaluationContext {
  semanticProposal?: SemanticDecisionProposal;
}

export interface RunEvaluationInput {
  now: string;
  policyVersion: string;
  contexts: Record<string, EvaluationContextInput>;
  limit?: number;
}

export interface RunEvaluationResult {
  evaluation: EvaluateDueContactIntentsResult;
  reconciliation: ReconciliationResult;
}

export interface ReferenceHostState {
  intents: StoredContactIntent[];
  outbox: OutboxItem[];
}

export interface ReferenceHostServiceOptions {
  intentStorePath: string;
  outboxPath: string;
  eventStorePath?: string;
  conversationRuntime?: ConversationRuntime;
}

export interface ConversationRuntime {
  candidateGenerator: CandidateGenerator;
  relevanceRouter: RelevanceRouter;
  semanticReevaluator: SemanticReevaluator;
  getTelemetrySnapshot?: () => ConversationModelTelemetry;
}

export interface ConversationModelTelemetry {
  candidateAndDecisionCalls: ModelCallRecord[];
  relevanceCalls: ModelCallRecord[];
}

export interface ProcessConversationInput {
  conversationId: string;
  events: ConversationEvent[];
  target: ContactTarget;
  now: string;
  idempotencyKey: string;
  activationThreshold: number;
  routePolicyVersion: string;
  timeZone?: string;
}

export interface ProcessConversationResult {
  outcome: "created" | "resumed" | "duplicate";
  modelWorkPerformed: boolean;
  batch: ConversationEventBatch;
  plan: ConversationIngestionPlan;
  registrations: Awaited<ReturnType<typeof registerExtractedIntents>> | null;
  routing: RequestRelevantEvaluationsResult | null;
  modelCalls: ConversationModelTelemetry;
}

export interface RunModelEvaluationInput {
  now: string;
  policyVersion: string;
  userStates: Record<string, ContactPolicyState>;
  limit?: number;
  /** Maximum raw conversation events exposed to each semantic reevaluation. */
  contextEventLimit?: number;
  routeClosureThreshold?: number;
}

export interface RunModelEvaluationResult extends RunEvaluationResult {
  modelCalls: ConversationModelTelemetry;
}

export class InvalidReferenceHostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceHostInputError";
  }
}

export class ReferenceHostCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceHostCapabilityError";
  }
}

function requireObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidReferenceHostInputError(`${label} must be an object`);
  }
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidReferenceHostInputError(`${label} must be a non-empty string`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InvalidReferenceHostInputError(`${label} must be a valid date-time`);
  }
}

function validationDetails(
  errors: ReadonlyArray<{ instancePath: string; message?: string }>,
): string {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function targetKey(target: ContactTarget): string {
  return `${target.kind}:${target.id}`;
}

function ingestionDigest(input: ProcessConversationInput): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex")
    .slice(0, 20);
}

function emptyModelTelemetry(): ConversationModelTelemetry {
  return { candidateAndDecisionCalls: [], relevanceCalls: [] };
}

function telemetryLengths(runtime: ConversationRuntime): [number, number] {
  const snapshot = runtime.getTelemetrySnapshot?.();
  return [
    snapshot?.candidateAndDecisionCalls.length ?? 0,
    snapshot?.relevanceCalls.length ?? 0,
  ];
}

function telemetryDelta(
  runtime: ConversationRuntime,
  before: [number, number],
): ConversationModelTelemetry {
  const snapshot = runtime.getTelemetrySnapshot?.();
  if (!snapshot) return emptyModelTelemetry();
  return {
    candidateAndDecisionCalls: snapshot.candidateAndDecisionCalls.slice(before[0]),
    relevanceCalls: snapshot.relevanceCalls.slice(before[1]),
  };
}

function validateTarget(target: unknown): asserts target is ContactTarget {
  requireObject(target, "target");
  if (!["user", "conversation", "participant"].includes(String(target.kind))) {
    throw new InvalidReferenceHostInputError("target.kind is unsupported");
  }
  requireNonEmpty(target.id, "target.id");
}

function validateUserState(value: unknown, label: string): ContactPolicyState {
  requireObject(value, label);
  if (!["granted", "denied", "unknown"].includes(String(value.authorization))) {
    throw new InvalidReferenceHostInputError(
      `${label}.authorization must be granted, denied, or unknown`,
    );
  }
  if (value.doNotDisturbUntil !== undefined) {
    requireTimestamp(value.doNotDisturbUntil, `${label}.doNotDisturbUntil`);
  }
  if (
    value.remainingContactBudget !== undefined &&
    (!Number.isInteger(value.remainingContactBudget) ||
      Number(value.remainingContactBudget) < 0)
  ) {
    throw new InvalidReferenceHostInputError(
      `${label}.remainingContactBudget must be a non-negative integer`,
    );
  }
  if (value.budgetResetsAt !== undefined) {
    requireTimestamp(value.budgetResetsAt, `${label}.budgetResetsAt`);
  }
  return value as unknown as ContactPolicyState;
}

function validateCancellation(
  value: unknown,
  label: string,
): CancellationSignal | undefined {
  if (value === undefined) return undefined;
  requireObject(value, label);
  requireNonEmpty(value.reason, `${label}.reason`);
  requireNonEmpty(value.evidenceRef, `${label}.evidenceRef`);
  return value as unknown as CancellationSignal;
}

function validatePolicyBlock(value: unknown, label: string): PolicyBlock | undefined {
  if (value === undefined) return undefined;
  requireObject(value, label);
  requireNonEmpty(value.reason, `${label}.reason`);
  if (value.evidenceRef !== undefined) requireNonEmpty(value.evidenceRef, `${label}.evidenceRef`);
  return value as unknown as PolicyBlock;
}

function parseSemanticProposal(
  value: unknown,
  label: string,
): SemanticDecisionProposal | undefined {
  if (value === undefined) return undefined;
  requireObject(value, label);
  if (!["contact", "defer", "cancel", "expire", "silent", "resolve"].includes(String(value.action))) {
    throw new InvalidReferenceHostInputError(`${label}.action is unsupported`);
  }
  requireNonEmpty(value.reason, `${label}.reason`);
  for (const key of ["evidenceRefs", "counterEvidenceRefs"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string" || item.length === 0)) {
      throw new InvalidReferenceHostInputError(`${label}.${key} must contain non-empty strings`);
    }
  }
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    throw new InvalidReferenceHostInputError(`${label}.confidence must be between 0 and 1`);
  }
  if (value.nextEvaluationAt !== null) {
    requireTimestamp(value.nextEvaluationAt, `${label}.nextEvaluationAt`);
  }
  if (value.metadata !== undefined) requireObject(value.metadata, `${label}.metadata`);
  return value as unknown as SemanticDecisionProposal;
}

function parseContext(value: unknown, intentId: string): EvaluationContextInput {
  const label = `contexts.${intentId}`;
  requireObject(value, label);
  if (!Array.isArray(value.latestEvents)) {
    throw new InvalidReferenceHostInputError(`${label}.latestEvents must be an array`);
  }
  for (const [index, event] of value.latestEvents.entries()) {
    const result = validateConversationEvent(event);
    if (!result.valid) {
      throw new InvalidReferenceHostInputError(
        `${label}.latestEvents[${index}] is invalid: ${validationDetails(result.errors)}`,
      );
    }
  }
  const userState = validateUserState(value.userState, `${label}.userState`);
  if (value.timeZone !== undefined) requireNonEmpty(value.timeZone, `${label}.timeZone`);
  const cancellation = validateCancellation(value.cancellation, `${label}.cancellation`);
  const policyBlock = validatePolicyBlock(value.policyBlock, `${label}.policyBlock`);
  const semanticProposal = parseSemanticProposal(
    value.semanticProposal,
    `${label}.semanticProposal`,
  );
  const base: EvaluationContextInput = {
    latestEvents: value.latestEvents as ConversationEvent[],
    userState,
    ...(value.timeZone === undefined ? {} : { timeZone: value.timeZone as string }),
    ...(cancellation === undefined ? {} : { cancellation }),
    ...(policyBlock === undefined ? {} : { policyBlock }),
  };
  return semanticProposal === undefined
    ? base
    : {
        ...base,
        semanticProposal,
      };
}

export class ReferenceHostService {
  readonly intentStore: ContactIntentStore;
  readonly outboxStore: JsonOutboxStore;
  readonly eventStore: JsonConversationEventStore | null;
  readonly #conversationRuntime: ConversationRuntime | null;
  #conversationTail: Promise<void> = Promise.resolve();

  private constructor(
    intentStore: ContactIntentStore,
    outboxStore: JsonOutboxStore,
    eventStore: JsonConversationEventStore | null,
    conversationRuntime: ConversationRuntime | null,
  ) {
    this.intentStore = intentStore;
    this.outboxStore = outboxStore;
    this.eventStore = eventStore;
    this.#conversationRuntime = conversationRuntime;
  }

  static async open(options: ReferenceHostServiceOptions): Promise<ReferenceHostService> {
    const [intentStore, outboxStore, eventStore] = await Promise.all([
      openJsonContactIntentStore(options.intentStorePath),
      JsonOutboxStore.open(options.outboxPath),
      options.eventStorePath === undefined
        ? Promise.resolve(null)
        : JsonConversationEventStore.open(options.eventStorePath),
    ]);
    const service = new ReferenceHostService(
      intentStore,
      outboxStore,
      eventStore,
      options.conversationRuntime ?? null,
    );
    await service.reconcile();
    return service;
  }

  async registerIntent(input: RegisterIntentInput) {
    const validation = validateContactIntent(input.intent);
    if (!validation.valid) {
      throw new InvalidReferenceHostInputError(
        `intent is invalid: ${validationDetails(validation.errors)}`,
      );
    }
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (input.nextEvaluationAt !== null) {
      requireTimestamp(input.nextEvaluationAt, "nextEvaluationAt");
    }
    return this.intentStore.createIntent(input);
  }

  async runEvaluation(input: RunEvaluationInput): Promise<RunEvaluationResult> {
    requireTimestamp(input.now, "now");
    requireNonEmpty(input.policyVersion, "policyVersion");
    requireObject(input.contexts, "contexts");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
      throw new InvalidReferenceHostInputError("limit must be a positive integer");
    }

    const due = await this.intentStore.listIntents({
      dueAtOrBefore: input.now,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const contexts = new Map<string, EvaluationContextInput>();
    for (const record of due) {
      if (!Object.hasOwn(input.contexts, record.intent.id)) {
        throw new InvalidReferenceHostInputError(
          `contexts is missing due intent ${record.intent.id}`,
        );
      }
      contexts.set(record.intent.id, parseContext(input.contexts[record.intent.id], record.intent.id));
    }

    const evaluation = await evaluateDueContactIntents({
      store: this.intentStore,
      clock: new FakeClock(input.now),
      policyVersion: input.policyVersion,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      contextProvider: {
        async load(record) {
          const context = contexts.get(record.intent.id);
          if (!context) {
            throw new InvalidReferenceHostInputError(
              `No context is available for ${record.intent.id}`,
            );
          }
          return context;
        },
      },
      semanticReevaluator: {
        async evaluate(semanticInput) {
          const context = contexts.get(semanticInput.intent.id);
          if (!context?.semanticProposal) {
            throw new InvalidReferenceHostInputError(
              `contexts.${semanticInput.intent.id}.semanticProposal is required when semantic evaluation runs`,
            );
          }
          return context.semanticProposal;
        },
      },
    });
    const reconciliation = await this.reconcile();
    return { evaluation, reconciliation };
  }

  async processConversation(
    input: ProcessConversationInput,
  ): Promise<ProcessConversationResult> {
    const pending = this.#conversationTail.then(() => this.#processConversation(input));
    this.#conversationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #processConversation(
    input: ProcessConversationInput,
  ): Promise<ProcessConversationResult> {
    const { eventStore, runtime } = this.#requireConversationCapability();
    requireNonEmpty(input.conversationId, "conversationId");
    requireTimestamp(input.now, "now");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    requireNonEmpty(input.routePolicyVersion, "routePolicyVersion");
    validateTarget(input.target);
    if (
      !Number.isFinite(input.activationThreshold) ||
      input.activationThreshold < 0 ||
      input.activationThreshold > 1
    ) {
      throw new InvalidReferenceHostInputError(
        "activationThreshold must be between 0 and 1",
      );
    }
    if (input.timeZone !== undefined) requireNonEmpty(input.timeZone, "timeZone");
    if (!Array.isArray(input.events) || input.events.length === 0) {
      throw new InvalidReferenceHostInputError("events must be a non-empty array");
    }
    for (const event of input.events) {
      if (event.conversationId !== input.conversationId) {
        throw new InvalidReferenceHostInputError(
          `event ${String(event.id)} does not belong to conversation ${input.conversationId}`,
        );
      }
    }

    const digest = ingestionDigest(input);
    const append = await eventStore.appendBatch({
      events: input.events,
      idempotencyKey: input.idempotencyKey,
      fingerprint: digest,
      acceptedAt: input.now,
    });
    if (append.outcome === "duplicate") {
      if (!append.batch.plan) {
        throw new ConversationEventStoreConflictError(
          `Completed batch ${input.idempotencyKey} has no saved plan`,
        );
      }
      return {
        outcome: "duplicate",
        modelWorkPerformed: false,
        batch: append.batch,
        plan: append.batch.plan,
        registrations: null,
        routing: null,
        modelCalls: emptyModelTelemetry(),
      };
    }

    const telemetryBefore = telemetryLengths(runtime);
    let modelWorkPerformed = false;
    let plan = append.batch.plan;
    if (plan === null) {
      modelWorkPerformed = true;
      const active = await this.intentStore.listIntents({ statuses: ["active"] });
      const routing = await routeConversationEvents({
        intents: active.map((record) => record.intent),
        events: append.events,
        now: input.now,
        router: runtime.relevanceRouter,
      });
      let sequence = 0;
      const extracted = await extractContactIntents({
        events: append.events,
        target: input.target,
        clock: new FakeClock(input.now),
        idGenerator: (kind) => `${kind}:ingestion:${digest}:${++sequence}`,
        generator: runtime.candidateGenerator,
        policy: { activationThreshold: input.activationThreshold },
        ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
      });
      plan = {
        intents: extracted.map((intent) => ({
          ...intent,
          metadata: {
            ...(intent.metadata ?? {}),
            sourceConversationId: input.conversationId,
            sourceIngestionId: digest,
          },
        })),
        selections: routing.selections,
      };
      await eventStore.recordPlan(input.idempotencyKey, plan);
    }

    const registrations = await registerExtractedIntents({
      store: this.intentStore,
      extractionRunId: `ingestion:${digest}`,
      intents: plan.intents,
    });
    const routing = await requestRelevantEvaluations({
      store: this.intentStore,
      events: append.events,
      now: input.now,
      router: {
        async selectRelevant() {
          return plan.selections;
        },
      },
      routeRunId: `ingestion:${digest}`,
      policyVersion: input.routePolicyVersion,
    });
    const batch = await eventStore.completeBatch(input.idempotencyKey, input.now);
    return {
      outcome: append.outcome === "created" ? "created" : "resumed",
      modelWorkPerformed,
      batch,
      plan,
      registrations,
      routing,
      modelCalls: telemetryDelta(runtime, telemetryBefore),
    };
  }

  async runModelEvaluation(
    input: RunModelEvaluationInput,
  ): Promise<RunModelEvaluationResult> {
    const { eventStore, runtime } = this.#requireConversationCapability();
    const telemetryBefore = telemetryLengths(runtime);
    requireTimestamp(input.now, "now");
    requireNonEmpty(input.policyVersion, "policyVersion");
    requireObject(input.userStates, "userStates");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
      throw new InvalidReferenceHostInputError("limit must be a positive integer");
    }
    if (
      input.contextEventLimit !== undefined &&
      (!Number.isInteger(input.contextEventLimit) || input.contextEventLimit <= 0)
    ) {
      throw new InvalidReferenceHostInputError(
        "contextEventLimit must be a positive integer",
      );
    }
    const due = await this.intentStore.listIntents({
      dueAtOrBefore: input.now,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const contexts = new Map<string, DueEvaluationContext>();
    for (const record of due) {
      const conversationId = record.intent.metadata?.sourceConversationId;
      if (typeof conversationId !== "string" || conversationId.length === 0) {
        throw new InvalidReferenceHostInputError(
          `Due intent ${record.intent.id} has no sourceConversationId metadata`,
        );
      }
      const key = targetKey(record.intent.target);
      if (!Object.hasOwn(input.userStates, key)) {
        throw new InvalidReferenceHostInputError(
          `userStates is missing target ${key}`,
        );
      }
      const userState = validateUserState(input.userStates[key], `userStates.${key}`);
      contexts.set(record.intent.id, {
        latestEvents: await eventStore.listEvents({
          conversationId,
          atOrBefore: input.now,
          limit: input.contextEventLimit ?? 100,
        }),
        userState,
      });
    }
    const evaluation = await evaluateDueContactIntents({
      store: this.intentStore,
      clock: new FakeClock(input.now),
      policyVersion: input.policyVersion,
      contextProvider: {
        async load(record) {
          const context = contexts.get(record.intent.id);
          if (!context) {
            throw new InvalidReferenceHostInputError(
              `No persisted context is available for ${record.intent.id}`,
            );
          }
          return context;
        },
      },
      semanticReevaluator: runtime.semanticReevaluator,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.routeClosureThreshold === undefined
        ? {}
        : { routeClosureThreshold: input.routeClosureThreshold }),
    });
    return {
      evaluation,
      reconciliation: await this.reconcile(),
      modelCalls: telemetryDelta(runtime, telemetryBefore),
    };
  }

  async listConversationEvents(conversationId: string): Promise<ConversationEvent[]> {
    const eventStore = this.#requireEventStore();
    requireNonEmpty(conversationId, "conversationId");
    return eventStore.listEvents({ conversationId });
  }

  get conversationCapabilityEnabled(): boolean {
    return this.eventStore !== null && this.#conversationRuntime !== null;
  }

  #requireEventStore(): JsonConversationEventStore {
    if (!this.eventStore) {
      throw new ReferenceHostCapabilityError(
        "Conversation event persistence is not configured for this reference host",
      );
    }
    return this.eventStore;
  }

  #requireConversationCapability(): {
    eventStore: JsonConversationEventStore;
    runtime: ConversationRuntime;
  } {
    const eventStore = this.#requireEventStore();
    if (!this.#conversationRuntime) {
      throw new ReferenceHostCapabilityError(
        "Natural-language processing is not configured for this reference host",
      );
    }
    return { eventStore, runtime: this.#conversationRuntime };
  }

  async reconcile(): Promise<ReconciliationResult> {
    return reconcileContactDecisions(this.intentStore, this.outboxStore);
  }

  async getState(): Promise<ReferenceHostState> {
    const [intents, outbox] = await Promise.all([
      this.intentStore.listIntents(),
      this.outboxStore.listItems(),
    ]);
    return { intents, outbox };
  }

  async listIntents(): Promise<StoredContactIntent[]> {
    return this.intentStore.listIntents();
  }

  async listOutbox(): Promise<OutboxItem[]> {
    return this.outboxStore.listItems();
  }

  async recordReceipt(
    itemId: string,
    receipt: DeliveryReceipt,
  ): Promise<RecordDeliveryReceiptResult> {
    return this.outboxStore.recordReceipt({ itemId, receipt });
  }
}
