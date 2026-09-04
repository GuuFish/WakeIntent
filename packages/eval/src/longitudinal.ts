import {
  applyContactPolicySignals,
  extractContactPolicySignals,
  FakeClock,
  extractContactIntents,
  reevaluateContactIntent,
  routeConversationEvents,
  type CandidateDraft,
  type CandidateGenerationInput,
  type CandidateGenerator,
  type ContactDecision,
  type ContactIntent,
  type ContactPolicyState,
  type ContactPolicySignalAudit,
  type ContactPolicySnapshot,
  type ContactTarget,
  type ConversationEvent,
  type DecisionAction,
  type IdGenerator,
  type PolicySignalGenerator,
  type RelevanceRouter,
  type RelevanceRoutingInput,
  type RelevanceRoutingSelection,
  type ReevaluationResult,
  type SemanticDecisionProposal,
  type SemanticReevaluationInput,
  type SemanticReevaluator,
} from "@wakeintent/core";

export type {
  RelevanceRouter,
  RelevanceRoutingInput,
  RelevanceRoutingSelection,
} from "@wakeintent/core";

export interface LongitudinalStep {
  at: string;
  kind: "context" | "scheduled";
  events: ConversationEvent[];
  userState?: ContactPolicyState;
}

export interface WakeIntentTimelineInput {
  scenarioId: string;
  initialEvents: ConversationEvent[];
  target: ContactTarget;
  timeZone: string;
  initialUserState: ContactPolicyState;
  steps: LongitudinalStep[];
  generator: CandidateGenerator;
  semanticReevaluator: SemanticReevaluator;
  relevanceRouter: RelevanceRouter;
  policySignalGenerator?: PolicySignalGenerator;
  activationThreshold?: number;
}

export interface WakeIntentTimelineTrace {
  at: string;
  trigger: LongitudinalStep["kind"];
  intentId: string;
  decision: ContactDecision;
  source: ReevaluationResult["source"];
}

export interface WakeIntentTimelineMetrics {
  extractionModelCalls: number;
  policySignalExtractionCalls: number;
  policySignalsApplied: number;
  routingCalls: number;
  reevaluationAttempts: number;
  semanticDecisionModelCalls: number;
  contactDecisions: number;
  terminalDecisions: number;
}

export interface WakeIntentTimelineResult {
  intents: ContactIntent[];
  traces: WakeIntentTimelineTrace[];
  metrics: WakeIntentTimelineMetrics;
  pendingEvaluationAt: Record<string, string>;
  policySnapshot: ContactPolicySnapshot;
  policyAudits: ContactPolicySignalAudit[];
}

export interface BaselineTimelineMemory {
  id: string;
  summary: string;
  dueAt: string;
  evidenceRefs: string[];
}

export interface BaselineTimelineDecision {
  memoryId: string;
  action: DecisionAction;
  reason: string;
  evidenceRefs: string[];
  nextEvaluationAt: string | null;
}

export interface BaselineTimelineDecisionInput {
  memories: BaselineTimelineMemory[];
  latestEvents: ConversationEvent[];
  now: string;
  userState: ContactPolicyState;
}

export interface BaselineTimelineDecider {
  decide(
    input: BaselineTimelineDecisionInput,
  ): Promise<BaselineTimelineDecision[]>;
}

export interface DueGatedBaselineTimelineInput {
  memories: BaselineTimelineMemory[];
  initialUserState: ContactPolicyState;
  steps: LongitudinalStep[];
  decider: BaselineTimelineDecider;
  extractionModelCalls?: number;
}

export interface DueGatedBaselineTimelineResult {
  memories: BaselineTimelineMemory[];
  traces: Array<{
    at: string;
    decisions: BaselineTimelineDecision[];
  }>;
  metrics: {
    extractionModelCalls: number;
    deterministicChecks: number;
    decisionModelCalls: number;
    contactDecisions: number;
    terminalDecisions: number;
  };
}

const terminalActions = new Set<DecisionAction>([
  "cancel",
  "expire",
  "resolve",
]);

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be a valid instant`);
  return parsed;
}

function validateSteps(steps: LongitudinalStep[]): void {
  let previous = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    const at = parseInstant(step.at, "step.at");
    if (at < previous) throw new Error("Timeline steps must be chronological");
    previous = at;
    for (const event of step.events) {
      if (parseInstant(event.occurredAt, "event.occurredAt") > at) {
        throw new Error(`Event ${event.id} occurs after its timeline step`);
      }
    }
  }
}

function idGenerator(prefix: string): IdGenerator {
  let sequence = 0;
  return (kind) => `${prefix}-${kind}-${++sequence}`;
}

function cloneEvents(events: ConversationEvent[]): ConversationEvent[] {
  return events.map((event) => ({
    ...event,
    ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
  }));
}

function scheduleFromIntent(intent: ContactIntent): string | null {
  return intent.notBefore ?? intent.createdAt;
}

function updateSchedule(
  schedule: Map<string, string>,
  result: ReevaluationResult,
): void {
  if (terminalActions.has(result.decision.action)) {
    schedule.delete(result.intent.id);
    return;
  }
  if (result.decision.action === "defer") {
    if (result.decision.nextEvaluationAt === null) {
      throw new Error("A defer decision must provide nextEvaluationAt");
    }
    schedule.set(result.intent.id, result.decision.nextEvaluationAt);
    return;
  }
  if (result.decision.nextEvaluationAt !== null) {
    schedule.set(result.intent.id, result.decision.nextEvaluationAt);
  } else {
    schedule.delete(result.intent.id);
  }
}

export async function runWakeIntentTimeline(
  input: WakeIntentTimelineInput,
): Promise<WakeIntentTimelineResult> {
  validateSteps(input.steps);
  if (input.initialEvents.length === 0) {
    throw new Error("WakeIntent timeline requires initial events");
  }
  const extractionNow =
    input.initialEvents.at(-1)?.occurredAt ?? input.steps[0]?.at;
  if (!extractionNow) throw new Error("Timeline has no usable start instant");

  let extractionModelCalls = 0;
  const countingGenerator: CandidateGenerator = {
    async generate(generationInput: CandidateGenerationInput): Promise<CandidateDraft[]> {
      extractionModelCalls += 1;
      return input.generator.generate(generationInput);
    },
  };
  let semanticDecisionModelCalls = 0;
  const countingReevaluator: SemanticReevaluator = {
    async evaluate(
      reevaluationInput: SemanticReevaluationInput,
    ): Promise<SemanticDecisionProposal> {
      semanticDecisionModelCalls += 1;
      return input.semanticReevaluator.evaluate(reevaluationInput);
    },
  };

  let intents = await extractContactIntents({
    events: cloneEvents(input.initialEvents),
    target: input.target,
    clock: new FakeClock(extractionNow),
    idGenerator: idGenerator(`${input.scenarioId}-extract`),
    generator: countingGenerator,
    policy: { activationThreshold: input.activationThreshold ?? 0.7 },
    timeZone: input.timeZone,
  });
  const schedule = new Map<string, string>();
  const policyPostponedFrom = new Map<string, string>();
  const pendingEvents = new Map<string, ConversationEvent[]>();
  for (const intent of intents) {
    if (intent.status !== "active") continue;
    const scheduledAt = scheduleFromIntent(intent);
    if (scheduledAt !== null) schedule.set(intent.id, scheduledAt);
    pendingEvents.set(intent.id, []);
  }

  let policySnapshot: ContactPolicySnapshot = {
    state: { ...input.initialUserState },
    appliedSignalIds: [],
    updatedAt: extractionNow,
  };
  let userState = { ...policySnapshot.state };
  let policySignalExtractionCalls = 0;
  let policySignalsApplied = 0;
  const policyAudits: ContactPolicySignalAudit[] = [];
  const policySignalIds = idGenerator(`${input.scenarioId}-policy`);
  let routingCalls = 0;
  let reevaluationAttempts = 0;
  const traces: WakeIntentTimelineTrace[] = [];
  const decisionIds = idGenerator(`${input.scenarioId}-timeline`);

  for (const step of input.steps) {
    if (step.userState) {
      policySnapshot = {
        ...policySnapshot,
        state: { ...step.userState },
      };
      userState = { ...step.userState };
    }
    const active = intents.filter((intent) => intent.status === "active");
    for (const intent of active) {
      const current = pendingEvents.get(intent.id) ?? [];
      pendingEvents.set(intent.id, [...current, ...cloneEvents(step.events)]);
    }

    let policyClosedAllActiveIntents = false;
    if (
      step.kind === "context" &&
      step.events.length > 0 &&
      input.policySignalGenerator
    ) {
      const previousDoNotDisturbUntil =
        policySnapshot.state.doNotDisturbUntil ?? null;
      policySignalExtractionCalls += 1;
      const signals = await extractContactPolicySignals({
        events: cloneEvents(step.events),
        clock: new FakeClock(step.at),
        idGenerator: policySignalIds,
        generator: input.policySignalGenerator,
        timeZone: input.timeZone,
        currentPolicy: policySnapshot.state,
      });
      if (signals.length > 0) {
        const applied = applyContactPolicySignals({
          snapshot: policySnapshot,
          signals,
          now: new Date(step.at),
        });
        policySnapshot = applied.snapshot;
        userState = { ...policySnapshot.state };
        policyAudits.push(...applied.audits);
        policySignalsApplied += applied.audits.filter(
          (audit) => audit.outcome === "applied",
        ).length;

        const deniedAuthorizationAudit = applied.audits.find(
          (audit) =>
            audit.kind === "set-authorization" &&
            audit.outcome === "applied" &&
            audit.after.authorization === "denied",
        );
        if (deniedAuthorizationAudit) {
          for (const intent of active) {
            reevaluationAttempts += 1;
            const result = await reevaluateContactIntent({
              intent,
              latestEvents: cloneEvents(pendingEvents.get(intent.id) ?? []),
              clock: new FakeClock(step.at),
              idGenerator: decisionIds,
              policyVersion: "longitudinal-eval-0.1",
              timeZone: input.timeZone,
              userState,
              semanticReevaluator: countingReevaluator,
              policyBlock: {
                reason: deniedAuthorizationAudit.reason,
                evidenceRef: deniedAuthorizationAudit.evidenceRef,
              },
            });
            intents = intents.map((item) =>
              item.id === intent.id ? result.intent : item,
            );
            pendingEvents.set(intent.id, []);
            updateSchedule(schedule, result);
            policyPostponedFrom.delete(intent.id);
            traces.push({
              at: step.at,
              trigger: step.kind,
              intentId: intent.id,
              decision: result.decision,
              source: result.source,
            });
          }
          policyClosedAllActiveIntents = active.length > 0;
        }

        const nextDoNotDisturbUntil =
          policySnapshot.state.doNotDisturbUntil ?? null;
        if (nextDoNotDisturbUntil !== null) {
          const quietUntil = parseInstant(
            nextDoNotDisturbUntil,
            "policy.doNotDisturbUntil",
          );
          for (const intent of active) {
            const scheduledAt = schedule.get(intent.id);
            if (
              scheduledAt !== undefined &&
              parseInstant(scheduledAt, "schedule") < quietUntil
            ) {
              if (!policyPostponedFrom.has(intent.id)) {
                policyPostponedFrom.set(intent.id, scheduledAt);
              }
              schedule.set(intent.id, nextDoNotDisturbUntil);
            }
          }
        } else if (previousDoNotDisturbUntil !== null) {
          for (const [intentId, originalAt] of policyPostponedFrom) {
            const restoredAt =
              parseInstant(originalAt, "policyPostponedFrom") <=
              parseInstant(step.at, "step.at")
                ? step.at
                : originalAt;
            schedule.set(intentId, restoredAt);
            policyPostponedFrom.delete(intentId);
          }
        }
      }
    }

    if (policyClosedAllActiveIntents) continue;

    let selections: RelevanceRoutingSelection[];
    if (step.kind === "context") {
      if (active.length === 0 || step.events.length === 0) continue;
      routingCalls += 1;
      const routing = await routeConversationEvents({
        intents: active.map((intent) => ({ ...intent })),
        events: cloneEvents(step.events),
        now: step.at,
        router: input.relevanceRouter,
      });
      selections = routing.selections;
    } else {
      const now = parseInstant(step.at, "step.at");
      selections = active
        .filter((intent) => {
          const scheduledAt = schedule.get(intent.id);
          return scheduledAt !== undefined && parseInstant(scheduledAt, "schedule") <= now;
        })
        .map((intent) => ({
          intentId: intent.id,
          eventIds: [],
          effect: "reevaluate" as const,
          reason: "The intent reached its scheduled evaluation time.",
          confidence: 1,
        }));
    }

    const selectedIds = selections.map((selection) => selection.intentId);
    if (new Set(selectedIds).size !== selectedIds.length) {
      throw new Error("Relevance router returned duplicate intent ids");
    }
    for (const selection of selections) {
      const intentId = selection.intentId;
      const current = intents.find((intent) => intent.id === intentId);
      if (!current || current.status !== "active") {
        throw new Error(`Selected intent ${intentId} is not active`);
      }
      reevaluationAttempts += 1;
      const closureAction =
        selection.effect === "cancel" || selection.effect === "resolve"
          ? selection.effect
          : null;
      const semanticReevaluator =
        closureAction !== null
          ? {
              async evaluate(): Promise<SemanticDecisionProposal> {
                return {
                  action: closureAction,
                  reason: selection.reason,
                  evidenceRefs: current.evidence.map((item) => item.eventId),
                  counterEvidenceRefs: [...selection.eventIds],
                  confidence: selection.confidence,
                  nextEvaluationAt: null,
                  metadata: { source: "relevance-route-closure" },
                };
              },
            }
          : countingReevaluator;
      const result = await reevaluateContactIntent({
        intent: current,
        latestEvents: cloneEvents(pendingEvents.get(intentId) ?? []),
        clock: new FakeClock(step.at),
        idGenerator: decisionIds,
        policyVersion: "longitudinal-eval-0.1",
        timeZone: input.timeZone,
        userState,
        semanticReevaluator,
      });
      intents = intents.map((intent) =>
        intent.id === intentId ? result.intent : intent,
      );
      pendingEvents.set(intentId, []);
      updateSchedule(schedule, result);
      policyPostponedFrom.delete(intentId);
      traces.push({
        at: step.at,
        trigger: step.kind,
        intentId,
        decision: result.decision,
        source: result.source,
      });
    }
  }

  return {
    intents,
    traces,
    metrics: {
      extractionModelCalls,
      policySignalExtractionCalls,
      policySignalsApplied,
      routingCalls,
      reevaluationAttempts,
      semanticDecisionModelCalls,
      contactDecisions: traces.filter((trace) => trace.decision.action === "contact")
        .length,
      terminalDecisions: traces.filter((trace) =>
        terminalActions.has(trace.decision.action),
      ).length,
    },
    pendingEvaluationAt: Object.fromEntries(schedule.entries()),
    policySnapshot,
    policyAudits,
  };
}

export async function runDueGatedBaselineTimeline(
  input: DueGatedBaselineTimelineInput,
): Promise<DueGatedBaselineTimelineResult> {
  validateSteps(input.steps);
  let memories = input.memories.map((memory) => ({
    ...memory,
    evidenceRefs: [...memory.evidenceRefs],
  }));
  let accumulatedEvents: ConversationEvent[] = [];
  let userState = { ...input.initialUserState };
  let deterministicChecks = 0;
  let decisionModelCalls = 0;
  const traces: DueGatedBaselineTimelineResult["traces"] = [];

  for (const step of input.steps) {
    if (step.userState) userState = { ...step.userState };
    accumulatedEvents.push(...cloneEvents(step.events));
    if (step.kind !== "scheduled") continue;
    deterministicChecks += 1;
    const now = parseInstant(step.at, "step.at");
    const due = memories.filter(
      (memory) => parseInstant(memory.dueAt, "memory.dueAt") <= now,
    );
    if (due.length === 0) continue;
    decisionModelCalls += 1;
    const decisions = await input.decider.decide({
      memories: due.map((memory) => ({
        ...memory,
        evidenceRefs: [...memory.evidenceRefs],
      })),
      latestEvents: cloneEvents(accumulatedEvents),
      now: step.at,
      userState,
    });
    const dueIds = new Set(due.map((memory) => memory.id));
    if (decisions.length !== due.length) {
      throw new Error("Baseline decider must return one decision per due memory");
    }
    const decisionIds = new Set(decisions.map((decision) => decision.memoryId));
    if (decisionIds.size !== decisions.length || decisionIds.size !== dueIds.size) {
      throw new Error("Baseline decisions must uniquely cover every due memory");
    }
    for (const decision of decisions) {
      if (!dueIds.has(decision.memoryId)) {
        throw new Error(`Decision targets non-due memory ${decision.memoryId}`);
      }
      if (decision.action === "defer") {
        if (
          decision.nextEvaluationAt === null ||
          parseInstant(decision.nextEvaluationAt, "nextEvaluationAt") <= now
        ) {
          throw new Error("Deferred baseline memory needs a future nextEvaluationAt");
        }
        memories = memories.map((memory) =>
          memory.id === decision.memoryId
            ? { ...memory, dueAt: decision.nextEvaluationAt as string }
            : memory,
        );
      } else if (decision.nextEvaluationAt !== null) {
        memories = memories.map((memory) =>
          memory.id === decision.memoryId
            ? { ...memory, dueAt: decision.nextEvaluationAt as string }
            : memory,
        );
      } else {
        memories = memories.filter((memory) => memory.id !== decision.memoryId);
      }
    }
    traces.push({ at: step.at, decisions: decisions.map((item) => ({ ...item })) });
  }

  const allDecisions = traces.flatMap((trace) => trace.decisions);
  return {
    memories,
    traces,
    metrics: {
      extractionModelCalls: input.extractionModelCalls ?? 1,
      deterministicChecks,
      decisionModelCalls,
      contactDecisions: allDecisions.filter((item) => item.action === "contact")
        .length,
      terminalDecisions: allDecisions.filter((item) =>
        terminalActions.has(item.action),
      ).length,
    },
  };
}
