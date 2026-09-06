import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationEventStoreConflictError,
  JsonConversationEventStore,
} from "./event-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-events-"));
  temporaryDirectories.push(directory);
  return join(directory, "events.json");
}

const event = {
  id: "event:study-plan",
  conversationId: "conversation:study",
  actor: "user" as const,
  occurredAt: "2026-09-04T09:00:00.000Z",
  content: "I plan to finish chapter three tomorrow.",
};

describe("JsonConversationEventStore", () => {
  it("persists a completed batch and returns duplicate without new work", async () => {
    const filePath = await temporaryFile();
    const store = await JsonConversationEventStore.open(filePath);
    const input = {
      events: [event],
      idempotencyKey: "ingest:study:1",
      fingerprint: "fingerprint:1",
      acceptedAt: "2026-09-04T09:01:00.000Z",
    };

    expect((await store.appendBatch(input)).outcome).toBe("created");
    await store.recordPlan(input.idempotencyKey, { intents: [], selections: [] });
    await store.completeBatch(input.idempotencyKey, input.acceptedAt);

    const reopened = await JsonConversationEventStore.open(filePath);
    const replay = await reopened.appendBatch(input);
    expect(replay.outcome).toBe("duplicate");
    expect(replay.batch.status).toBe("completed");
    expect(await reopened.listEvents({ conversationId: event.conversationId })).toEqual([event]);
  });

  it("resumes a pending batch with its persisted plan after restart", async () => {
    const filePath = await temporaryFile();
    const store = await JsonConversationEventStore.open(filePath);
    const input = {
      events: [event],
      idempotencyKey: "ingest:study:resume",
      fingerprint: "fingerprint:resume",
      acceptedAt: "2026-09-04T09:01:00.000Z",
    };
    await store.appendBatch(input);
    await store.recordPlan(input.idempotencyKey, { intents: [], selections: [] });

    const reopened = await JsonConversationEventStore.open(filePath);
    const resume = await reopened.appendBatch(input);
    expect(resume.outcome).toBe("resume");
    expect(resume.batch.plan).toEqual({ intents: [], selections: [] });
  });

  it("rejects an idempotency key reused with different input", async () => {
    const store = await JsonConversationEventStore.open(await temporaryFile());
    await store.appendBatch({
      events: [event],
      idempotencyKey: "ingest:study:conflict",
      fingerprint: "fingerprint:a",
      acceptedAt: "2026-09-04T09:01:00.000Z",
    });

    await expect(
      store.appendBatch({
        events: [event],
        idempotencyKey: "ingest:study:conflict",
        fingerprint: "fingerprint:b",
        acceptedAt: "2026-09-04T09:01:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ConversationEventStoreConflictError);
  });

  it("rejects a saved routing plan that references an event outside its batch", async () => {
    const store = await JsonConversationEventStore.open(await temporaryFile());
    await store.appendBatch({
      events: [event],
      idempotencyKey: "ingest:study:invalid-plan",
      fingerprint: "fingerprint:invalid-plan",
      acceptedAt: "2026-09-04T09:01:00.000Z",
    });

    await expect(
      store.recordPlan("ingest:study:invalid-plan", {
        intents: [],
        selections: [
          {
            intentId: "intent:other",
            eventIds: ["event:outside-batch"],
            effect: "reevaluate",
            reason: "This event is not part of the accepted batch.",
            confidence: 0.9,
          },
        ],
      }),
    ).rejects.toThrow("outside its batch");
  });
});
