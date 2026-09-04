import type { Clock } from "./clock.js";
import type {
  CancellationSignal,
  ContactPolicyState,
  PolicyBlock,
} from "./hard-gates.js";
import {
  ContactIntentStoreConflictError,
  type CommitContactDecisionResult,
  type ContactIntentStore,
  type CreateContactIntentResult,
  type RecordEvaluationFailureResult,
  type StoredContactIntent,
} from "./store.js";
import type {
  ContactDecision,
  ContactIntent,
  ContactIntentEvaluationFailure,
  ContactIntentEvaluationRequest,
  ConversationEvent,
  EvaluationFailureStage,
} from "./types.js";
import {
  reevaluateContactIntent,
  type SemanticReevaluator,
} from "./use-cases.js";

export interface RegisterExtractedIntentsInput {
  store: ContactIntentStore;
  extractionRunId: string;
  intents: ContactIntent[];
}

export interface RegisterExtractedIntentsResult {
  results: CreateContactIntentResult[];
}

export interface DueEvaluationContext {
  latestEvents: ConversationEvent[];
  userState: ContactPolicyState;
  timeZone?: string;
  cancellation?: CancellationSignal;
  policyBlock?: PolicyBlock;
}

export interface DueEvaluationContextProvider {
  load(
    record: StoredContactIntent,
    now: string,
  ): Promise<DueEvaluationContext>;
}

export interface EvaluationIdentity {
  decisionId: string;
  idempotencyKey: string;
}

export type EvaluationIdentityFactory = (
  record: StoredContactIntent,
) => EvaluationIdentity;

export interface EvaluateDueContactIntentsInput {
  store: ContactIntentStore;
  clock: Clock;
  contextProvider: DueEvaluationContextProvider;
  semanticReevaluator: SemanticReevaluator;
  policyVersion: string;
  limit?: number;
  identityFactory?: EvaluationIdentityFactory;
  lateWakePolicy?: LateWakePolicy;
  failureBackoff?: EvaluationFailureBackoffPolicy | false;
  sharedContactBudget?: SharedContactBudgetPolicy;
  routeClosureThreshold?: number;
}

export interface LateWakePolicy {
  maxLatenessMs: number;
  onTooLate: "evaluate" | "silent" | "expire";
  reason?: string;
}

export interface EvaluationFailureBackoffPolicy {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface SharedContactBudgetPolicy {
  maxContactDecisionsPerTarget: number;
  onExhausted: "silent" | "defer";
  deferMs?: number;
  reason?: string;
}

export const DEFAULT_EVALUATION_FAILURE_BACKOFF_POLICY: Readonly<EvaluationFailureBackoffPolicy> = {
  initialDelayMs: 60_000,
  multiplier: 2,
  maxDelayMs: 60 * 60 * 1000,
  maxAttempts: 5,
};

export interface EvaluationWorkStats {
  dueIntents: number;
  contextLoads: number;
  semanticCalls: number;
  hardGateDecisions: number;
  semanticDecisions: number;
  latePolicyDecisions: number;
  routeClosureDecisions: number;
  batchPolicyDecisions: number;
  contactDecisions: number;
  budgetSuppressed: number;
  committed: number;
  duplicates: number;
  conflicts: number;
  failures: number;
  failureRecords: number;
  retriesScheduled: number;
  retriesExhausted: number;
  failureRecordConflicts: number;
  failureRecordFailures: number;
}

export type DueEvaluationItemResult =
  | {
      outcome: "committed" | "duplicate";
      intentId: string;
      previousRevision: number;
      source:
        | "hard-gate"
        | "semantic"
        | "late-policy"
        | "batch-policy"
        | "route-closure";
      decision: ContactDecision;
      commit: CommitContactDecisionResult;
    }
  | {
      outcome: "conflict" | "failed";
      intentId: string;
      previousRevision: number;
      error: Error;
      failureRecord?: RecordEvaluationFailureResult;
      failureRecordError?: Error;
    };

export interface EvaluateDueContactIntentsResult {
  evaluatedAt: string;
  dueCount: number;
  results: DueEvaluationItemResult[];
  work: EvaluationWorkStats;
}

export class InvalidEngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEngineInputError";
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidEngineInputError(`${label} must not be empty`);
  }
}

function assertUniqueIntentIds(intents: ContactIntent[]): void {
  const ids = new Set<string>();
  for (const intent of intents) {
    if (ids.has(intent.id)) {
      throw new InvalidEngineInputError(
        `Extraction result contains duplicate intent id ${intent.id}`,
      );
    }
    ids.add(intent.id);
  }
}

export async function registerExtractedIntents(
  input: RegisterExtractedIntentsInput,
): Promise<RegisterExtractedIntentsResult> {
  requireNonEmpty(input.extractionRunId, "extractionRunId");
  assertUniqueIntentIds(input.intents);
  const results: CreateContactIntentResult[] = [];
  for (const intent of input.intents) {
    const nextEvaluationAt =
      intent.status === "active"
        ? (intent.notBefore ?? intent.createdAt)
        : null;
    results.push(
      await input.store.createIntent({
        intent,
        nextEvaluationAt,
        idempotencyKey: `extraction:${input.extractionRunId}:${intent.id}`,
      }),
    );
  }
  return { results };
}

export function revisionEvaluationIdentity(
  record: StoredContactIntent,
): EvaluationIdentity {
  const operation = `evaluate:${record.intent.id}:revision:${record.revision}`;
  return {
    decisionId: `decision:${operation}`,
    idempotencyKey: operation,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validateLateWakePolicy(policy: LateWakePolicy | undefined): void {
  if (!policy) return;
  if (!Number.isFinite(policy.maxLatenessMs) || policy.maxLatenessMs < 0) {
    throw new InvalidEngineInputError(
      "lateWakePolicy.maxLatenessMs must be a non-negative finite number",
    );
  }
  if (policy.reason !== undefined && policy.reason.trim().length === 0) {
    throw new InvalidEngineInputError("lateWakePolicy.reason must not be empty");
  }
  if (!["evaluate", "silent", "expire"].includes(policy.onTooLate)) {
    throw new InvalidEngineInputError(
      "lateWakePolicy.onTooLate must be evaluate, silent, or expire",
    );
  }
}

function validateFailureBackoffPolicy(
  policy: EvaluationFailureBackoffPolicy | false | undefined,
): void {
  if (policy === undefined || policy === false) return;
  if (!Number.isFinite(policy.initialDelayMs) || policy.initialDelayMs <= 0) {
    throw new InvalidEngineInputError(
      "failureBackoff.initialDelayMs must be a positive finite number",
    );
  }
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 1) {
    throw new InvalidEngineInputError(
      "failureBackoff.multiplier must be a finite number at least 1",
    );
  }
  if (
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs <= 0 ||
    policy.maxDelayMs < policy.initialDelayMs
  ) {
    throw new InvalidEngineInputError(
      "failureBackoff.maxDelayMs must be finite and at least initialDelayMs",
    );
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0) {
    throw new InvalidEngineInputError(
      "failureBackoff.maxAttempts must be a positive integer",
    );
  }
}

function validateSharedContactBudgetPolicy(
  policy: SharedContactBudgetPolicy | undefined,
): void {
  if (!policy) return;
  if (
    !Number.isInteger(policy.maxContactDecisionsPerTarget) ||
    policy.maxContactDecisionsPerTarget <= 0
  ) {
    throw new InvalidEngineInputError(
      "sharedContactBudget.maxContactDecisionsPerTarget must be a positive integer",
    );
  }
  if (!['silent', 'defer'].includes(policy.onExhausted)) {
    throw new InvalidEngineInputError(
      "sharedContactBudget.onExhausted must be silent or defer",
    );
  }
  if (
    policy.deferMs !== undefined &&
    (!Number.isFinite(policy.deferMs) || policy.deferMs <= 0)
  ) {
    throw new InvalidEngineInputError(
      "sharedContactBudget.deferMs must be a positive finite number",
    );
  }
  if (policy.reason !== undefined && policy.reason.trim().length === 0) {
    throw new InvalidEngineInputError(
      "sharedContactBudget.reason must not be empty",
    );
  }
}

function contactBudgetKey(intent: ContactIntent): string {
  return `${intent.target.kind}:${intent.target.id}`;
}

function suppressContactDecision(
  decision: ContactDecision,
  evaluatedAtMs: number,
  policy: SharedContactBudgetPolicy,
): ContactDecision {
  const action = policy.onExhausted;
  return {
    ...decision,
    action,
    reason:
      policy.reason ??
      (action === "defer"
        ? "Another contact for this target already consumed the shared contact budget, so this follow-up is deferred."
        : "Another contact for this target already consumed the shared contact budget, so this follow-up stays silent."),
    confidence: 1,
    nextEvaluationAt:
      action === "defer"
        ? new Date(evaluatedAtMs + (policy.deferMs ?? 15 * 60 * 1000)).toISOString()
        : null,
    metadata: {
      ...(decision.metadata ?? {}),
      source: "shared-contact-budget",
      suppressedAction: "contact",
      originalReason: decision.reason,
      maxContactDecisionsPerTarget: policy.maxContactDecisionsPerTarget,
    },
  };
}

function sanitizedFailureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name)
    ? name
    : "EvaluationError";
}

function failureDelayMs(
  policy: EvaluationFailureBackoffPolicy,
  attempt: number,
): number {
  return Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * policy.multiplier ** (attempt - 1),
  );
}

function makeLatePolicyDecision(
  record: StoredContactIntent,
  identity: EvaluationIdentity,
  evaluatedAt: string,
  policyVersion: string,
  policy: LateWakePolicy,
  latenessMs: number,
): ContactDecision {
  if (policy.onTooLate === "evaluate") {
    throw new InvalidEngineInputError(
      "An evaluate late-wake policy does not create a decision",
    );
  }
  return {
    id: identity.decisionId,
    intentId: record.intent.id,
    evaluatedAt,
    action: policy.onTooLate,
    reason:
      policy.reason ??
      (policy.onTooLate === "expire"
        ? "The intended contact window is too stale to remain useful."
        : "The intended contact window is too stale to justify interrupting the user."),
    evidenceRefs: record.intent.evidence.map((item) => item.eventId),
    counterEvidenceRefs: [],
    confidence: 1,
    nextEvaluationAt: null,
    policyVersion,
    metadata: {
      source: "deterministic-late-wake-policy",
      latenessMs,
      maxLatenessMs: policy.maxLatenessMs,
    },
  };
}

function makeRouteClosureDecision(
  record: StoredContactIntent,
  identity: EvaluationIdentity,
  evaluatedAt: string,
  policyVersion: string,
  request: ContactIntentEvaluationRequest,
): ContactDecision {
  if (request.effect !== "cancel" && request.effect !== "resolve") {
    throw new InvalidEngineInputError(
      "Only cancel or resolve route effects can create a closure decision",
    );
  }
  return {
    id: identity.decisionId,
    intentId: record.intent.id,
    evaluatedAt,
    action: request.effect,
    reason: request.reason,
    evidenceRefs: record.intent.evidence.map((item) => item.eventId),
    counterEvidenceRefs: [...request.eventIds],
    confidence: request.confidence,
    nextEvaluationAt: null,
    policyVersion,
    metadata: {
      source: "relevance-route-closure",
      evaluationRequestId: request.id,
      routePolicyVersion: request.policyVersion,
    },
  };
}

export async function evaluateDueContactIntents(
  input: EvaluateDueContactIntentsInput,
): Promise<EvaluateDueContactIntentsResult> {
  requireNonEmpty(input.policyVersion, "policyVersion");
  if (
    input.limit !== undefined &&
    (!Number.isInteger(input.limit) || input.limit <= 0)
  ) {
    throw new InvalidEngineInputError("limit must be a positive integer");
  }
  validateLateWakePolicy(input.lateWakePolicy);
  validateFailureBackoffPolicy(input.failureBackoff);
  validateSharedContactBudgetPolicy(input.sharedContactBudget);
  if (
    input.routeClosureThreshold !== undefined &&
    (!Number.isFinite(input.routeClosureThreshold) ||
      input.routeClosureThreshold < 0 ||
      input.routeClosureThreshold > 1)
  ) {
    throw new InvalidEngineInputError(
      "routeClosureThreshold must be between 0 and 1",
    );
  }
  const evaluatedAt = input.clock.now().toISOString();
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const due = await input.store.listIntents({
    dueAtOrBefore: evaluatedAt,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const results: DueEvaluationItemResult[] = [];
  const work: EvaluationWorkStats = {
    dueIntents: due.length,
    contextLoads: 0,
    semanticCalls: 0,
    hardGateDecisions: 0,
    semanticDecisions: 0,
    latePolicyDecisions: 0,
    routeClosureDecisions: 0,
    batchPolicyDecisions: 0,
    contactDecisions: 0,
    budgetSuppressed: 0,
    committed: 0,
    duplicates: 0,
    conflicts: 0,
    failures: 0,
    failureRecords: 0,
    retriesScheduled: 0,
    retriesExhausted: 0,
    failureRecordConflicts: 0,
    failureRecordFailures: 0,
  };
  const identityFactory = input.identityFactory ?? revisionEvaluationIdentity;
  const failureBackoff = input.failureBackoff === false
    ? null
    : (input.failureBackoff ?? DEFAULT_EVALUATION_FAILURE_BACKOFF_POLICY);
  const contactsByTarget = new Map<string, number>();
  const routeClosureThreshold = input.routeClosureThreshold ?? 0.9;

  // Alpha intentionally evaluates sequentially to keep cost and rate pressure bounded.
  for (const record of due) {
    let failureStage: EvaluationFailureStage = "evaluation";
    let mayRecordFailure = true;
    try {
      const identity = identityFactory(record);
      requireNonEmpty(identity.decisionId, "decisionId");
      requireNonEmpty(identity.idempotencyKey, "evaluation idempotencyKey");
      const auditEvents = await input.store.listAuditEvents(record.intent.id);
      const latestAuditEvent = auditEvents.at(-1);
      if (
        latestAuditEvent?.kind === "evaluation-requested" &&
        (latestAuditEvent.request.effect === "cancel" ||
          latestAuditEvent.request.effect === "resolve") &&
        latestAuditEvent.request.confidence >= routeClosureThreshold
      ) {
        const decision = makeRouteClosureDecision(
          record,
          identity,
          evaluatedAt,
          input.policyVersion,
          latestAuditEvent.request,
        );
        mayRecordFailure = false;
        const commit = await input.store.commitDecision({
          intentId: record.intent.id,
          expectedRevision: record.revision,
          decision,
          idempotencyKey: identity.idempotencyKey,
        });
        work.routeClosureDecisions += 1;
        work[commit.outcome === "committed" ? "committed" : "duplicates"] += 1;
        results.push({
          outcome: commit.outcome,
          intentId: record.intent.id,
          previousRevision: record.revision,
          source: "route-closure",
          decision,
          commit,
        });
        continue;
      }
      const scheduledAtMs = Date.parse(record.nextEvaluationAt!);
      const latenessMs = evaluatedAtMs - scheduledAtMs;
      const alreadyExpired =
        record.intent.expiresAt !== null &&
        evaluatedAtMs >= Date.parse(record.intent.expiresAt);
      if (
        input.lateWakePolicy &&
        input.lateWakePolicy.onTooLate !== "evaluate" &&
        latenessMs > input.lateWakePolicy.maxLatenessMs &&
        !alreadyExpired
      ) {
        const decision = makeLatePolicyDecision(
          record,
          identity,
          evaluatedAt,
          input.policyVersion,
          input.lateWakePolicy,
          latenessMs,
        );
        mayRecordFailure = false;
        const commit = await input.store.commitDecision({
          intentId: record.intent.id,
          expectedRevision: record.revision,
          decision,
          idempotencyKey: identity.idempotencyKey,
        });
        work.latePolicyDecisions += 1;
        work[commit.outcome === "committed" ? "committed" : "duplicates"] += 1;
        results.push({
          outcome: commit.outcome,
          intentId: record.intent.id,
          previousRevision: record.revision,
          source: "late-policy",
          decision,
          commit,
        });
        continue;
      }

      work.contextLoads += 1;
      failureStage = "context";
      const context = await input.contextProvider.load(record, evaluatedAt);
      failureStage = "evaluation";
      const reevaluation = await reevaluateContactIntent({
        intent: record.intent,
        latestEvents: context.latestEvents,
        clock: input.clock,
        idGenerator: (kind) => {
          if (kind !== "decision") {
            throw new InvalidEngineInputError(
              `Due evaluation unexpectedly requested a ${kind} id`,
            );
          }
          return identity.decisionId;
        },
        policyVersion: input.policyVersion,
        userState: context.userState,
        semanticReevaluator: {
          async evaluate(semanticInput) {
            work.semanticCalls += 1;
            failureStage = "semantic";
            const proposal = await input.semanticReevaluator.evaluate(semanticInput);
            failureStage = "evaluation";
            return proposal;
          },
        },
        evaluationTrigger:
          latestAuditEvent?.kind === "evaluation-requested"
            ? "context-change"
            : "scheduled",
        ...(context.timeZone ? { timeZone: context.timeZone } : {}),
        ...(context.cancellation ? { cancellation: context.cancellation } : {}),
        ...(context.policyBlock ? { policyBlock: context.policyBlock } : {}),
      });
      let decision = reevaluation.decision;
      let source: "hard-gate" | "semantic" | "batch-policy" =
        reevaluation.source;
      const targetKey = contactBudgetKey(record.intent);
      if (
        decision.action === "contact" &&
        input.sharedContactBudget &&
        (contactsByTarget.get(targetKey) ?? 0) >=
          input.sharedContactBudget.maxContactDecisionsPerTarget
      ) {
        decision = suppressContactDecision(
          decision,
          evaluatedAtMs,
          input.sharedContactBudget,
        );
        source = "batch-policy";
        work.batchPolicyDecisions += 1;
        work.budgetSuppressed += 1;
      }
      mayRecordFailure = false;
      const commit = await input.store.commitDecision({
        intentId: record.intent.id,
        expectedRevision: record.revision,
        decision,
        idempotencyKey: identity.idempotencyKey,
      });
      work[reevaluation.source === "hard-gate" ? "hardGateDecisions" : "semanticDecisions"] += 1;
      work[commit.outcome === "committed" ? "committed" : "duplicates"] += 1;
      if (decision.action === "contact") {
        contactsByTarget.set(targetKey, (contactsByTarget.get(targetKey) ?? 0) + 1);
        work.contactDecisions += 1;
      }
      results.push({
        outcome: commit.outcome,
        intentId: record.intent.id,
        previousRevision: record.revision,
        source,
        decision,
        commit,
      });
    } catch (error) {
      const isConflict = error instanceof ContactIntentStoreConflictError;
      work[isConflict ? "conflicts" : "failures"] += 1;
      const failedResult: Extract<DueEvaluationItemResult, { outcome: "failed" | "conflict" }> = {
        outcome: isConflict ? "conflict" : "failed",
        intentId: record.intent.id,
        previousRevision: record.revision,
        error: asError(error),
      };
      if (!isConflict && mayRecordFailure && failureBackoff) {
        try {
          const events = await input.store.listAuditEvents(record.intent.id);
          let priorFailures = 0;
          for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index]?.kind !== "evaluation-failed") break;
            priorFailures += 1;
          }
          const attempt = priorFailures + 1;
          const exhausted = attempt >= failureBackoff.maxAttempts;
          const failure: ContactIntentEvaluationFailure = {
            id: `failure:evaluate:${record.intent.id}:revision:${record.revision}`,
            intentId: record.intent.id,
            failedAt: evaluatedAt,
            stage: failureStage,
            code: sanitizedFailureCode(error),
            attempt,
            exhausted,
            nextEvaluationAt: exhausted
              ? null
              : new Date(
                  evaluatedAtMs + failureDelayMs(failureBackoff, attempt),
                ).toISOString(),
            policyVersion: input.policyVersion,
          };
          const failureRecord = await input.store.recordEvaluationFailure({
            intentId: record.intent.id,
            expectedRevision: record.revision,
            failure,
            idempotencyKey: `record:${failure.id}`,
          });
          failedResult.failureRecord = failureRecord;
          work.failureRecords += 1;
          work[exhausted ? "retriesExhausted" : "retriesScheduled"] += 1;
        } catch (failureRecordError) {
          failedResult.failureRecordError = asError(failureRecordError);
          work[
            failureRecordError instanceof ContactIntentStoreConflictError
              ? "failureRecordConflicts"
              : "failureRecordFailures"
          ] += 1;
        }
      }
      results.push(failedResult);
    }
  }

  return { evaluatedAt, dueCount: due.length, results, work };
}
