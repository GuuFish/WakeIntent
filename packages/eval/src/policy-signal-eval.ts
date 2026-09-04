import type {
  ContactPolicySignal,
  ConversationEvent,
} from "@wakeintent/core";

export type PolicySignalEvalSplit = "development" | "holdout" | "regression";

export type PolicySignalExpectation =
  | {
      kind: "set-do-not-disturb";
      evidenceRef: string;
      doNotDisturbUntil: string;
    }
  | {
      kind: "clear-do-not-disturb";
      evidenceRef: string;
    }
  | {
      kind: "set-authorization";
      evidenceRef: string;
      authorization: "granted" | "denied" | "unknown";
    };

export interface PolicySignalEvalScenario {
  id: string;
  split: PolicySignalEvalSplit;
  category: string;
  now: string;
  timeZone: string;
  events: ConversationEvent[];
  expected: PolicySignalExpectation[];
}

export interface PolicySignalScenarioScore {
  scenarioId: string;
  split: PolicySignalEvalSplit;
  category: string;
  passed: boolean;
  expected: PolicySignalExpectation[];
  actual: PolicySignalExpectation[];
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  error: string | null;
}

export interface PolicySignalAggregateScore {
  scenarios: number;
  passed: number;
  exactMatchAccuracy: number;
  positiveScenarioAccuracy: number;
  negativeScenarioAccuracy: number;
  signalPrecision: number;
  signalRecall: number;
  signalF1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  errors: number;
}

function normalizeInstant(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be a valid instant`);
  return new Date(parsed).toISOString();
}

function normalizeExpectation(
  signal: PolicySignalExpectation,
): PolicySignalExpectation {
  if (signal.kind !== "set-do-not-disturb") return { ...signal };
  return {
    ...signal,
    doNotDisturbUntil: normalizeInstant(
      signal.doNotDisturbUntil,
      "doNotDisturbUntil",
    ),
  };
}

export function policySignalExpectationFromActual(
  signal: ContactPolicySignal,
): PolicySignalExpectation {
  if (signal.kind === "set-do-not-disturb") {
    return normalizeExpectation({
      kind: signal.kind,
      evidenceRef: signal.evidenceRef,
      doNotDisturbUntil: signal.doNotDisturbUntil,
    });
  }
  if (signal.kind === "set-authorization") {
    return {
      kind: signal.kind,
      evidenceRef: signal.evidenceRef,
      authorization: signal.authorization,
    };
  }
  return { kind: signal.kind, evidenceRef: signal.evidenceRef };
}

function signature(signal: PolicySignalExpectation): string {
  const normalized = normalizeExpectation(signal);
  if (normalized.kind === "set-do-not-disturb") {
    return `${normalized.kind}|${normalized.evidenceRef}|${normalized.doNotDisturbUntil}`;
  }
  if (normalized.kind === "set-authorization") {
    return `${normalized.kind}|${normalized.evidenceRef}|${normalized.authorization}`;
  }
  return `${normalized.kind}|${normalized.evidenceRef}`;
}

function countMatches(expected: string[], actual: string[]): number {
  const remaining = [...actual];
  let matches = 0;
  for (const item of expected) {
    const index = remaining.indexOf(item);
    if (index < 0) continue;
    matches += 1;
    remaining.splice(index, 1);
  }
  return matches;
}

export function scorePolicySignalScenario(input: {
  scenario: PolicySignalEvalScenario;
  actual: ContactPolicySignal[];
  error?: string | null;
}): PolicySignalScenarioScore {
  const expected = input.scenario.expected.map(normalizeExpectation);
  const actual = input.actual.map(policySignalExpectationFromActual);
  const expectedSignatures = expected.map(signature).sort();
  const actualSignatures = actual.map(signature).sort();
  const truePositives = countMatches(expectedSignatures, actualSignatures);
  const falsePositives = actual.length - truePositives;
  const falseNegatives = expected.length - truePositives;
  const error = input.error ?? null;
  return {
    scenarioId: input.scenario.id,
    split: input.scenario.split,
    category: input.scenario.category,
    passed:
      error === null &&
      expectedSignatures.length === actualSignatures.length &&
      expectedSignatures.every((item, index) => item === actualSignatures[index]),
    expected,
    actual,
    truePositives,
    falsePositives,
    falseNegatives,
    error,
  };
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function aggregatePolicySignalScores(
  scores: PolicySignalScenarioScore[],
): PolicySignalAggregateScore {
  const passed = scores.filter((score) => score.passed).length;
  const positives = scores.filter((score) => score.expected.length > 0);
  const negatives = scores.filter((score) => score.expected.length === 0);
  const truePositives = scores.reduce(
    (total, score) => total + score.truePositives,
    0,
  );
  const falsePositives = scores.reduce(
    (total, score) => total + score.falsePositives,
    0,
  );
  const falseNegatives = scores.reduce(
    (total, score) => total + score.falseNegatives,
    0,
  );
  const signalPrecision = safeRatio(
    truePositives,
    truePositives + falsePositives,
  );
  const signalRecall = safeRatio(
    truePositives,
    truePositives + falseNegatives,
  );
  const signalF1 =
    signalPrecision + signalRecall === 0
      ? 0
      : (2 * signalPrecision * signalRecall) /
        (signalPrecision + signalRecall);
  return {
    scenarios: scores.length,
    passed,
    exactMatchAccuracy: safeRatio(passed, scores.length),
    positiveScenarioAccuracy: safeRatio(
      positives.filter((score) => score.passed).length,
      positives.length,
    ),
    negativeScenarioAccuracy: safeRatio(
      negatives.filter((score) => score.passed).length,
      negatives.length,
    ),
    signalPrecision,
    signalRecall,
    signalF1,
    truePositives,
    falsePositives,
    falseNegatives,
    errors: scores.filter((score) => score.error !== null).length,
  };
}
