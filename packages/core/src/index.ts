export { FakeClock, SystemClock } from "./clock.js";
export type { Clock } from "./clock.js";
export {
  evaluateDueContactIntents,
  DEFAULT_EVALUATION_FAILURE_BACKOFF_POLICY,
  InvalidEngineInputError,
  registerExtractedIntents,
  revisionEvaluationIdentity,
} from "./engine.js";
export type {
  DueEvaluationContext,
  DueEvaluationContextProvider,
  DueEvaluationItemResult,
  EvaluateDueContactIntentsInput,
  EvaluateDueContactIntentsResult,
  EvaluationIdentity,
  EvaluationIdentityFactory,
  EvaluationFailureBackoffPolicy,
  EvaluationWorkStats,
  LateWakePolicy,
  RegisterExtractedIntentsInput,
  RegisterExtractedIntentsResult,
  SharedContactBudgetPolicy,
} from "./engine.js";
export { planNextWakeup } from "./scheduler.js";
export type {
  PlanNextWakeupInput,
  WakeupPlan,
} from "./scheduler.js";
export {
  InvalidRelevanceRouteError,
  requestRelevantEvaluations,
  routeConversationEvents,
} from "./routing.js";
export {
  buildEvaluationRunTrace,
  InvalidTelemetryInputError,
  summarizeModelUsage,
} from "./telemetry.js";
export type {
  BuildEvaluationRunTraceInput,
  EvaluationRunTrace,
  EvaluationTraceItem,
  ModelCallTelemetryRecord,
  ModelUsageTotals,
} from "./telemetry.js";
export type {
  RelevanceEffect,
  RelevanceRouter,
  RelevanceRoutingInput,
  RelevanceRoutingSelection,
  RequestRelevantEvaluationItem,
  RequestRelevantEvaluationsInput,
  RequestRelevantEvaluationsResult,
  RouteConversationEventsInput,
  RouteConversationEventsResult,
  RoutedContactIntent,
} from "./routing.js";
export {
  evaluateContactEligibilityGates,
  evaluateHardGates,
  evaluateValidityGates,
  InvalidHardGateInputError,
} from "./hard-gates.js";
export type {
  AuthorizationStatus,
  CancellationSignal,
  ContactPolicyState,
  HardGateContext,
  HardGateResult,
  PolicyBlock,
} from "./hard-gates.js";
export {
  activateIntent,
  applyDecision,
  InvalidIntentTransitionError,
} from "./lifecycle.js";
export {
  ContactIntentNotFoundError,
  ContactIntentStoreConflictError,
  IdempotencyConflictError,
  InMemoryContactIntentStore,
  InvalidStoreInputError,
} from "./store.js";
export type {
  ActivateContactIntentInput,
  ActivateContactIntentResult,
  CommitContactDecisionInput,
  CommitContactDecisionResult,
  ContactIntentQuery,
  ContactIntentStore,
  ContactIntentStoreSnapshot,
  CreateContactIntentInput,
  CreateContactIntentResult,
  RecordEvaluationFailureInput,
  RecordEvaluationFailureResult,
  RequestContactIntentEvaluationInput,
  RequestContactIntentEvaluationResult,
  StoredContactIntent,
  StoreIdempotencyEntry,
} from "./store.js";
export {
  applyContactPolicySignals,
  InvalidContactPolicySignalError,
} from "./policy-signals.js";
export {
  extractContactPolicySignals,
  InvalidPolicySignalExtractionError,
} from "./policy-extraction.js";
export type {
  ClearDoNotDisturbDraft,
  ContactPolicySignalDraft,
  ExtractContactPolicySignalsInput,
  PolicySignalGenerationInput,
  PolicySignalGenerator,
  SetAuthorizationDraft,
  SetDoNotDisturbDraft,
} from "./policy-extraction.js";
export type {
  ApplyContactPolicySignalsInput,
  ApplyContactPolicySignalsResult,
  ClearDoNotDisturbSignal,
  ContactPolicySignal,
  ContactPolicySignalAudit,
  ContactPolicySnapshot,
  SetAuthorizationSignal,
  SetDoNotDisturbSignal,
} from "./policy-signals.js";
export {
  extractContactIntents,
  InvalidUseCaseInputError,
  reevaluateContactIntent,
} from "./use-cases.js";
export type {
  CandidateDraft,
  CandidateGenerationInput,
  CandidateGenerator,
  ExtractContactIntentsInput,
  ExtractionPolicy,
  IdGenerator,
  IdKind,
  ReevaluateContactIntentInput,
  ReevaluationResult,
  SemanticDecisionProposal,
  SemanticReevaluationInput,
  SemanticReevaluator,
} from "./use-cases.js";
export type {
  ContactDecision,
  ContactIntentActivation,
  ContactIntentAuditEvent,
  ContactIntentEvaluationFailure,
  ContactIntentEvaluationRequest,
  ContactIntent,
  ContactTarget,
  ConversationEvent,
  DecisionAction,
  EvidenceRef,
  EvaluationFailureStage,
  IntentStatus,
} from "./types.js";
