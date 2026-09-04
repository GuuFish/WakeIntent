import type { ContactDecision, ContactIntent, IntentStatus } from "./types.js";

const TERMINAL_STATUSES = new Set<IntentStatus>([
  "resolved",
  "cancelled",
  "expired",
]);

export class InvalidIntentTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntentTransitionError";
  }
}

export function activateIntent(
  intent: ContactIntent,
  activatedAt: string,
): ContactIntent {
  if (intent.status !== "candidate") {
    throw new InvalidIntentTransitionError(
      `Only candidate intents can be activated; received ${intent.status}`,
    );
  }

  return { ...intent, status: "active", updatedAt: activatedAt };
}

export function applyDecision(
  intent: ContactIntent,
  decision: ContactDecision,
): ContactIntent {
  if (intent.id !== decision.intentId) {
    throw new InvalidIntentTransitionError(
      `Decision ${decision.id} targets ${decision.intentId}, not ${intent.id}`,
    );
  }

  if (TERMINAL_STATUSES.has(intent.status)) {
    throw new InvalidIntentTransitionError(
      `Terminal intent ${intent.id} cannot be reevaluated from ${intent.status}`,
    );
  }

  const statusByTerminalAction: Partial<Record<ContactDecision["action"], IntentStatus>> = {
    cancel: "cancelled",
    expire: "expired",
    resolve: "resolved",
  };
  const nextStatus = statusByTerminalAction[decision.action] ?? intent.status;

  return {
    ...intent,
    status: nextStatus,
    updatedAt: decision.evaluatedAt,
  };
}

