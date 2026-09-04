import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  rename,
  rm,
  mkdir,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  InMemoryContactIntentStore,
  type ActivateContactIntentInput,
  type ActivateContactIntentResult,
  type CommitContactDecisionInput,
  type CommitContactDecisionResult,
  type ContactDecision,
  type ContactIntentAuditEvent,
  type ContactIntentQuery,
  type ContactIntentStore,
  type ContactIntentStoreSnapshot,
  type CreateContactIntentInput,
  type CreateContactIntentResult,
  type RecordEvaluationFailureInput,
  type RecordEvaluationFailureResult,
  type RequestContactIntentEvaluationInput,
  type RequestContactIntentEvaluationResult,
  type StoredContactIntent,
  type StoreIdempotencyEntry,
} from "@wakeintent/core";
import {
  validateContactIntent,
  validateContactIntentActivation,
  validateContactIntentEvaluationFailure,
  validateContactIntentEvaluationRequest,
  validateDecision,
} from "@wakeintent/schemas";

export class InvalidJsonStoreFileError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`Invalid WakeIntent store file ${filePath}: ${message}`);
    this.name = "InvalidJsonStoreFileError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class JsonStorePersistenceError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Could not persist WakeIntent store file ${filePath}`);
    this.name = "JsonStorePersistenceError";
    this.cause = cause;
  }
}

export type JsonStoreSnapshotWriter = (
  filePath: string,
  snapshot: ContactIntentStoreSnapshot,
) => Promise<void>;

export interface JsonContactIntentStoreOptions {
  /** Advanced seam for testing or a host-provided atomic persistence primitive. */
  snapshotWriter?: JsonStoreSnapshotWriter;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isDateTimeOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)))
  );
}

function validationDetails(
  errors: ReadonlyArray<{ instancePath: string; message?: string }>,
): string {
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

function parseSnapshot(value: unknown, filePath: string): ContactIntentStoreSnapshot {
  if (!isObject(value)) {
    throw new InvalidJsonStoreFileError(filePath, "top level must contain only the supported fields");
  }
  const isDecisionLegacy = value.schemaVersion === "0.1.0";
  const isEventLegacy = value.schemaVersion === "0.1.1";
  const isFailureLegacy = value.schemaVersion === "0.1.2";
  const isCurrent = value.schemaVersion === "0.1.3";
  const allowedKeys = isDecisionLegacy
    ? ["schemaVersion", "records", "decisions", "idempotency"]
    : ["schemaVersion", "records", "events", "idempotency"];
  if (
    (!isDecisionLegacy && !isEventLegacy && !isFailureLegacy && !isCurrent) ||
    !hasOnlyKeys(value, allowedKeys)
  ) {
    throw new InvalidJsonStoreFileError(
      filePath,
      `unsupported schemaVersion ${String(value.schemaVersion)}`,
    );
  }
  const rawEvents = isDecisionLegacy ? value.decisions : value.events;
  if (!Array.isArray(value.records) || !Array.isArray(rawEvents) || !Array.isArray(value.idempotency)) {
    throw new InvalidJsonStoreFileError(filePath, "records, audit events, and idempotency must be arrays");
  }

  const records: StoredContactIntent[] = value.records.map((raw, index) => {
    if (!isObject(raw) || !hasOnlyKeys(raw, ["intent", "revision", "nextEvaluationAt"])) {
      throw new InvalidJsonStoreFileError(filePath, `records[${index}] has an invalid shape`);
    }
    const intentResult = validateContactIntent(raw.intent);
    if (!intentResult.valid) {
      throw new InvalidJsonStoreFileError(
        filePath,
        `records[${index}].intent ${validationDetails(intentResult.errors)}`,
      );
    }
    if (!Number.isInteger(raw.revision) || (raw.revision as number) <= 0) {
      throw new InvalidJsonStoreFileError(filePath, `records[${index}].revision must be a positive integer`);
    }
    if (!isDateTimeOrNull(raw.nextEvaluationAt)) {
      throw new InvalidJsonStoreFileError(filePath, `records[${index}].nextEvaluationAt must be a date-time or null`);
    }
    return {
      intent: raw.intent as StoredContactIntent["intent"],
      revision: raw.revision as number,
      nextEvaluationAt: raw.nextEvaluationAt,
    };
  });

  const events: ContactIntentAuditEvent[] = rawEvents.map((raw, index) => {
    if (isDecisionLegacy) {
      const result = validateDecision(raw);
      if (!result.valid) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `decisions[${index}] ${validationDetails(result.errors)}`,
        );
      }
      return { kind: "decision", decision: raw as ContactDecision };
    }
    const eventKeys = isObject(raw) && raw.kind === "activated"
      ? ["kind", "activation"]
      : isObject(raw) && raw.kind === "decision"
        ? ["kind", "decision"]
        : isObject(raw) && raw.kind === "evaluation-failed"
          ? ["kind", "failure"]
          : ["kind", "request"];
    if (!isObject(raw) || !hasOnlyKeys(raw, eventKeys)) {
      throw new InvalidJsonStoreFileError(filePath, `events[${index}] has an invalid shape`);
    }
    if (raw.kind === "activated") {
      const result = validateContactIntentActivation(raw.activation);
      if (!result.valid) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `events[${index}].activation ${validationDetails(result.errors)}`,
        );
      }
      return raw as unknown as ContactIntentAuditEvent;
    }
    if (raw.kind === "decision") {
      const result = validateDecision(raw.decision);
      if (!result.valid) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `events[${index}].decision ${validationDetails(result.errors)}`,
        );
      }
      return raw as unknown as ContactIntentAuditEvent;
    }
    if (raw.kind === "evaluation-failed" && (isFailureLegacy || isCurrent)) {
      const result = validateContactIntentEvaluationFailure(raw.failure);
      if (!result.valid) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `events[${index}].failure ${validationDetails(result.errors)}`,
        );
      }
      return raw as unknown as ContactIntentAuditEvent;
    }
    if (raw.kind === "evaluation-requested" && isCurrent) {
      const result = validateContactIntentEvaluationRequest(raw.request);
      if (!result.valid) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `events[${index}].request ${validationDetails(result.errors)}`,
        );
      }
      return raw as unknown as ContactIntentAuditEvent;
    }
    throw new InvalidJsonStoreFileError(filePath, `events[${index}].kind is unsupported`);
  });

  const idempotency: StoreIdempotencyEntry[] = value.idempotency.map(
    (raw, index) => {
      if (
        !isObject(raw) ||
        !hasOnlyKeys(raw, isDecisionLegacy
          ? ["scope", "key", "fingerprint", "intentId", "decisionId"]
          : ["scope", "key", "fingerprint", "intentId", "operationId"]) ||
        (raw.scope !== "create-intent" &&
          raw.scope !== "activate-intent" &&
          raw.scope !== "commit-decision" &&
          !((isFailureLegacy || isCurrent) && raw.scope === "record-failure") &&
          !(isCurrent && raw.scope === "request-evaluation")) ||
        typeof raw.key !== "string" ||
        raw.key.length === 0 ||
        typeof raw.fingerprint !== "string" ||
        typeof raw.intentId !== "string" ||
        raw.intentId.length === 0 ||
        ((isDecisionLegacy ? raw.decisionId : raw.operationId) !== null &&
          typeof (isDecisionLegacy ? raw.decisionId : raw.operationId) !== "string")
      ) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `idempotency[${index}] has an invalid shape`,
        );
      }
      const operationId = isDecisionLegacy ? raw.decisionId : raw.operationId;
      if (raw.scope === "create-intent" && operationId !== null) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `idempotency[${index}] create entry cannot reference an audit event`,
        );
      }
      if (
        raw.scope !== "create-intent" &&
        (typeof operationId !== "string" || operationId.length === 0)
      ) {
        throw new InvalidJsonStoreFileError(
          filePath,
          `idempotency[${index}] operation entry must reference an audit event`,
        );
      }
      return {
        scope: raw.scope,
        key: raw.key,
        fingerprint: raw.fingerprint,
        intentId: raw.intentId,
        operationId: operationId as string | null,
      } as StoreIdempotencyEntry;
    },
  );

  return { schemaVersion: "0.1.3", records, events, idempotency };
}

async function writeSnapshotAtomically(
  filePath: string,
  snapshot: ContactIntentStoreSnapshot,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = resolve(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class JsonContactIntentStore implements ContactIntentStore {
  readonly filePath: string;
  readonly #snapshotWriter: JsonStoreSnapshotWriter;
  #memory: InMemoryContactIntentStore;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(
    filePath: string,
    memory: InMemoryContactIntentStore,
    snapshotWriter: JsonStoreSnapshotWriter,
  ) {
    this.filePath = filePath;
    this.#memory = memory;
    this.#snapshotWriter = snapshotWriter;
  }

  static async open(
    filePath: string,
    options: JsonContactIntentStoreOptions = {},
  ): Promise<JsonContactIntentStore> {
    const absolutePath = resolve(filePath);
    let snapshot: ContactIntentStoreSnapshot | undefined;
    try {
      const raw = await readFile(absolutePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new InvalidJsonStoreFileError(absolutePath, "file is not valid JSON", error);
      }
      snapshot = parseSnapshot(parsed, absolutePath);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        snapshot = undefined;
      } else if (error instanceof InvalidJsonStoreFileError) {
        throw error;
      } else {
        throw new InvalidJsonStoreFileError(
          absolutePath,
          error instanceof Error ? error.message : "could not read snapshot",
          error,
        );
      }
    }

    try {
      return new JsonContactIntentStore(
        absolutePath,
        new InMemoryContactIntentStore(snapshot),
        options.snapshotWriter ?? writeSnapshotAtomically,
      );
    } catch (error) {
      throw new InvalidJsonStoreFileError(
        absolutePath,
        error instanceof Error ? error.message : "snapshot invariants are invalid",
        error,
      );
    }
  }

  async createIntent(
    input: CreateContactIntentInput,
  ): Promise<CreateContactIntentResult> {
    return this.#mutate((staged) => staged.createIntent(input));
  }

  async activateIntent(
    input: ActivateContactIntentInput,
  ): Promise<ActivateContactIntentResult> {
    return this.#mutate((staged) => staged.activateIntent(input));
  }

  async getIntent(intentId: string): Promise<StoredContactIntent | null> {
    await this.#mutationTail;
    return this.#memory.getIntent(intentId);
  }

  async listIntents(query?: ContactIntentQuery): Promise<StoredContactIntent[]> {
    await this.#mutationTail;
    return query === undefined
      ? this.#memory.listIntents()
      : this.#memory.listIntents(query);
  }

  async commitDecision(
    input: CommitContactDecisionInput,
  ): Promise<CommitContactDecisionResult> {
    return this.#mutate((staged) => staged.commitDecision(input));
  }

  async recordEvaluationFailure(
    input: RecordEvaluationFailureInput,
  ): Promise<RecordEvaluationFailureResult> {
    return this.#mutate((staged) => staged.recordEvaluationFailure(input));
  }

  async requestEvaluation(
    input: RequestContactIntentEvaluationInput,
  ): Promise<RequestContactIntentEvaluationResult> {
    return this.#mutate((staged) => staged.requestEvaluation(input));
  }

  async listAuditEvents(intentId: string): Promise<ContactIntentAuditEvent[]> {
    await this.#mutationTail;
    return this.#memory.listAuditEvents(intentId);
  }

  async listDecisions(intentId: string): Promise<ContactDecision[]> {
    await this.#mutationTail;
    return this.#memory.listDecisions(intentId);
  }

  async #mutate<T>(
    operation: (staged: InMemoryContactIntentStore) => Promise<T>,
  ): Promise<T> {
    const pending = this.#mutationTail.then(async () => {
      const staged = new InMemoryContactIntentStore(this.#memory.exportSnapshot());
      const result = await operation(staged);
      try {
        await this.#snapshotWriter(this.filePath, staged.exportSnapshot());
      } catch (error) {
        throw new JsonStorePersistenceError(this.filePath, error);
      }
      this.#memory = staged;
      return result;
    });
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export async function openJsonContactIntentStore(
  filePath: string,
  options?: JsonContactIntentStoreOptions,
): Promise<JsonContactIntentStore> {
  return options === undefined
    ? JsonContactIntentStore.open(filePath)
    : JsonContactIntentStore.open(filePath, options);
}
