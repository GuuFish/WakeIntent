import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeClock,
  type CandidateDraft,
  type ContactIntent,
  type ContactDecision,
  type ConversationEvent,
} from "@wakeintent/core";

import {
  IntentDrivenReferenceApp,
  type IntentDrivenReferenceAppOptions,
} from "./intent-driven-app.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryOptions(
  clock: FakeClock,
  overrides: Partial<IntentDrivenReferenceAppOptions> = {},
): Promise<IntentDrivenReferenceAppOptions> {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-intent-app-"));
  temporaryDirectories.push(directory);
  return {
    service: {
      intentStorePath: join(directory, "intents.json"),
      outboxPath: join(directory, "outbox.json"),
      eventStorePath: join(directory, "events.json"),
      conversationRuntime: {
        candidateGenerator: {
          async generate(input) {
            if (input.events[0]?.id !== "plan") return [];
            return [candidate("plan")];
          },
        },
        relevanceRouter: {
          async selectRelevant(input) {
            if (input.events[0]?.id !== "cancel") return [];
            return [
              {
                intentId: input.intents[0]!.id,
                eventIds: ["cancel"],
                effect: "resolve",
                reason: "The user completed the planned task before the follow-up.",
                confidence: 0.99,
              },
            ];
          },
        },
        semanticReevaluator: {
          async evaluate(input) {
            return contactDecisionProposal(input.intent);
          },
        },
      },
    },
    messageStorePath: join(directory, "messages.json"),
    messageGenerator: {
      async generate(input) {
        return {
          content: `主动跟进：${input.intent.subject}`,
          metadata: { test: true },
        };
      },
    },
    userStateProvider: () => ({ authorization: "granted", remainingContactBudget: 1 }),
    policyVersion: "reference-host-test-0.1",
    clock,
    timeZone: "Asia/Shanghai",
    ...overrides,
  };
}

function event(
  id: string,
  occurredAt: string,
  content: string,
): ConversationEvent {
  return {
    id,
    conversationId: "conversation:test",
    actor: "user",
    occurredAt,
    content,
  };
}

function candidate(evidenceEventId: string): CandidateDraft {
  return {
    subject: "申请材料",
    reason: "用户要求在窗口到达后确认申请材料。",
    evidence: [{ eventId: evidenceEventId }],
    notBefore: "2026-09-05T12:00:00.000Z",
    expiresAt: "2026-09-10T12:00:00.000Z",
    cancellationHints: ["用户已经完成申请材料"],
    priority: 0.8,
    interruptionCost: 0.2,
    confidence: 0.95,
  };
}

function contactDecisionProposal(intent: ContactIntent): {
  action: "contact";
  reason: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  confidence: number;
  nextEvaluationAt: null;
} {
  return {
    action: "contact",
    reason: "The follow-up remains useful now.",
    evidenceRefs: intent.evidence.map((item) => item.eventId),
    counterEvidenceRefs: [],
    confidence: 0.9,
    nextEvaluationAt: null,
  };
}

describe("IntentDrivenReferenceApp", () => {
  it("wakes at a due time, generates one persisted chat message, and recovers it after restart", async () => {
    const clock = new FakeClock("2026-09-01T09:00:00.000Z");
    const options = await temporaryOptions(clock);
    const app = await IntentDrivenReferenceApp.open(options);
    const ingested = await app.service.processConversation({
      conversationId: "conversation:test",
      events: [event("plan", "2026-09-01T09:00:00.000Z", "周五问我申请材料。")],
      target: { kind: "user", id: "user:test" },
      now: "2026-09-01T09:00:00.000Z",
      idempotencyKey: "turn:plan",
      activationThreshold: 0.8,
      routePolicyVersion: "route-test-0.1",
      timeZone: "Asia/Shanghai",
    });
    expect(ingested.registrations?.results).toHaveLength(1);

    clock.set("2026-09-05T12:00:00.000Z");
    const firstWake = await app.runOnce();
    expect(firstWake.dueIntentCount).toBe(1);
    expect(firstWake.evaluation.evaluation.results[0]).toMatchObject({
      decision: { action: "contact" },
    });
    expect(firstWake.generatedMessages).toHaveLength(1);
    expect(await app.listMessages("conversation:test")).toMatchObject([
      {
        content: "主动跟进：申请材料",
        sourceIntentId: ingested.plan.intents[0]!.id,
        kind: "proactive",
      },
    ]);

    const secondWake = await app.runOnce();
    expect(secondWake.dueIntentCount).toBe(0);
    expect(secondWake.generatedMessages).toEqual([]);
    expect(await app.listMessages()).toHaveLength(1);

    await app.stop();
    const restarted = await IntentDrivenReferenceApp.open(options);
    expect(await restarted.listMessages("conversation:test")).toHaveLength(1);
    const restartedWake = await restarted.runOnce();
    expect(restartedWake.generatedMessages).toEqual([]);
    expect(await restarted.listMessages()).toHaveLength(1);
    await restarted.stop();
  });

  it("resolves an intent before its due time and never creates a proactive message", async () => {
    const clock = new FakeClock("2026-09-01T09:00:00.000Z");
    const options = await temporaryOptions(clock);
    const app = await IntentDrivenReferenceApp.open(options);
    await app.service.processConversation({
      conversationId: "conversation:test",
      events: [event("plan", "2026-09-01T09:00:00.000Z", "周五问我申请材料。")],
      target: { kind: "user", id: "user:test" },
      now: "2026-09-01T09:00:00.000Z",
      idempotencyKey: "turn:plan",
      activationThreshold: 0.8,
      routePolicyVersion: "route-test-0.1",
      timeZone: "Asia/Shanghai",
    });

    const cancelled = await app.service.processConversation({
      conversationId: "conversation:test",
      events: [event("cancel", "2026-09-02T09:00:00.000Z", "申请材料已经完成，不用再问了。")],
      target: { kind: "user", id: "user:test" },
      now: "2026-09-02T09:00:00.000Z",
      idempotencyKey: "turn:cancel",
      activationThreshold: 0.8,
      routePolicyVersion: "route-test-0.1",
      timeZone: "Asia/Shanghai",
    });
    expect(cancelled.plan.selections).toMatchObject([{ effect: "resolve" }]);

    clock.set("2026-09-02T09:00:00.000Z");
    const wake = await app.runOnce();
    expect(wake.dueIntentCount).toBe(1);
    expect(wake.evaluation.evaluation.results[0]).toMatchObject({
      source: "route-closure",
      decision: { action: "resolve" },
    });
    expect(wake.generatedMessages).toEqual([]);
    expect(await app.listMessages()).toEqual([]);
    expect((await app.service.listOutbox())).toEqual([]);
    expect((await app.service.listIntents())[0]?.intent.status).toBe("resolved");
    await app.stop();
  });

  it("runs the background wake loop and remains idempotent when started twice", async () => {
    vi.useFakeTimers();
    try {
      const clock = new FakeClock("2026-09-01T09:00:00.000Z");
      const options = await temporaryOptions(clock, { wakeIntervalMs: 10 });
      const app = await IntentDrivenReferenceApp.open(options);
      await app.service.processConversation({
        conversationId: "conversation:test",
        events: [event("plan", "2026-09-01T09:00:00.000Z", "周五问我申请材料。")],
        target: { kind: "user", id: "user:test" },
        now: "2026-09-01T09:00:00.000Z",
        idempotencyKey: "turn:plan",
        activationThreshold: 0.8,
        routePolicyVersion: "route-test-0.1",
        timeZone: "Asia/Shanghai",
      });

      app.start();
      app.start();
      expect(app.running).toBe(true);
      await vi.runOnlyPendingTimersAsync();

      clock.set("2026-09-05T12:00:00.000Z");
      await vi.advanceTimersByTimeAsync(10);
      await app.stop();

      expect(await app.listMessages()).toHaveLength(1);
      expect(app.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("generates a message only for contact and stays silent for every other action", async () => {
    const actions = ["defer", "cancel", "expire", "silent", "resolve"] as const;
    const clock = new FakeClock("2026-09-05T12:00:00.000Z");
    const baseOptions = await temporaryOptions(clock);
    const options: IntentDrivenReferenceAppOptions = {
      ...baseOptions,
      service: {
        ...baseOptions.service!,
        conversationRuntime: {
          candidateGenerator: { async generate() { return []; } },
          relevanceRouter: { async selectRelevant() { return []; } },
          semanticReevaluator: {
            async evaluate(input) {
              const action = input.intent.subject as (typeof actions)[number];
              return {
                action,
                reason: `The test action is ${action}.`,
                evidenceRefs: input.intent.evidence.map((item) => item.eventId),
                counterEvidenceRefs: [],
                confidence: 0.9,
                nextEvaluationAt:
                  action === "defer" ? "2026-09-05T13:00:00.000Z" : null,
              };
            },
          },
        },
      },
    };
    const app = await IntentDrivenReferenceApp.open(options);
    for (const [index, action] of actions.entries()) {
      const intent: ContactIntent = {
        schemaVersion: "0.1.0",
        id: `intent:${action}`,
        status: "active",
        subject: action,
        reason: `Exercise the ${action} action.`,
        target: { kind: "user", id: "user:test" },
        evidence: [{ eventId: "event:action" }],
        notBefore: "2026-09-05T12:00:00.000Z",
        expiresAt: null,
        cancellationHints: [],
        priority: 0.8,
        interruptionCost: 0.2,
        confidence: 0.95,
        createdAt: "2026-09-05T09:00:00.000Z",
        updatedAt: "2026-09-05T09:00:00.000Z",
        metadata: {
          sourceConversationId: "conversation:test",
          sourceIngestionId: `test:${index}`,
        },
      };
      await app.service.registerIntent({
        intent,
        nextEvaluationAt: "2026-09-05T12:00:00.000Z",
        idempotencyKey: `create:${action}`,
      });
    }

    const wake = await app.runOnce();
    expect(wake.generatedMessages).toHaveLength(0);
    expect(await app.listMessages()).toEqual([]);
    expect(await app.service.listOutbox()).toEqual([]);
    const statuses = Object.fromEntries(
      (await app.service.listIntents()).map((record) => [
        record.intent.subject,
        record.intent.status,
      ]),
    );
    expect(statuses).toEqual({
      defer: "active",
      cancel: "cancelled",
      expire: "expired",
      silent: "active",
      resolve: "resolved",
    });
    await app.stop();
  });
});
