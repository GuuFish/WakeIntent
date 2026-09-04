import type { Clock } from "./clock.js";
import {
  evaluateContactEligibilityGates,
  evaluateValidityGates,
  type CancellationSignal,
  type ContactPolicyState,
  type PolicyBlock,
} from "./hard-gates.js";
import { applyDecision } from "./lifecycle.js";
import type {
  ContactDecision,
  ContactIntent,
  ContactTarget,
  ConversationEvent,
  DecisionAction,
  EvidenceRef,
} from "./types.js";

export type IdKind = "intent" | "decision" | "policy-signal";
export type IdGenerator = (kind: IdKind) => string;

export interface CandidateDraft {
  subject: string;
  reason: string;
  evidence: EvidenceRef[];
  notBefore: string | null;
  expiresAt: string | null;
  cancellationHints: string[];
  priority: number;
  interruptionCost: number;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface CandidateGenerationInput {
  events: ConversationEvent[];
  target: ContactTarget;
  now: string;
  timeZone?: string;
}

export interface CandidateGenerator {
  generate(input: CandidateGenerationInput): Promise<CandidateDraft[]>;
}

export interface ExtractionPolicy {
  activationThreshold: number;
}

export interface ExtractContactIntentsInput {
  events: ConversationEvent[];
  target: ContactTarget;
  clock: Clock;
  idGenerator: IdGenerator;
  generator: CandidateGenerator;
  policy: ExtractionPolicy;
  timeZone?: string;
}

export interface SemanticDecisionProposal {
  action: DecisionAction;
  reason: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  confidence: number;
  nextEvaluationAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface SemanticReevaluationInput {
  intent: ContactIntent;
  latestEvents: ConversationEvent[];
  now: string;
  trigger?: "scheduled" | "context-change";
  timeZone?: string;
}

export interface SemanticReevaluator {
  evaluate(input: SemanticReevaluationInput): Promise<SemanticDecisionProposal>;
}

export interface ReevaluateContactIntentInput {
  intent: ContactIntent;
  latestEvents: ConversationEvent[];
  clock: Clock;
  idGenerator: IdGenerator;
  policyVersion: string;
  timeZone?: string;
  userState: ContactPolicyState;
  semanticReevaluator: SemanticReevaluator;
  cancellation?: CancellationSignal;
  policyBlock?: PolicyBlock;
  evaluationTrigger?: "scheduled" | "context-change";
}

export interface ReevaluationResult {
  source: "hard-gate" | "semantic";
  decision: ContactDecision;
  intent: ContactIntent;
}

export class InvalidUseCaseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUseCaseInputError";
  }
}

function assertUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidUseCaseInputError(`${label} must be between 0 and 1`);
  }
}

function parseOptionalInstant(value: string | null, label: string): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new InvalidUseCaseInputError(`${label} must be a valid date-time`);
  }
  return parsed;
}

function validateEvidence(
  evidence: EvidenceRef[],
  allowedEventIds: ReadonlySet<string>,
): void {
  if (evidence.length === 0) {
    throw new InvalidUseCaseInputError("A ContactIntent requires evidence");
  }
  for (const item of evidence) {
    if (!allowedEventIds.has(item.eventId)) {
      throw new InvalidUseCaseInputError(
        `Evidence references unknown event ${item.eventId}`,
      );
    }
  }
}

function validateDraft(
  draft: CandidateDraft,
  allowedEventIds: ReadonlySet<string>,
): void {
  if (draft.subject.trim().length === 0 || draft.reason.trim().length === 0) {
    throw new InvalidUseCaseInputError("Candidate subject and reason are required");
  }
  validateEvidence(draft.evidence, allowedEventIds);
  assertUnitInterval(draft.priority, "priority");
  assertUnitInterval(draft.interruptionCost, "interruptionCost");
  assertUnitInterval(draft.confidence, "confidence");

  const notBefore = parseOptionalInstant(draft.notBefore, "notBefore");
  const expiresAt = parseOptionalInstant(draft.expiresAt, "expiresAt");
  if (notBefore !== null && expiresAt !== null && expiresAt <= notBefore) {
    throw new InvalidUseCaseInputError("expiresAt must be later than notBefore");
  }
}

export async function extractContactIntents(
  input: ExtractContactIntentsInput,
): Promise<ContactIntent[]> {
  assertUnitInterval(input.policy.activationThreshold, "activationThreshold");
  const now = input.clock.now().toISOString();
  const allowedEventIds = new Set(input.events.map((event) => event.id));
  if (allowedEventIds.size !== input.events.length) {
    throw new InvalidUseCaseInputError("Conversation event ids must be unique");
  }

  const drafts = await input.generator.generate({
    events: input.events,
    target: input.target,
    now,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });

  return drafts.map((draft) => {
    validateDraft(draft, allowedEventIds);
    const base: ContactIntent = {
      schemaVersion: "0.1.0",
      id: input.idGenerator("intent"),
      status:
        draft.confidence >= input.policy.activationThreshold
          ? "active"
          : "candidate",
      subject: draft.subject,
      reason: draft.reason,
      target: input.target,
      evidence: draft.evidence,
      notBefore: draft.notBefore,
      expiresAt: draft.expiresAt,
      cancellationHints: draft.cancellationHints,
      priority: draft.priority,
      interruptionCost: draft.interruptionCost,
      confidence: draft.confidence,
      createdAt: now,
      updatedAt: now,
    };
    return draft.metadata ? { ...base, metadata: draft.metadata } : base;
  });
}

function validateSemanticProposal(
  proposal: SemanticDecisionProposal,
  allowedEventIds: ReadonlySet<string>,
  now: number,
): void {
  if (proposal.reason.trim().length === 0) {
    throw new InvalidUseCaseInputError("Semantic decision reason is required");
  }
  assertUnitInterval(proposal.confidence, "decision confidence");

  for (const eventId of [
    ...proposal.evidenceRefs,
    ...proposal.counterEvidenceRefs,
  ]) {
    if (!allowedEventIds.has(eventId)) {
      throw new InvalidUseCaseInputError(
        `Semantic decision references unknown event ${eventId}`,
      );
    }
  }

  if (proposal.action === "defer") {
    if (proposal.nextEvaluationAt === null) {
      throw new InvalidUseCaseInputError(
        "A defer decision requires nextEvaluationAt",
      );
    }
    const next = parseOptionalInstant(
      proposal.nextEvaluationAt,
      "nextEvaluationAt",
    );
    if (next === null || next <= now) {
      throw new InvalidUseCaseInputError(
        "nextEvaluationAt must be later than the evaluation time",
      );
    }
  }
}

function mergeEvidenceRefs(
  decision: ContactDecision,
  proposal: SemanticDecisionProposal,
): ContactDecision {
  return {
    ...decision,
    evidenceRefs: [...new Set([...decision.evidenceRefs, ...proposal.evidenceRefs])],
    counterEvidenceRefs: [
      ...new Set([
        ...decision.counterEvidenceRefs,
        ...proposal.counterEvidenceRefs,
      ]),
    ],
  };
}

function mergeEligibilityAndSemanticDecision(
  eligibility: ContactDecision,
  proposal: SemanticDecisionProposal,
): ContactDecision {
  const merged = mergeEvidenceRefs(eligibility, proposal);
  const nextEvaluationAt =
    eligibility.action === "defer" &&
    proposal.action === "defer" &&
    eligibility.nextEvaluationAt !== null &&
    proposal.nextEvaluationAt !== null
      ? new Date(
          Math.max(
            Date.parse(eligibility.nextEvaluationAt),
            Date.parse(proposal.nextEvaluationAt),
          ),
        ).toISOString()
      : eligibility.nextEvaluationAt;
  return {
    ...merged,
    nextEvaluationAt,
    metadata: {
      ...(merged.metadata ?? {}),
      semanticProposalAction: proposal.action,
      ...(proposal.nextEvaluationAt
        ? { semanticProposalNextEvaluationAt: proposal.nextEvaluationAt }
        : {}),
    },
  };
}

export async function reevaluateContactIntent(
  input: ReevaluateContactIntentInput,
): Promise<ReevaluationResult> {
  if (input.intent.status !== "active") {
    throw new InvalidUseCaseInputError(
      `Only active intents can be reevaluated; received ${input.intent.status}`,
    );
  }

  const now = input.clock.now();
  const decisionId = input.idGenerator("decision");
  const gateContext = {
    decisionId,
    policyVersion: input.policyVersion,
    now,
    userState: input.userState,
    ...(input.cancellation ? { cancellation: input.cancellation } : {}),
    ...(input.policyBlock ? { policyBlock: input.policyBlock } : {}),
  };
  const validityGate = evaluateValidityGates(input.intent, gateContext);
  if (validityGate.outcome === "decided") {
    return {
      source: "hard-gate",
      decision: validityGate.decision,
      intent: applyDecision(input.intent, validityGate.decision),
    };
  }
  const eligibilityGate = evaluateContactEligibilityGates(
    input.intent,
    gateContext,
  );

  const canCheckForSemanticChange =
    eligibilityGate.outcome === "decided" &&
    input.latestEvents.length > 0;

  if (eligibilityGate.outcome === "decided" && !canCheckForSemanticChange) {
    return {
      source: "hard-gate",
      decision: eligibilityGate.decision,
      intent: applyDecision(input.intent, eligibilityGate.decision),
    };
  }

  const proposal = await input.semanticReevaluator.evaluate({
    intent: input.intent,
    latestEvents: input.latestEvents,
    now: now.toISOString(),
    trigger: input.evaluationTrigger ?? "scheduled",
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });
  const allowedEventIds = new Set([
    ...input.intent.evidence.map((item) => item.eventId),
    ...input.latestEvents.map((event) => event.id),
  ]);
  validateSemanticProposal(proposal, allowedEventIds, now.getTime());

  const semanticClosureActions = new Set<DecisionAction>([
    "cancel",
    "expire",
    "resolve",
  ]);
  if (
    eligibilityGate.outcome === "decided" &&
    !semanticClosureActions.has(proposal.action)
  ) {
    const decision = mergeEligibilityAndSemanticDecision(
      eligibilityGate.decision,
      proposal,
    );
    return {
      source: "hard-gate",
      decision,
      intent: applyDecision(input.intent, decision),
    };
  }

  const decisionBase: ContactDecision = {
    id: decisionId,
    intentId: input.intent.id,
    evaluatedAt: now.toISOString(),
    action: proposal.action,
    reason: proposal.reason,
    evidenceRefs: proposal.evidenceRefs,
    counterEvidenceRefs: proposal.counterEvidenceRefs,
    confidence: proposal.confidence,
    nextEvaluationAt: proposal.nextEvaluationAt,
    policyVersion: input.policyVersion,
  };
  const decision = proposal.metadata
    ? { ...decisionBase, metadata: proposal.metadata }
    : decisionBase;

  return {
    source: "semantic",
    decision,
    intent: applyDecision(input.intent, decision),
  };
}
