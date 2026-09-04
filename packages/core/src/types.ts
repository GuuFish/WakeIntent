export type IntentStatus =
  | "candidate"
  | "active"
  | "resolved"
  | "cancelled"
  | "expired";

export type DecisionAction =
  | "contact"
  | "defer"
  | "cancel"
  | "expire"
  | "silent"
  | "resolve";

export interface ConversationEvent {
  id: string;
  conversationId: string;
  actor: "user" | "assistant" | "system" | "tool";
  participantId?: string;
  occurredAt: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface EvidenceRef {
  eventId: string;
  quote?: string;
}

export interface ContactTarget {
  kind: "user" | "conversation" | "participant";
  id: string;
}

export interface ContactIntent {
  schemaVersion: "0.1.0";
  id: string;
  status: IntentStatus;
  subject: string;
  reason: string;
  target: ContactTarget;
  evidence: EvidenceRef[];
  notBefore: string | null;
  expiresAt: string | null;
  cancellationHints: string[];
  priority: number;
  interruptionCost: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ContactDecision {
  id: string;
  intentId: string;
  evaluatedAt: string;
  action: DecisionAction;
  reason: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  confidence: number;
  nextEvaluationAt: string | null;
  policyVersion: string;
  metadata?: Record<string, unknown>;
}

export interface ContactIntentActivation {
  id: string;
  intentId: string;
  activatedAt: string;
  reason: string;
  evidenceRefs: string[];
  nextEvaluationAt: string;
  policyVersion: string;
  metadata?: Record<string, unknown>;
}

export type EvaluationFailureStage = "context" | "semantic" | "evaluation";

export interface ContactIntentEvaluationFailure {
  id: string;
  intentId: string;
  failedAt: string;
  stage: EvaluationFailureStage;
  code: string;
  attempt: number;
  exhausted: boolean;
  nextEvaluationAt: string | null;
  policyVersion: string;
  metadata?: Record<string, unknown>;
}

export interface ContactIntentEvaluationRequest {
  id: string;
  intentId: string;
  requestedAt: string;
  eventIds: string[];
  effect: "reevaluate" | "cancel" | "resolve";
  reason: string;
  confidence: number;
  nextEvaluationAt: string;
  policyVersion: string;
  metadata?: Record<string, unknown>;
}

export type ContactIntentAuditEvent =
  | { kind: "activated"; activation: ContactIntentActivation }
  | { kind: "decision"; decision: ContactDecision }
  | { kind: "evaluation-failed"; failure: ContactIntentEvaluationFailure }
  | { kind: "evaluation-requested"; request: ContactIntentEvaluationRequest };
