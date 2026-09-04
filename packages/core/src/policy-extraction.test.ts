import { describe, expect, it } from "vitest";
import { FakeClock } from "./clock.js";
import {
  extractContactPolicySignals,
  InvalidPolicySignalExtractionError,
  type ContactPolicySignalDraft,
  type PolicySignalGenerator,
} from "./policy-extraction.js";
import type { ConversationEvent } from "./types.js";
import type { IdGenerator } from "./use-cases.js";

const userEvent: ConversationEvent = {
  id: "event-dnd",
  conversationId: "conversation",
  actor: "user",
  occurredAt: "2026-09-03T08:00:00.000Z",
  content: "这周先别主动联系我，下周再说。",
};

function ids(): IdGenerator {
  let sequence = 0;
  return (kind) => `${kind}-${++sequence}`;
}

function generator(...drafts: ContactPolicySignalDraft[]): PolicySignalGenerator {
  return {
    async generatePolicySignals() {
      return drafts;
    },
  };
}

describe("extractContactPolicySignals", () => {
  it("creates a formal signal whose occurrence time comes from user evidence", async () => {
    const result = await extractContactPolicySignals({
      events: [userEvent],
      clock: new FakeClock("2026-09-03T08:01:00.000Z"),
      idGenerator: ids(),
      generator: generator({
        kind: "set-do-not-disturb",
        evidenceRef: "event-dnd",
        reason: "The user explicitly paused proactive contact.",
        doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
      }),
      timeZone: "Asia/Hong_Kong",
    });

    expect(result).toEqual([{
      schemaVersion: "0.1.0",
      id: "policy-signal-1",
      kind: "set-do-not-disturb",
      evidenceRef: "event-dnd",
      occurredAt: userEvent.occurredAt,
      reason: "The user explicitly paused proactive contact.",
      doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
    }]);
  });

  it("allows the generator to return no global policy change", async () => {
    await expect(
      extractContactPolicySignals({
        events: [userEvent],
        clock: new FakeClock("2026-09-03T08:01:00.000Z"),
        idGenerator: ids(),
        generator: generator(),
      }),
    ).resolves.toEqual([]);
  });

  it("passes a defensive copy of the current policy to the generator", async () => {
    const currentPolicy = {
      authorization: "granted" as const,
      doNotDisturbUntil: "2026-09-07T00:00:00.000Z",
    };
    let observedAuthorization: string | undefined;
    await extractContactPolicySignals({
      events: [userEvent],
      clock: new FakeClock("2026-09-03T08:01:00.000Z"),
      idGenerator: ids(),
      currentPolicy,
      generator: {
        async generatePolicySignals(input) {
          observedAuthorization = input.currentPolicy?.authorization;
          if (input.currentPolicy) input.currentPolicy.authorization = "denied";
          return [];
        },
      },
    });

    expect(observedAuthorization).toBe("granted");
    expect(currentPolicy.authorization).toBe("granted");
  });

  it("rejects a signal that cites an assistant message", async () => {
    const assistantEvent = { ...userEvent, actor: "assistant" as const };
    await expect(
      extractContactPolicySignals({
        events: [assistantEvent],
        clock: new FakeClock("2026-09-03T08:01:00.000Z"),
        idGenerator: ids(),
        generator: generator({
          kind: "set-authorization",
          evidenceRef: assistantEvent.id,
          reason: "Assistant text cannot change user policy.",
          authorization: "denied",
        }),
      }),
    ).rejects.toThrow("must be user-authored");
  });

  it("rejects invented evidence references", async () => {
    await expect(
      extractContactPolicySignals({
        events: [userEvent],
        clock: new FakeClock("2026-09-03T08:01:00.000Z"),
        idGenerator: ids(),
        generator: generator({
          kind: "clear-do-not-disturb",
          evidenceRef: "invented-event",
          reason: "Invented evidence must fail.",
        }),
      }),
    ).rejects.toThrow(InvalidPolicySignalExtractionError);
  });

  it("rejects a do-not-disturb boundary before its evidence event", async () => {
    await expect(
      extractContactPolicySignals({
        events: [userEvent],
        clock: new FakeClock("2026-09-03T08:01:00.000Z"),
        idGenerator: ids(),
        generator: generator({
          kind: "set-do-not-disturb",
          evidenceRef: userEvent.id,
          reason: "Invalid temporal boundary.",
          doNotDisturbUntil: "2026-09-03T07:00:00.000Z",
        }),
      }),
    ).rejects.toThrow("later than its evidence event");
  });

  it("deduplicates identical drafts without suppressing a distinct policy change", async () => {
    const repeated: ContactPolicySignalDraft = {
      kind: "clear-do-not-disturb",
      evidenceRef: userEvent.id,
      reason: "Resume normal contact.",
    };
    const result = await extractContactPolicySignals({
      events: [userEvent],
      clock: new FakeClock("2026-09-03T08:01:00.000Z"),
      idGenerator: ids(),
      generator: generator(
        repeated,
        repeated,
        {
          kind: "set-authorization",
          evidenceRef: userEvent.id,
          reason: "Proactive contact is allowed again.",
          authorization: "granted",
        },
      ),
    });

    expect(result.map((signal) => signal.kind)).toEqual([
      "clear-do-not-disturb",
      "set-authorization",
    ]);
  });
});
