import type { ContactDecision, ContactIntent } from "./types.js";

export type AuthorizationStatus = "granted" | "denied" | "unknown";

export interface CancellationSignal {
  reason: string;
  evidenceRef: string;
}

export interface PolicyBlock {
  reason: string;
  evidenceRef?: string;
}

export interface ContactPolicyState {
  authorization: AuthorizationStatus;
  doNotDisturbUntil?: string;
  remainingContactBudget?: number;
  budgetResetsAt?: string;
}

export interface HardGateContext {
  decisionId: string;
  policyVersion: string;
  now: Date;
  userState: ContactPolicyState;
  cancellation?: CancellationSignal;
  policyBlock?: PolicyBlock;
}

export type HardGateResult =
  | { outcome: "continue" }
  | { outcome: "decided"; decision: ContactDecision };

export class InvalidHardGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHardGateInputError";
  }
}

function parseInstant(value: string, label: string): number {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new InvalidHardGateInputError(`${label} must be a valid date-time`);
  }
  return instant;
}

function makeDecision(
  intent: ContactIntent,
  context: HardGateContext,
  action: ContactDecision["action"],
  reason: string,
  options: {
    counterEvidenceRefs?: string[];
    nextEvaluationAt?: string | null;
  } = {},
): ContactDecision {
  return {
    id: context.decisionId,
    intentId: intent.id,
    evaluatedAt: context.now.toISOString(),
    action,
    reason,
    evidenceRefs: intent.evidence.map((item) => item.eventId),
    counterEvidenceRefs: options.counterEvidenceRefs ?? [],
    confidence: 1,
    nextEvaluationAt: options.nextEvaluationAt ?? null,
    policyVersion: context.policyVersion,
    metadata: { source: "deterministic-hard-gate" },
  };
}

export function evaluateValidityGates(
  intent: ContactIntent,
  context: HardGateContext,
): HardGateResult {
  const now = context.now.getTime();
  if (Number.isNaN(now)) {
    throw new InvalidHardGateInputError("now must be a valid date");
  }

  if (["resolved", "cancelled", "expired"].includes(intent.status)) {
    throw new InvalidHardGateInputError(
      `Terminal intent ${intent.id} cannot pass hard gates from ${intent.status}`,
    );
  }

  if (context.cancellation) {
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "cancel",
        context.cancellation.reason,
        { counterEvidenceRefs: [context.cancellation.evidenceRef] },
      ),
    };
  }

  if (
    intent.expiresAt !== null &&
    now >= parseInstant(intent.expiresAt, "expiresAt")
  ) {
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "expire",
        "The contact intent has reached its expiry boundary.",
      ),
    };
  }

  if (context.policyBlock) {
    const counterEvidenceRefs = context.policyBlock.evidenceRef
      ? [context.policyBlock.evidenceRef]
      : [];
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "cancel",
        context.policyBlock.reason,
        { counterEvidenceRefs },
      ),
    };
  }

  if (context.userState.authorization === "denied") {
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "cancel",
        "The user has denied proactive contact permission.",
      ),
    };
  }

  return { outcome: "continue" };
}

export function evaluateContactEligibilityGates(
  intent: ContactIntent,
  context: HardGateContext,
): HardGateResult {
  const now = context.now.getTime();
  if (Number.isNaN(now)) {
    throw new InvalidHardGateInputError("now must be a valid date");
  }
  if (["resolved", "cancelled", "expired"].includes(intent.status)) {
    throw new InvalidHardGateInputError(
      `Terminal intent ${intent.id} cannot pass contact eligibility gates from ${intent.status}`,
    );
  }

  if (context.userState.authorization === "unknown") {
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "silent",
        "Proactive contact permission is unknown; silence is the safe default.",
      ),
    };
  }

  const blockers: Array<{ until: number; label: string }> = [];
  if (intent.notBefore !== null) {
    const notBefore = parseInstant(intent.notBefore, "notBefore");
    if (now < notBefore) {
      blockers.push({ until: notBefore, label: "not-before window" });
    }
  }

  if (context.userState.doNotDisturbUntil) {
    const doNotDisturbUntil = parseInstant(
      context.userState.doNotDisturbUntil,
      "doNotDisturbUntil",
    );
    if (now < doNotDisturbUntil) {
      blockers.push({ until: doNotDisturbUntil, label: "do-not-disturb window" });
    }
  }

  const remainingBudget = context.userState.remainingContactBudget;
  if (remainingBudget !== undefined) {
    if (!Number.isInteger(remainingBudget) || remainingBudget < 0) {
      throw new InvalidHardGateInputError(
        "remainingContactBudget must be a non-negative integer",
      );
    }

    if (remainingBudget === 0) {
      if (context.userState.budgetResetsAt) {
        const budgetResetsAt = parseInstant(
          context.userState.budgetResetsAt,
          "budgetResetsAt",
        );
        if (now < budgetResetsAt) {
          blockers.push({ until: budgetResetsAt, label: "contact budget" });
        } else {
          throw new InvalidHardGateInputError(
            "A depleted budget must have a future budgetResetsAt",
          );
        }
      } else {
        return {
          outcome: "decided",
          decision: makeDecision(
            intent,
            context,
            "silent",
            "The contact budget is exhausted and no reset time is available.",
          ),
        };
      }
    }
  }

  if (blockers.length > 0) {
    const latest = blockers.reduce((current, item) =>
      item.until > current.until ? item : current,
    );
    const labels = blockers.map((item) => item.label).join(", ");
    return {
      outcome: "decided",
      decision: makeDecision(
        intent,
        context,
        "defer",
        `Contact is blocked by: ${labels}.`,
        { nextEvaluationAt: new Date(latest.until).toISOString() },
      ),
    };
  }

  return { outcome: "continue" };
}

export function evaluateHardGates(
  intent: ContactIntent,
  context: HardGateContext,
): HardGateResult {
  const validity = evaluateValidityGates(intent, context);
  return validity.outcome === "decided"
    ? validity
    : evaluateContactEligibilityGates(intent, context);
}
