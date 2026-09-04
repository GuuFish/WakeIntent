import {
  FakeClock,
  evaluateDueContactIntents,
  type CancellationSignal,
  type ContactIntent,
  type ContactIntentStore,
  type ContactPolicyState,
  type ConversationEvent,
  type DueEvaluationContext,
  type EvaluateDueContactIntentsResult,
  type PolicyBlock,
  type SemanticDecisionProposal,
  type StoredContactIntent,
} from "@wakeintent/core";
import {
  validateContactIntent,
  validateConversationEvent,
} from "@wakeintent/schemas";
import { openJsonContactIntentStore } from "@wakeintent/store-json";

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
}

export class InvalidReferenceHostInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceHostInputError";
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

  private constructor(
    intentStore: ContactIntentStore,
    outboxStore: JsonOutboxStore,
  ) {
    this.intentStore = intentStore;
    this.outboxStore = outboxStore;
  }

  static async open(options: ReferenceHostServiceOptions): Promise<ReferenceHostService> {
    const [intentStore, outboxStore] = await Promise.all([
      openJsonContactIntentStore(options.intentStorePath),
      JsonOutboxStore.open(options.outboxPath),
    ]);
    const service = new ReferenceHostService(intentStore, outboxStore);
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
