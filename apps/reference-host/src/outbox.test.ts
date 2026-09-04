import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ContactDecision } from "@wakeintent/core";

import {
  JsonOutboxStore,
  OutboxConflictError,
} from "./outbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-outbox-"));
  temporaryDirectories.push(directory);
  return join(directory, "outbox.json");
}

function contactDecision(): ContactDecision {
  return {
    id: "decision:follow-up:1",
    intentId: "intent:follow-up",
    evaluatedAt: "2026-09-04T10:00:00.000Z",
    action: "contact",
    reason: "The follow-up remains useful and authorized.",
    evidenceRefs: ["event:initial"],
    counterEvidenceRefs: [],
    confidence: 0.92,
    nextEvaluationAt: null,
    policyVersion: "test-0.1",
  };
}

describe("JsonOutboxStore", () => {
  it("persists one item per contact decision and replays enqueue safely", async () => {
    const filePath = await temporaryFile();
    const store = await JsonOutboxStore.open(filePath);
    const input = {
      decision: contactDecision(),
      target: { kind: "user" as const, id: "user:1" },
    };

    const created = await store.enqueueContact(input);
    const duplicate = await store.enqueueContact(input);

    expect(created.outcome).toBe("created");
    expect(duplicate.outcome).toBe("duplicate");
    expect(await store.listItems()).toHaveLength(1);

    const reopened = await JsonOutboxStore.open(filePath);
    expect(await reopened.listItems()).toEqual([created.item]);
  });

  it("tracks generation, attempt, delivery, and idempotent receipts across restart", async () => {
    const filePath = await temporaryFile();
    const store = await JsonOutboxStore.open(filePath);
    const enqueue = await store.enqueueContact({
      decision: contactDecision(),
      target: { kind: "conversation", id: "conversation:1" },
    });
    const generated = {
      id: "receipt:generated:1",
      recordedAt: "2026-09-04T10:00:01.000Z",
      status: "generated" as const,
    };

    expect((await store.recordReceipt({ itemId: enqueue.item.id, receipt: generated })).outcome)
      .toBe("recorded");
    expect((await store.recordReceipt({ itemId: enqueue.item.id, receipt: generated })).outcome)
      .toBe("duplicate");
    await store.recordReceipt({
      itemId: enqueue.item.id,
      receipt: {
        id: "receipt:attempted:1",
        recordedAt: "2026-09-04T10:00:02.000Z",
        status: "attempted",
        providerMessageId: "provider-message:1",
      },
    });
    await store.recordReceipt({
      itemId: enqueue.item.id,
      receipt: {
        id: "receipt:delivered:1",
        recordedAt: "2026-09-04T10:00:03.000Z",
        status: "delivered",
        providerMessageId: "provider-message:1",
      },
    });

    const reopened = await JsonOutboxStore.open(filePath);
    const [item] = await reopened.listItems();
    expect(item?.status).toBe("delivered");
    expect(item?.receipts).toHaveLength(3);
  });

  it("rejects skipped or post-delivery state transitions", async () => {
    const store = await JsonOutboxStore.open(await temporaryFile());
    const enqueue = await store.enqueueContact({
      decision: contactDecision(),
      target: { kind: "user", id: "user:1" },
    });

    await expect(
      store.recordReceipt({
        itemId: enqueue.item.id,
        receipt: {
          id: "receipt:invalid",
          recordedAt: "2026-09-04T10:00:01.000Z",
          status: "delivered",
        },
      }),
    ).rejects.toBeInstanceOf(OutboxConflictError);
  });
});
