import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { ContactDecision, ContactIntent } from "@wakeintent/core";
import { openJsonContactIntentStore } from "@wakeintent/store-json";

import { createReferenceHostHttpServer } from "./server.js";
import { ReferenceHostService } from "./service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryPaths() {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-host-"));
  temporaryDirectories.push(directory);
  return {
    intentStorePath: join(directory, "intents.json"),
    outboxPath: join(directory, "outbox.json"),
  };
}

function activeIntent(): ContactIntent {
  return {
    schemaVersion: "0.1.0",
    id: "intent:interview-result",
    status: "active",
    subject: "Interview result follow-up",
    reason: "The user expects an interview result this week.",
    target: { kind: "user", id: "user:1" },
    evidence: [{ eventId: "event:interview", quote: "I should hear back Friday." }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The user already received the result"],
    priority: 0.8,
    interruptionCost: 0.3,
    confidence: 0.94,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
  };
}

async function listen(server: ReturnType<typeof createReferenceHostHttpServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createReferenceHostHttpServer>) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function jsonRequest(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("ReferenceHostService", () => {
  it("recovers a contact decision committed before an outbox write", async () => {
    const paths = await temporaryPaths();
    const store = await openJsonContactIntentStore(paths.intentStorePath);
    const intent = activeIntent();
    const created = await store.createIntent({
      intent,
      nextEvaluationAt: intent.notBefore,
      idempotencyKey: "create:intent:1",
    });
    const decision: ContactDecision = {
      id: "decision:crash-window",
      intentId: intent.id,
      evaluatedAt: "2026-09-04T10:00:00.000Z",
      action: "contact",
      reason: "Still useful.",
      evidenceRefs: ["event:interview"],
      counterEvidenceRefs: [],
      confidence: 0.9,
      nextEvaluationAt: null,
      policyVersion: "test-0.1",
    };
    await store.commitDecision({
      intentId: intent.id,
      expectedRevision: created.record.revision,
      decision,
      idempotencyKey: "evaluate:intent:1",
    });

    // Opening the host simulates restart after the decision commit but before enqueue.
    const service = await ReferenceHostService.open(paths);
    expect(await service.listOutbox()).toMatchObject([
      { decisionId: decision.id, intentId: intent.id, status: "awaiting-generation" },
    ]);
    expect(await service.reconcile()).toEqual({
      contactDecisions: 1,
      created: 0,
      duplicates: 1,
    });
    expect(await service.listOutbox()).toHaveLength(1);
  });

  it("runs the structured HTTP flow and persists a delivery receipt", async () => {
    const paths = await temporaryPaths();
    const service = await ReferenceHostService.open(paths);
    const server = createReferenceHostHttpServer(service);
    const baseUrl = await listen(server);
    try {
      const health = await jsonRequest(`${baseUrl}/health`, "GET");
      expect(health.response.status).toBe(200);

      const intent = activeIntent();
      const registration = await jsonRequest(`${baseUrl}/v1/intents`, "POST", {
        intent,
        nextEvaluationAt: intent.notBefore,
        idempotencyKey: "api:create:intent:1",
      });
      expect(registration.response.status).toBe(201);

      const evaluation = await jsonRequest(`${baseUrl}/v1/evaluations`, "POST", {
        now: "2026-09-04T10:00:00.000Z",
        policyVersion: "reference-host-api-0.1",
        contexts: {
          [intent.id]: {
            latestEvents: [],
            userState: { authorization: "granted", remainingContactBudget: 1 },
            semanticProposal: {
              action: "contact",
              reason: "The result window is open and the reason remains current.",
              evidenceRefs: ["event:interview"],
              counterEvidenceRefs: [],
              confidence: 0.9,
              nextEvaluationAt: null,
            },
          },
        },
      });
      expect(evaluation.response.status).toBe(200);

      const outbox = await jsonRequest(`${baseUrl}/v1/outbox`, "GET");
      const [item] = outbox.body.items as Array<{ id: string; status: string }>;
      expect(item?.status).toBe("awaiting-generation");
      expect(item).toBeDefined();

      const generated = await jsonRequest(
        `${baseUrl}/v1/outbox/${encodeURIComponent(item?.id ?? "")}/receipts`,
        "POST",
        {
          id: "receipt:generated:api",
          recordedAt: "2026-09-04T10:00:01.000Z",
          status: "generated",
        },
      );
      expect(generated.response.status).toBe(201);
      expect((generated.body.item as { status: string }).status).toBe("generated");

      const receiptUrl = `${baseUrl}/v1/outbox/${encodeURIComponent(item?.id ?? "")}/receipts`;
      const attempted = await jsonRequest(receiptUrl, "POST", {
        id: "receipt:attempted:api",
        recordedAt: "2026-09-04T10:00:02.000Z",
        status: "attempted",
        providerMessageId: "provider-message:api",
      });
      expect(attempted.response.status).toBe(201);
      const delivered = await jsonRequest(receiptUrl, "POST", {
        id: "receipt:delivered:api",
        recordedAt: "2026-09-04T10:00:03.000Z",
        status: "delivered",
        providerMessageId: "provider-message:api",
      });
      expect(delivered.response.status).toBe(201);
      expect((delivered.body.item as { status: string }).status).toBe("delivered");
    } finally {
      await close(server);
    }

    const reopened = await ReferenceHostService.open(paths);
    expect(await reopened.listOutbox()).toMatchObject([
      {
        status: "delivered",
        receipts: [
          { id: "receipt:generated:api" },
          { id: "receipt:attempted:api" },
          { id: "receipt:delivered:api" },
        ],
      },
    ]);
  });

  it("rejects an evaluation before making partial changes when due context is missing", async () => {
    const service = await ReferenceHostService.open(await temporaryPaths());
    const intent = activeIntent();
    await service.registerIntent({
      intent,
      nextEvaluationAt: intent.notBefore,
      idempotencyKey: "create:missing-context",
    });

    await expect(
      service.runEvaluation({
        now: "2026-09-04T10:00:00.000Z",
        policyVersion: "test-0.1",
        contexts: {},
      }),
    ).rejects.toThrow(`contexts is missing due intent ${intent.id}`);
    expect((await service.intentStore.getIntent(intent.id))?.revision).toBe(1);
  });
});
