import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ContactIntentStoreConflictError,
  evaluateDueContactIntents,
  FakeClock,
  type ContactDecision,
  type ContactIntent,
  type ContactIntentActivation,
  type ContactIntentEvaluationFailure,
  type ContactIntentEvaluationRequest,
} from "@wakeintent/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidJsonStoreFileError,
  JsonStorePersistenceError,
  openJsonContactIntentStore,
} from "./index.js";

const temporaryDirectories: string[] = [];

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wakeintent-store-json-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "wakeintent.json");
}

function intent(id: string): ContactIntent {
  const now = "2026-09-01T00:00:00.000Z";
  return {
    schemaVersion: "0.1.0",
    id,
    status: "active",
    subject: `Follow up ${id}`,
    reason: "The user expects a future outcome.",
    target: { kind: "user", id: "user-1" },
    evidence: [{ eventId: `event-${id}` }],
    notBefore: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-11T09:00:00.000Z",
    cancellationHints: ["The outcome already happened"],
    priority: 0.7,
    interruptionCost: 0.3,
    confidence: 0.9,
    createdAt: now,
    updatedAt: now,
  };
}

function cancelDecision(intentId: string): ContactDecision {
  return {
    id: `decision-${intentId}`,
    intentId,
    evaluatedAt: "2026-09-03T00:00:00.000Z",
    action: "cancel",
    reason: "The user said the plan is no longer relevant.",
    evidenceRefs: [`cancel-event-${intentId}`],
    counterEvidenceRefs: [],
    confidence: 0.98,
    nextEvaluationAt: null,
    policyVersion: "test-1",
  };
}

function activation(intentId: string): ContactIntentActivation {
  return {
    id: `activation-${intentId}`,
    intentId,
    activatedAt: "2026-09-02T00:00:00.000Z",
    reason: "The user confirmed this follow-up is worth tracking.",
    evidenceRefs: [`confirm-${intentId}`],
    nextEvaluationAt: "2026-09-04T09:00:00.000Z",
    policyVersion: "activation-test-1",
  };
}

function evaluationFailure(intentId: string): ContactIntentEvaluationFailure {
  return {
    id: `failure-${intentId}`,
    intentId,
    failedAt: "2026-09-04T10:00:00.000Z",
    stage: "semantic",
    code: "ModelProtocolError",
    attempt: 1,
    exhausted: false,
    nextEvaluationAt: "2026-09-04T10:01:00.000Z",
    policyVersion: "default-0.1",
  };
}

function evaluationRequest(intentId: string): ContactIntentEvaluationRequest {
  return {
    id: `evaluation-request-${intentId}`,
    intentId,
    requestedAt: "2026-09-03T12:00:00.000Z",
    eventIds: ["found-internship"],
    effect: "cancel",
    reason: "The new event invalidates the planned follow-up.",
    confidence: 0.99,
    nextEvaluationAt: "2026-09-03T12:00:00.000Z",
    policyVersion: "route-0.1",
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonContactIntentStore", () => {
  it("recovers intent state and decision audit after restart", async () => {
    const path = await storePath();
    const first = await openJsonContactIntentStore(path);
    const value = intent("intent-1");
    await first.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    await first.commitDecision({
      intentId: value.id,
      expectedRevision: 1,
      decision: cancelDecision(value.id),
      idempotencyKey: "cancel-1",
    });

    const restarted = await openJsonContactIntentStore(path);

    expect((await restarted.getIntent(value.id))?.intent.status).toBe(
      "cancelled",
    );
    expect((await restarted.getIntent(value.id))?.revision).toBe(2);
    expect(await restarted.listDecisions(value.id)).toEqual([
      cancelDecision(value.id),
    ]);
  });

  it("preserves idempotency across restart", async () => {
    const path = await storePath();
    const value = intent("intent-1");
    const createInput = {
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    };
    const commitInput = {
      intentId: value.id,
      expectedRevision: 1,
      decision: cancelDecision(value.id),
      idempotencyKey: "cancel-1",
    };
    const first = await openJsonContactIntentStore(path);
    await first.createIntent(createInput);
    await first.commitDecision(commitInput);

    const restarted = await openJsonContactIntentStore(path);

    expect((await restarted.createIntent(createInput)).outcome).toBe(
      "duplicate",
    );
    expect((await restarted.commitDecision(commitInput)).outcome).toBe(
      "duplicate",
    );
    expect((await restarted.listDecisions(value.id)).length).toBe(1);
  });

  it("serializes concurrent writes without losing records", async () => {
    const path = await storePath();
    const store = await openJsonContactIntentStore(path);
    const values = Array.from({ length: 12 }, (_, index) =>
      intent(`intent-${index + 1}`),
    );

    await Promise.all(
      values.map((value) =>
        store.createIntent({
          intent: value,
          nextEvaluationAt: value.notBefore,
          idempotencyKey: `create-${value.id}`,
        }),
      ),
    );

    expect((await store.listIntents()).length).toBe(12);
    const restarted = await openJsonContactIntentStore(path);
    expect((await restarted.listIntents()).length).toBe(12);
  });

  it("keeps optimistic revision conflicts after the persistence boundary", async () => {
    const path = await storePath();
    const store = await openJsonContactIntentStore(path);
    const value = intent("intent-1");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    await store.commitDecision({
      intentId: value.id,
      expectedRevision: 1,
      decision: {
        ...cancelDecision(value.id),
        id: "decision-defer",
        action: "defer",
        nextEvaluationAt: "2026-09-05T00:00:00.000Z",
      },
      idempotencyKey: "defer-1",
    });

    await expect(
      store.commitDecision({
        intentId: value.id,
        expectedRevision: 1,
        decision: cancelDecision(value.id),
        idempotencyKey: "stale-cancel",
      }),
    ).rejects.toThrow(ContactIntentStoreConflictError);
    expect((await store.getIntent(value.id))?.revision).toBe(2);
  });

  it("restores the due-query projection", async () => {
    const path = await storePath();
    const store = await openJsonContactIntentStore(path);
    const due = intent("due");
    const later = intent("later");
    await store.createIntent({
      intent: due,
      nextEvaluationAt: "2026-09-04T09:00:00.000Z",
      idempotencyKey: "create-due",
    });
    await store.createIntent({
      intent: later,
      nextEvaluationAt: "2026-09-06T09:00:00.000Z",
      idempotencyKey: "create-later",
    });

    const restarted = await openJsonContactIntentStore(path);
    const records = await restarted.listIntents({
      dueAtOrBefore: "2026-09-05T00:00:00.000Z",
    });
    expect(records.map((record) => record.intent.id)).toEqual(["due"]);
  });

  it("persists candidate activation as a first-class audit event", async () => {
    const path = await storePath();
    const store = await openJsonContactIntentStore(path);
    const candidate = { ...intent("candidate-1"), status: "candidate" as const };
    await store.createIntent({
      intent: candidate,
      nextEvaluationAt: null,
      idempotencyKey: "create-candidate",
    });
    await store.activateIntent({
      intentId: candidate.id,
      expectedRevision: 1,
      activation: activation(candidate.id),
      idempotencyKey: "activate-candidate",
    });

    const restarted = await openJsonContactIntentStore(path);
    const record = await restarted.getIntent(candidate.id);
    expect(record?.intent.status).toBe("active");
    expect(record?.revision).toBe(2);
    expect(record?.nextEvaluationAt).toBe("2026-09-04T09:00:00.000Z");
    expect(await restarted.listAuditEvents(candidate.id)).toEqual([
      { kind: "activated", activation: activation(candidate.id) },
    ]);
  });

  it("recovers retry state and failure idempotency after restart", async () => {
    const path = await storePath();
    const value = intent("retry-intent");
    const failure = evaluationFailure(value.id);
    const input = {
      intentId: value.id,
      expectedRevision: 1,
      failure,
      idempotencyKey: "record-failure-1",
    };
    const first = await openJsonContactIntentStore(path);
    await first.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-retry-intent",
    });
    await first.recordEvaluationFailure(input);

    const restarted = await openJsonContactIntentStore(path);

    expect(await restarted.getIntent(value.id)).toMatchObject({
      revision: 2,
      nextEvaluationAt: failure.nextEvaluationAt,
      intent: { status: "active", updatedAt: value.updatedAt },
    });
    expect(await restarted.listAuditEvents(value.id)).toEqual([
      { kind: "evaluation-failed", failure },
    ]);
    expect((await restarted.recordEvaluationFailure(input)).outcome).toBe(
      "duplicate",
    );
  });

  it("recovers a routed evaluation request after restart", async () => {
    const path = await storePath();
    const value = intent("routed-intent");
    const request = evaluationRequest(value.id);
    const first = await openJsonContactIntentStore(path);
    await first.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-routed-intent",
    });
    await first.requestEvaluation({
      intentId: value.id,
      expectedRevision: 1,
      request,
      idempotencyKey: "route-routed-intent",
    });

    const restarted = await openJsonContactIntentStore(path);

    expect(await restarted.getIntent(value.id)).toMatchObject({
      revision: 2,
      nextEvaluationAt: request.nextEvaluationAt,
      intent: { status: "active", updatedAt: value.updatedAt },
    });
    expect(await restarted.listAuditEvents(value.id)).toEqual([
      { kind: "evaluation-requested", request },
    ]);
  });

  it("closes a persisted invalidation after restart without another model call", async () => {
    const path = await storePath();
    const value = intent("restart-closure");
    const first = await openJsonContactIntentStore(path);
    await first.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-restart-closure",
    });
    await first.requestEvaluation({
      intentId: value.id,
      expectedRevision: 1,
      request: evaluationRequest(value.id),
      idempotencyKey: "route-restart-closure",
    });

    const restarted = await openJsonContactIntentStore(path);
    const result = await evaluateDueContactIntents({
      store: restarted,
      clock: new FakeClock("2026-09-03T12:00:00.000Z"),
      policyVersion: "default-0.1",
      contextProvider: {
        async load() {
          throw new Error("persisted route closure must not load context");
        },
      },
      semanticReevaluator: {
        async evaluate() {
          throw new Error("persisted route closure must not call the model");
        },
      },
    });

    expect(
      result.results[0]?.outcome === "committed"
        ? [result.results[0].source, result.results[0].decision.action]
        : null,
    ).toEqual(["route-closure", "cancel"]);
    expect((await restarted.getIntent(value.id))?.intent.status).toBe(
      "cancelled",
    );
  });

  it("reads a legacy 0.1.0 snapshot and upgrades it on the next write", async () => {
    const path = await storePath();
    await mkdir(dirname(path), { recursive: true });
    const value = intent("legacy-intent");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "0.1.0",
        records: [{ intent: value, revision: 1, nextEvaluationAt: value.notBefore }],
        decisions: [],
        idempotency: [
          {
            scope: "create-intent",
            key: "legacy-create",
            fingerprint: "legacy-fingerprint",
            intentId: value.id,
            decisionId: null,
          },
        ],
      }),
      "utf8",
    );

    const migrated = await openJsonContactIntentStore(path);
    const second = intent("new-intent");
    await migrated.createIntent({
      intent: second,
      nextEvaluationAt: second.notBefore,
      idempotencyKey: "new-create",
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
      events: unknown[];
    };
    expect(persisted.schemaVersion).toBe("0.1.3");
    expect(persisted.events).toEqual([]);
  });

  it("reads a 0.1.1 event snapshot and upgrades it on the next write", async () => {
    const path = await storePath();
    await mkdir(dirname(path), { recursive: true });
    const value = intent("event-legacy-intent");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "0.1.1",
        records: [{ intent: value, revision: 1, nextEvaluationAt: value.notBefore }],
        events: [],
        idempotency: [
          {
            scope: "create-intent",
            key: "event-legacy-create",
            fingerprint: "legacy-fingerprint",
            intentId: value.id,
            operationId: null,
          },
        ],
      }),
      "utf8",
    );

    const migrated = await openJsonContactIntentStore(path);
    const second = intent("new-after-event-legacy");
    await migrated.createIntent({
      intent: second,
      nextEvaluationAt: second.notBefore,
      idempotencyKey: "new-after-event-legacy-create",
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
    };
    expect(persisted.schemaVersion).toBe("0.1.3");
  });

  it("reads a 0.1.2 failure-capable snapshot and upgrades it", async () => {
    const path = await storePath();
    await mkdir(dirname(path), { recursive: true });
    const value = intent("failure-legacy-intent");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "0.1.2",
        records: [{ intent: value, revision: 1, nextEvaluationAt: value.notBefore }],
        events: [],
        idempotency: [
          {
            scope: "create-intent",
            key: "failure-legacy-create",
            fingerprint: "legacy-fingerprint",
            intentId: value.id,
            operationId: null,
          },
        ],
      }),
      "utf8",
    );

    const migrated = await openJsonContactIntentStore(path);
    const second = intent("new-after-failure-legacy");
    await migrated.createIntent({
      intent: second,
      nextEvaluationAt: second.notBefore,
      idempotencyKey: "new-after-failure-legacy-create",
    });

    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      schemaVersion: string;
    };
    expect(persisted.schemaVersion).toBe("0.1.3");
  });

  it("rejects corrupt JSON and does not overwrite it", async () => {
    const path = await storePath();
    await mkdir(dirname(path), { recursive: true });
    const corrupt = "{ definitely-not-json";
    await writeFile(path, corrupt, "utf8");

    await expect(openJsonContactIntentStore(path)).rejects.toThrow(
      InvalidJsonStoreFileError,
    );
    expect(await readFile(path, "utf8")).toBe(corrupt);
  });

  it("rejects structurally valid JSON with invalid domain data", async () => {
    const path = await storePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "0.1.0",
        records: [
          {
            intent: { id: "not-a-valid-contact-intent" },
            revision: 1,
            nextEvaluationAt: null,
          },
        ],
        decisions: [],
        idempotency: [],
      }),
      "utf8",
    );

    await expect(openJsonContactIntentStore(path)).rejects.toThrow(
      InvalidJsonStoreFileError,
    );
  });

  it("writes a versioned, inspectable snapshot without temporary leftovers", async () => {
    const path = await storePath();
    const store = await openJsonContactIntentStore(path);
    const value = intent("intent-1");
    await store.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });

    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { schemaVersion: string; records: unknown[] };
    expect(parsed.schemaVersion).toBe("0.1.3");
    expect(parsed.records.length).toBe(1);
    expect(raw).toContain("\n");
    expect(await readdir(dirname(path))).toEqual(["wakeintent.json"]);
  });

  it("keeps memory and the previous file unchanged when persistence fails", async () => {
    const path = await storePath();
    const value = intent("intent-1");
    const healthy = await openJsonContactIntentStore(path);
    await healthy.createIntent({
      intent: value,
      nextEvaluationAt: value.notBefore,
      idempotencyKey: "create-1",
    });
    const previousFile = await readFile(path, "utf8");

    const failing = await openJsonContactIntentStore(path, {
      snapshotWriter: async () => {
        throw new Error("simulated disk failure");
      },
    });
    await expect(
      failing.commitDecision({
        intentId: value.id,
        expectedRevision: 1,
        decision: cancelDecision(value.id),
        idempotencyKey: "cancel-1",
      }),
    ).rejects.toThrow(JsonStorePersistenceError);

    expect((await failing.getIntent(value.id))?.revision).toBe(1);
    expect((await failing.getIntent(value.id))?.intent.status).toBe("active");
    expect(await failing.listDecisions(value.id)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(previousFile);

    const restarted = await openJsonContactIntentStore(path);
    expect((await restarted.getIntent(value.id))?.revision).toBe(1);
  });
});
