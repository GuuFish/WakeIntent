import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { ContactDecision, ContactTarget } from "@wakeintent/core";

export type OutboxStatus =
  | "awaiting-generation"
  | "generated"
  | "attempted"
  | "delivered"
  | "failed";

export type DeliveryReceiptStatus = Exclude<
  OutboxStatus,
  "awaiting-generation"
>;

export interface DeliveryReceipt {
  id: string;
  recordedAt: string;
  status: DeliveryReceiptStatus;
  providerMessageId?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboxItem {
  id: string;
  decisionId: string;
  intentId: string;
  target: ContactTarget;
  createdAt: string;
  status: OutboxStatus;
  receipts: DeliveryReceipt[];
}

export interface OutboxSnapshot {
  schemaVersion: "0.1.0";
  items: OutboxItem[];
}

export interface EnqueueContactInput {
  decision: ContactDecision;
  target: ContactTarget;
}

export interface EnqueueContactResult {
  outcome: "created" | "duplicate";
  item: OutboxItem;
}

export interface RecordDeliveryReceiptInput {
  itemId: string;
  receipt: DeliveryReceipt;
}

export interface RecordDeliveryReceiptResult {
  outcome: "recorded" | "duplicate";
  item: OutboxItem;
  receipt: DeliveryReceipt;
}

export class InvalidOutboxInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOutboxInputError";
  }
}

export class OutboxNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Outbox item ${itemId} was not found`);
    this.name = "OutboxNotFoundError";
  }
}

export class OutboxConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxConflictError";
  }
}

export class InvalidOutboxFileError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`Invalid WakeIntent outbox file ${filePath}: ${message}`);
    this.name = "InvalidOutboxFileError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class OutboxPersistenceError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Could not persist WakeIntent outbox file ${filePath}`);
    this.name = "OutboxPersistenceError";
    this.cause = cause;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidOutboxInputError(`${label} must not be empty`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InvalidOutboxInputError(`${label} must be a valid date-time`);
  }
}

function validateTarget(target: ContactTarget): void {
  if (!["user", "conversation", "participant"].includes(target.kind)) {
    throw new InvalidOutboxInputError("target.kind is unsupported");
  }
  requireNonEmpty(target.id, "target.id");
}

function validateReceipt(receipt: DeliveryReceipt): void {
  requireNonEmpty(receipt.id, "receipt.id");
  requireTimestamp(receipt.recordedAt, "receipt.recordedAt");
  if (!["generated", "attempted", "delivered", "failed"].includes(receipt.status)) {
    throw new InvalidOutboxInputError(`receipt.status ${String(receipt.status)} is unsupported`);
  }
  if (receipt.providerMessageId !== undefined) {
    requireNonEmpty(receipt.providerMessageId, "receipt.providerMessageId");
  }
  if (receipt.errorCode !== undefined) {
    requireNonEmpty(receipt.errorCode, "receipt.errorCode");
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<OutboxStatus, DeliveryReceiptStatus[]>> = {
  "awaiting-generation": ["generated", "failed"],
  generated: ["attempted", "failed"],
  attempted: ["delivered", "failed"],
  failed: ["attempted"],
  delivered: [],
};

function parseReceipt(value: unknown, label: string): DeliveryReceipt {
  if (!isObject(value)) throw new InvalidOutboxInputError(`${label} must be an object`);
  const receipt = value as unknown as DeliveryReceipt;
  validateReceipt(receipt);
  return clone(receipt);
}

function parseSnapshot(value: unknown, filePath: string): OutboxSnapshot {
  try {
    if (!isObject(value) || value.schemaVersion !== "0.1.0" || !Array.isArray(value.items)) {
      throw new InvalidOutboxInputError("top level must be a 0.1.0 snapshot with an items array");
    }
    const itemIds = new Set<string>();
    const decisionIds = new Set<string>();
    const items = value.items.map((raw, index): OutboxItem => {
      if (!isObject(raw) || !Array.isArray(raw.receipts) || !isObject(raw.target)) {
        throw new InvalidOutboxInputError(`items[${index}] has an invalid shape`);
      }
      const item = raw as unknown as OutboxItem;
      requireNonEmpty(item.id, `items[${index}].id`);
      requireNonEmpty(item.decisionId, `items[${index}].decisionId`);
      requireNonEmpty(item.intentId, `items[${index}].intentId`);
      requireTimestamp(item.createdAt, `items[${index}].createdAt`);
      validateTarget(item.target);
      if (!Object.hasOwn(ALLOWED_TRANSITIONS, item.status)) {
        throw new InvalidOutboxInputError(`items[${index}].status is unsupported`);
      }
      if (itemIds.has(item.id) || decisionIds.has(item.decisionId)) {
        throw new InvalidOutboxInputError(`items[${index}] duplicates an item or decision id`);
      }
      itemIds.add(item.id);
      decisionIds.add(item.decisionId);
      const receipts = raw.receipts.map((receipt, receiptIndex) =>
        parseReceipt(receipt, `items[${index}].receipts[${receiptIndex}]`),
      );
      const receiptIds = new Set(receipts.map((receipt) => receipt.id));
      if (receiptIds.size !== receipts.length) {
        throw new InvalidOutboxInputError(`items[${index}] has duplicate receipt ids`);
      }
      let previousStatus: OutboxStatus = "awaiting-generation";
      let previousTime = Date.parse(item.createdAt);
      for (const receipt of receipts) {
        if (!ALLOWED_TRANSITIONS[previousStatus].includes(receipt.status)) {
          throw new InvalidOutboxInputError(
            `items[${index}] contains an invalid ${previousStatus} to ${receipt.status} transition`,
          );
        }
        const receiptTime = Date.parse(receipt.recordedAt);
        if (receiptTime < previousTime) {
          throw new InvalidOutboxInputError(
            `items[${index}] receipt times must be monotonic and not predate the item`,
          );
        }
        previousStatus = receipt.status;
        previousTime = receiptTime;
      }
      const resultingStatus = receipts.at(-1)?.status ?? "awaiting-generation";
      if (resultingStatus !== item.status) {
        throw new InvalidOutboxInputError(`items[${index}].status does not match its receipts`);
      }
      return { ...clone(item), receipts };
    });
    return { schemaVersion: "0.1.0", items };
  } catch (error) {
    if (error instanceof InvalidOutboxInputError) {
      throw new InvalidOutboxFileError(filePath, error.message, error);
    }
    throw error;
  }
}

async function writeSnapshotAtomically(
  filePath: string,
  snapshot: OutboxSnapshot,
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

export class JsonOutboxStore {
  readonly filePath: string;
  #snapshot: OutboxSnapshot;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, snapshot: OutboxSnapshot) {
    this.filePath = filePath;
    this.#snapshot = snapshot;
  }

  static async open(filePath: string): Promise<JsonOutboxStore> {
    const absolutePath = resolve(filePath);
    let snapshot: OutboxSnapshot = { schemaVersion: "0.1.0", items: [] };
    try {
      const raw = await readFile(absolutePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new InvalidOutboxFileError(absolutePath, "file is not valid JSON", error);
      }
      snapshot = parseSnapshot(parsed, absolutePath);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        // A missing file is an empty outbox and will be created on first mutation.
      } else if (error instanceof InvalidOutboxFileError) {
        throw error;
      } else {
        throw new InvalidOutboxFileError(
          absolutePath,
          error instanceof Error ? error.message : "could not read snapshot",
          error,
        );
      }
    }
    return new JsonOutboxStore(absolutePath, snapshot);
  }

  async enqueueContact(input: EnqueueContactInput): Promise<EnqueueContactResult> {
    if (input.decision.action !== "contact") {
      throw new InvalidOutboxInputError("Only contact decisions can enter the outbox");
    }
    requireNonEmpty(input.decision.id, "decision.id");
    requireNonEmpty(input.decision.intentId, "decision.intentId");
    requireTimestamp(input.decision.evaluatedAt, "decision.evaluatedAt");
    validateTarget(input.target);

    return this.#mutate((staged) => {
      const existing = staged.items.find((item) => item.decisionId === input.decision.id);
      if (existing) {
        const expected = {
          decisionId: input.decision.id,
          intentId: input.decision.intentId,
          target: input.target,
          createdAt: input.decision.evaluatedAt,
        };
        const actual = {
          decisionId: existing.decisionId,
          intentId: existing.intentId,
          target: existing.target,
          createdAt: existing.createdAt,
        };
        if (stableStringify(expected) !== stableStringify(actual)) {
          throw new OutboxConflictError(
            `Decision ${input.decision.id} is already linked to different outbox data`,
          );
        }
        return { outcome: "duplicate", item: clone(existing) };
      }

      const item: OutboxItem = {
        id: `outbox:${input.decision.id}`,
        decisionId: input.decision.id,
        intentId: input.decision.intentId,
        target: clone(input.target),
        createdAt: input.decision.evaluatedAt,
        status: "awaiting-generation",
        receipts: [],
      };
      staged.items.push(item);
      return { outcome: "created", item: clone(item) };
    });
  }

  async recordReceipt(
    input: RecordDeliveryReceiptInput,
  ): Promise<RecordDeliveryReceiptResult> {
    requireNonEmpty(input.itemId, "itemId");
    validateReceipt(input.receipt);
    return this.#mutate((staged) => {
      const item = staged.items.find((candidate) => candidate.id === input.itemId);
      if (!item) throw new OutboxNotFoundError(input.itemId);
      const existing = item.receipts.find((receipt) => receipt.id === input.receipt.id);
      if (existing) {
        if (stableStringify(existing) !== stableStringify(input.receipt)) {
          throw new OutboxConflictError(
            `Receipt ${input.receipt.id} was already used with different input`,
          );
        }
        return {
          outcome: "duplicate",
          item: clone(item),
          receipt: clone(existing),
        };
      }
      if (!ALLOWED_TRANSITIONS[item.status].includes(input.receipt.status)) {
        throw new OutboxConflictError(
          `Cannot transition outbox item ${item.id} from ${item.status} to ${input.receipt.status}`,
        );
      }
      const previousTime = Date.parse(item.receipts.at(-1)?.recordedAt ?? item.createdAt);
      if (Date.parse(input.receipt.recordedAt) < previousTime) {
        throw new OutboxConflictError(
          `Receipt ${input.receipt.id} cannot predate the item or its latest receipt`,
        );
      }
      const receipt = clone(input.receipt);
      item.receipts.push(receipt);
      item.status = receipt.status;
      return { outcome: "recorded", item: clone(item), receipt: clone(receipt) };
    });
  }

  async getItem(itemId: string): Promise<OutboxItem | null> {
    requireNonEmpty(itemId, "itemId");
    await this.#mutationTail;
    const item = this.#snapshot.items.find((candidate) => candidate.id === itemId);
    return item ? clone(item) : null;
  }

  async listItems(): Promise<OutboxItem[]> {
    await this.#mutationTail;
    return clone(this.#snapshot.items);
  }

  async #mutate<T>(operation: (snapshot: OutboxSnapshot) => T): Promise<T> {
    const pending = this.#mutationTail.then(async () => {
      const staged = clone(this.#snapshot);
      const result = operation(staged);
      try {
        await writeSnapshotAtomically(this.filePath, staged);
      } catch (error) {
        throw new OutboxPersistenceError(this.filePath, error);
      }
      this.#snapshot = staged;
      return result;
    });
    this.#mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}
