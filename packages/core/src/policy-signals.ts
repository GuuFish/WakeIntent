import type { AuthorizationStatus, ContactPolicyState } from "./hard-gates.js";

interface ContactPolicySignalBase {
  schemaVersion: "0.1.0";
  id: string;
  evidenceRef: string;
  occurredAt: string;
  reason: string;
}

export interface SetDoNotDisturbSignal extends ContactPolicySignalBase {
  kind: "set-do-not-disturb";
  doNotDisturbUntil: string;
}

export interface ClearDoNotDisturbSignal extends ContactPolicySignalBase {
  kind: "clear-do-not-disturb";
}

export interface SetAuthorizationSignal extends ContactPolicySignalBase {
  kind: "set-authorization";
  authorization: AuthorizationStatus;
}

export type ContactPolicySignal =
  | SetDoNotDisturbSignal
  | ClearDoNotDisturbSignal
  | SetAuthorizationSignal;

export interface ContactPolicySnapshot {
  state: ContactPolicyState;
  appliedSignalIds: string[];
  updatedAt: string;
}

export interface ContactPolicySignalAudit {
  signalId: string;
  kind: ContactPolicySignal["kind"];
  evidenceRef: string;
  occurredAt: string;
  appliedAt: string;
  outcome: "applied" | "duplicate" | "expired";
  reason: string;
  before: ContactPolicyState;
  after: ContactPolicyState;
}

export interface ApplyContactPolicySignalsInput {
  snapshot: ContactPolicySnapshot;
  signals: ContactPolicySignal[];
  now: Date;
}

export interface ApplyContactPolicySignalsResult {
  snapshot: ContactPolicySnapshot;
  audits: ContactPolicySignalAudit[];
}

export class InvalidContactPolicySignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContactPolicySignalError";
  }
}

function parseInstant(value: string, label: string): number {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new InvalidContactPolicySignalError(`${label} must be a valid date-time`);
  }
  return instant;
}

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidContactPolicySignalError(`${label} is required`);
  }
}

function cloneState(state: ContactPolicyState): ContactPolicyState {
  return { ...state };
}

function withoutDoNotDisturb(state: ContactPolicyState): ContactPolicyState {
  const { doNotDisturbUntil: _ignored, ...remaining } = state;
  return remaining;
}

function validateState(state: ContactPolicyState): void {
  if (
    state.remainingContactBudget !== undefined &&
    (!Number.isInteger(state.remainingContactBudget) ||
      state.remainingContactBudget < 0)
  ) {
    throw new InvalidContactPolicySignalError(
      "remainingContactBudget must be a non-negative integer",
    );
  }
  if (state.doNotDisturbUntil !== undefined) {
    parseInstant(state.doNotDisturbUntil, "state.doNotDisturbUntil");
  }
  if (state.budgetResetsAt !== undefined) {
    parseInstant(state.budgetResetsAt, "state.budgetResetsAt");
  }
}

export function applyContactPolicySignals(
  input: ApplyContactPolicySignalsInput,
): ApplyContactPolicySignalsResult {
  const now = input.now.getTime();
  if (Number.isNaN(now)) {
    throw new InvalidContactPolicySignalError("now must be a valid date");
  }
  validateState(input.snapshot.state);
  let updatedAt = parseInstant(input.snapshot.updatedAt, "snapshot.updatedAt");
  if (updatedAt > now) {
    throw new InvalidContactPolicySignalError(
      "snapshot.updatedAt cannot be later than now",
    );
  }

  const appliedIds = new Set(input.snapshot.appliedSignalIds);
  if (appliedIds.size !== input.snapshot.appliedSignalIds.length) {
    throw new InvalidContactPolicySignalError(
      "snapshot.appliedSignalIds must be unique",
    );
  }
  let state = cloneState(input.snapshot.state);
  const audits: ContactPolicySignalAudit[] = [];

  for (const signal of input.signals) {
    requireText(signal.id, "signal.id");
    requireText(signal.evidenceRef, "signal.evidenceRef");
    requireText(signal.reason, "signal.reason");
    const occurredAt = parseInstant(signal.occurredAt, "signal.occurredAt");
    if (occurredAt > now) {
      throw new InvalidContactPolicySignalError(
        `Signal ${signal.id} cannot occur after now`,
      );
    }
    const before = cloneState(state);
    if (appliedIds.has(signal.id)) {
      audits.push({
        signalId: signal.id,
        kind: signal.kind,
        evidenceRef: signal.evidenceRef,
        occurredAt: signal.occurredAt,
        appliedAt: input.now.toISOString(),
        outcome: "duplicate",
        reason: signal.reason,
        before,
        after: cloneState(state),
      });
      continue;
    }
    if (occurredAt < updatedAt) {
      throw new InvalidContactPolicySignalError(
        `Signal ${signal.id} is older than the policy snapshot`,
      );
    }

    let outcome: ContactPolicySignalAudit["outcome"] = "applied";
    if (signal.kind === "set-do-not-disturb") {
      const until = parseInstant(
        signal.doNotDisturbUntil,
        "signal.doNotDisturbUntil",
      );
      if (until <= occurredAt) {
        throw new InvalidContactPolicySignalError(
          "doNotDisturbUntil must be later than signal.occurredAt",
        );
      }
      if (until <= now) {
        state = withoutDoNotDisturb(state);
        outcome = "expired";
      } else {
        state = { ...state, doNotDisturbUntil: signal.doNotDisturbUntil };
      }
    } else if (signal.kind === "clear-do-not-disturb") {
      state = withoutDoNotDisturb(state);
    } else {
      state = { ...state, authorization: signal.authorization };
    }

    appliedIds.add(signal.id);
    updatedAt = occurredAt;
    audits.push({
      signalId: signal.id,
      kind: signal.kind,
      evidenceRef: signal.evidenceRef,
      occurredAt: signal.occurredAt,
      appliedAt: input.now.toISOString(),
      outcome,
      reason: signal.reason,
      before,
      after: cloneState(state),
    });
  }

  return {
    snapshot: {
      state,
      appliedSignalIds: [...appliedIds],
      updatedAt: new Date(updatedAt).toISOString(),
    },
    audits,
  };
}
