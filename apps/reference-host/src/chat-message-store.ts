import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface LocalChatMessage {
  id: string;
  conversationId: string;
  actor: "assistant";
  kind: "proactive";
  content: string;
  createdAt: string;
  sourceIntentId: string;
  sourceDecisionId: string;
  evidenceRefs: string[];
  metadata?: Record<string, unknown>;
}

export interface LocalChatMessageSnapshot {
  schemaVersion: "0.1.0";
  messages: LocalChatMessage[];
}

export interface AppendProactiveMessageInput {
  conversationId: string;
  content: string;
  createdAt: string;
  sourceIntentId: string;
  sourceDecisionId: string;
  evidenceRefs: string[];
  metadata?: Record<string, unknown>;
}

export interface AppendProactiveMessageResult {
  outcome: "created" | "duplicate";
  message: LocalChatMessage;
}

export class InvalidChatMessageInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidChatMessageInputError";
  }
}
export class InvalidChatMessageFileError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, message: string, cause?: unknown) {
    super(`Invalid WakeIntent chat message store ${filePath}: ${message}`);
    this.name = "InvalidChatMessageFileError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class ChatMessageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatMessageConflictError";
  }
}

export class ChatMessagePersistenceError extends Error {
  override readonly cause?: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Could not persist WakeIntent chat message store ${filePath}`);
    this.name = "ChatMessagePersistenceError";
    this.cause = cause;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidChatMessageInputError(`${label} must be a non-empty string`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InvalidChatMessageInputError(`${label} must be a valid date-time`);
  }
}

function validateInput(input: AppendProactiveMessageInput): void {
  requireNonEmpty(input.conversationId, "conversationId");
  requireNonEmpty(input.content, "content");
  requireTimestamp(input.createdAt, "createdAt");
  requireNonEmpty(input.sourceIntentId, "sourceIntentId");
  requireNonEmpty(input.sourceDecisionId, "sourceDecisionId");
  if (
    !Array.isArray(input.evidenceRefs) ||
    input.evidenceRefs.some(
      (eventId) => typeof eventId !== "string" || eventId.length === 0,
    )
  ) {
    throw new InvalidChatMessageInputError(
      "evidenceRefs must contain non-empty strings",
    );
  }
  if (input.metadata !== undefined && !isObject(input.metadata)) {
    throw new InvalidChatMessageInputError("metadata must be an object");
  }
}

function messageFromInput(input: AppendProactiveMessageInput): LocalChatMessage {
  return {
    id: `message:${input.sourceDecisionId}`,
    conversationId: input.conversationId,
    actor: "assistant",
    kind: "proactive",
    content: input.content,
    createdAt: input.createdAt,
    sourceIntentId: input.sourceIntentId,
    sourceDecisionId: input.sourceDecisionId,
    evidenceRefs: [...new Set(input.evidenceRefs)],
    ...(input.metadata === undefined ? {} : { metadata: clone(input.metadata) }),
  };
}

function parseSnapshot(
  value: unknown,
  filePath: string,
): LocalChatMessageSnapshot {
  try {
    if (
      !isObject(value) ||
      value.schemaVersion !== "0.1.0" ||
      !Array.isArray(value.messages)
    ) {
      throw new InvalidChatMessageInputError(
        "top level must be a 0.1.0 snapshot with a messages array",
      );
    }
    const decisionIds = new Set<string>();
    const messages = value.messages.map((raw, index) => {
      if (!isObject(raw)) {
        throw new InvalidChatMessageInputError(
          `messages[${index}] must be an object`,
        );
      }
      const input: AppendProactiveMessageInput = {
        conversationId: raw.conversationId as string,
        content: raw.content as string,
        createdAt: raw.createdAt as string,
        sourceIntentId: raw.sourceIntentId as string,
        sourceDecisionId: raw.sourceDecisionId as string,
        evidenceRefs: raw.evidenceRefs as string[],
        ...(raw.metadata === undefined
          ? {}
          : { metadata: raw.metadata as Record<string, unknown> }),
      };
      validateInput(input);
      const message = messageFromInput(input);
      if (
        raw.id !== message.id ||
        raw.actor !== "assistant" ||
        raw.kind !== "proactive"
      ) {
        throw new InvalidChatMessageInputError(
          `messages[${index}] has inconsistent identity or kind`,
        );
      }
      if (decisionIds.has(message.sourceDecisionId)) {
        throw new InvalidChatMessageInputError(
          `messages[${index}] duplicates a decision`,
        );
      }
      decisionIds.add(message.sourceDecisionId);
      return message;
    });
    return { schemaVersion: "0.1.0", messages };
  } catch (error) {
    if (error instanceof InvalidChatMessageInputError) {
      throw new InvalidChatMessageFileError(filePath, error.message, error);
    }
    throw error;
  }
}

async function writeSnapshotAtomically(
  filePath: string,
  snapshot: LocalChatMessageSnapshot,
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

export class JsonChatMessageStore {
  readonly filePath: string;
  #snapshot: LocalChatMessageSnapshot;
  #mutationTail: Promise<void> = Promise.resolve();

  private constructor(filePath: string, snapshot: LocalChatMessageSnapshot) {
    this.filePath = filePath;
    this.#snapshot = snapshot;
  }

  static async open(filePath: string): Promise<JsonChatMessageStore> {
    const absolutePath = resolve(filePath);
    let snapshot: LocalChatMessageSnapshot = {
      schemaVersion: "0.1.0",
      messages: [],
    };
    try {
      const raw = await readFile(absolutePath, "utf8");
      snapshot = parseSnapshot(JSON.parse(raw) as unknown, absolutePath);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        // A missing file is an empty store and is created on first mutation.
      } else if (error instanceof InvalidChatMessageFileError) {
        throw error;
      } else {
        throw new InvalidChatMessageFileError(
          absolutePath,
          error instanceof Error ? error.message : "could not read snapshot",
          error,
        );
      }
    }
    return new JsonChatMessageStore(absolutePath, snapshot);
  }

  async appendProactiveMessage(
    input: AppendProactiveMessageInput,
  ): Promise<AppendProactiveMessageResult> {
    validateInput(input);
    return this.#mutate((staged) => {
      const message = messageFromInput(input);
      const existing = staged.messages.find(
        (candidate) => candidate.sourceDecisionId === input.sourceDecisionId,
      );
      if (existing) {
        if (stableStringify(existing) !== stableStringify(message)) {
          throw new ChatMessageConflictError(
            `Decision ${input.sourceDecisionId} is already linked to a different chat message`,
          );
        }
        return { outcome: "duplicate", message: clone(existing) };
      }
      staged.messages.push(message);
      return { outcome: "created", message: clone(message) };
    });
  }

  async listMessages(conversationId?: string): Promise<LocalChatMessage[]> {
    await this.#mutationTail;
    const messages =
      conversationId === undefined
        ? this.#snapshot.messages
        : this.#snapshot.messages.filter(
            (message) => message.conversationId === conversationId,
          );
    return clone(messages);
  }

  async #mutate<T>(
    operation: (snapshot: LocalChatMessageSnapshot) => T,
  ): Promise<T> {
    const pending = this.#mutationTail.then(async () => {
      const staged = clone(this.#snapshot);
      const result = operation(staged);
      try {
        await writeSnapshotAtomically(this.filePath, staged);
      } catch (error) {
        throw new ChatMessagePersistenceError(this.filePath, error);
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

