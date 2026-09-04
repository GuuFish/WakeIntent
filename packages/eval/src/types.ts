import type {
  ContactPolicyState,
  ContactTarget,
  ConversationEvent,
  DecisionAction,
  IntentStatus,
} from "@wakeintent/core";
import type { ModelCallRecord } from "@wakeintent/model-openai-compatible";

export type EvalAction = DecisionAction | "none";
export type EvalIntentStatus = IntentStatus | "none";
export type EvalSystem = "wakeintent" | "memory-heartbeat";

export interface EvalExpectation {
  allowedIntentStatuses: EvalIntentStatus[];
  primaryAction: EvalAction;
  allowedActions: EvalAction[];
  requiredEvidenceRefs: string[];
  annotation: string;
}

export interface EvalScenario {
  schemaVersion: "0.1.0";
  id: string;
  category: string;
  language: string;
  timeZone: string;
  initialEvents: ConversationEvent[];
  latestEvents: ConversationEvent[];
  evaluationTime: string;
  target: ContactTarget;
  userState: ContactPolicyState;
  expected: EvalExpectation;
}

export interface EvalDataset {
  schemaVersion: "0.1.0";
  name: string;
  version: string;
  kind: "development-fixtures" | "frozen-test-set";
  scenarios: EvalScenario[];
}

export interface EvalPrediction {
  system: EvalSystem;
  scenarioId: string;
  createdIntentStatus: EvalIntentStatus;
  candidateCount: number;
  action: EvalAction;
  reason: string;
  evidenceRefs: string[];
  confidence: number;
  modelCalls: number;
  latencyMs: number;
  error: string | null;
  modelCallRecords: ModelCallRecord[];
  artifacts: Record<string, unknown>;
}

export interface PredictionScore {
  creationCorrect: boolean;
  actionCorrect: boolean;
  evidenceCorrect: boolean;
  passed: boolean;
}

export interface ScoredPrediction {
  scenario: EvalScenario;
  prediction: EvalPrediction;
  score: PredictionScore;
}

export interface AggregateMetrics {
  total: number;
  passed: number;
  passRate: number;
  creationAccuracy: number;
  actionAccuracy: number;
  evidenceAccuracy: number;
  falseOutreachRate: number;
  effectiveContactPrecision: number;
  averageModelCalls: number;
  averageLatencyMs: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
}

export interface SystemEvalResult {
  system: EvalSystem;
  metrics: AggregateMetrics;
  rows: ScoredPrediction[];
}

export interface EvalRunReport {
  schemaVersion: "0.1.0";
  dataset: { name: string; version: string; kind: EvalDataset["kind"] };
  model: string;
  apiMode: string;
  modelSettings: {
    reasoningEffort: string | null;
    extractionReasoningEffort: string | null;
    decisionReasoningEffort: string | null;
    textVerbosity: string | null;
  };
  startedAt: string;
  completedAt: string;
  scenarioIds: string[];
  promptVersions: Record<EvalSystem, string>;
  results: SystemEvalResult[];
  warning: string;
}
