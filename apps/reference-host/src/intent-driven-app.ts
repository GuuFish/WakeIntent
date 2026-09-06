import {
  SystemClock,
  type Clock,
  type ContactDecision,
  type ContactPolicyState,
  type ContactTarget,
} from "@wakeintent/core";

import {
  JsonChatMessageStore,
  type AppendProactiveMessageResult,
  type LocalChatMessage,
} from "./chat-message-store.js";
import type { OutboxItem, RecordDeliveryReceiptResult } from "./outbox.js";
import {
  ReferenceHostService,
  type ReferenceHostServiceOptions,
  type RunModelEvaluationResult,
} from "./service.js";
import type { ProactiveMessageGenerator } from "./proactive-message.js";

export interface IntentDrivenReferenceAppOptions {
  service?: ReferenceHostServiceOptions;
  serviceInstance?: ReferenceHostService;
  messageStorePath: string;
  messageGenerator: ProactiveMessageGenerator;
  userStateProvider: (
    target: ContactTarget,
    now: string,
  ) => Promise<ContactPolicyState> | ContactPolicyState;
  policyVersion: string;
  clock?: Clock;
  timeZone?: string;
  wakeIntervalMs?: number;
  evaluationLimit?: number;
  contextEventLimit?: number;
  routeClosureThreshold?: number;
  onLoopError?: (error: Error) => void;
}

export interface GeneratedMessageResult {
  outboxItem: OutboxItem;
  append: AppendProactiveMessageResult;
  receipt: RecordDeliveryReceiptResult;
}

export interface IntentWakeCycleResult {
  startedAt: string;
  dueIntentCount: number;
  evaluation: RunModelEvaluationResult;
  generatedMessages: GeneratedMessageResult[];
}

export class InvalidIntentDrivenAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntentDrivenAppInputError";
  }
}

function targetKey(target: ContactTarget): string {
  return `${target.kind}:${target.id}`;
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidIntentDrivenAppInputError(
      `${label} must be a positive integer`,
    );
  }
}

function decisionForItem(
  decisions: ContactDecision[],
  item: OutboxItem,
): ContactDecision {
  const decision = decisions.find((candidate) => candidate.id === item.decisionId);
  if (!decision || decision.action !== "contact") {
    throw new InvalidIntentDrivenAppInputError(
      `Outbox item ${item.id} has no committed contact decision`,
    );
  }
  return decision;
}

export class IntentDrivenReferenceApp {
  readonly service: ReferenceHostService;
  readonly messageStore: JsonChatMessageStore;
  readonly #options: Required<
    Pick<
      IntentDrivenReferenceAppOptions,
      "wakeIntervalMs" | "contextEventLimit" | "routeClosureThreshold"
    >
  > &
    IntentDrivenReferenceAppOptions;
  readonly #clock: Clock;
  #timer: ReturnType<typeof setInterval> | null = null;
  #runTail: Promise<void> = Promise.resolve();
  #lastLoopError: Error | null = null;

  private constructor(
    service: ReferenceHostService,
    messageStore: JsonChatMessageStore,
    options: IntentDrivenReferenceAppOptions,
  ) {
    this.service = service;
    this.messageStore = messageStore;
    this.#clock = options.clock ?? new SystemClock();
    this.#options = {
      ...options,
      wakeIntervalMs: options.wakeIntervalMs ?? 30_000,
      contextEventLimit: options.contextEventLimit ?? 100,
      routeClosureThreshold: options.routeClosureThreshold ?? 0.9,
    };
    requirePositiveInteger(this.#options.wakeIntervalMs, "wakeIntervalMs");
    requirePositiveInteger(this.#options.contextEventLimit, "contextEventLimit");
    if (
      !Number.isFinite(this.#options.routeClosureThreshold) ||
      this.#options.routeClosureThreshold < 0 ||
      this.#options.routeClosureThreshold > 1
    ) {
      throw new InvalidIntentDrivenAppInputError(
        "routeClosureThreshold must be between 0 and 1",
      );
    }
    if (options.evaluationLimit !== undefined) {
      requirePositiveInteger(options.evaluationLimit, "evaluationLimit");
    }
    if (!options.policyVersion.trim()) {
      throw new InvalidIntentDrivenAppInputError(
        "policyVersion must be a non-empty string",
      );
    }
  }

  static async open(
    options: IntentDrivenReferenceAppOptions,
  ): Promise<IntentDrivenReferenceApp> {
    if ((options.service === undefined) === (options.serviceInstance === undefined)) {
      throw new InvalidIntentDrivenAppInputError(
        "Provide exactly one of service or serviceInstance",
      );
    }
    const [service, messageStore] = await Promise.all([
      options.serviceInstance ?? ReferenceHostService.open(options.service!),
      JsonChatMessageStore.open(options.messageStorePath),
    ]);
    return new IntentDrivenReferenceApp(service, messageStore, options);
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  get lastLoopError(): Error | null {
    return this.#lastLoopError;
  }

  start(): void {
    if (this.#timer) return;
    const wake = () => {
      void this.runOnce().catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.#lastLoopError = normalized;
        this.#options.onLoopError?.(normalized);
      });
    };
    wake();
    this.#timer = setInterval(wake, this.#options.wakeIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#runTail;
  }

  async runOnce(): Promise<IntentWakeCycleResult> {
    let result: IntentWakeCycleResult | undefined;
    const pending = this.#runTail.then(async () => {
      result = await this.#runOnce();
    });
    this.#runTail = pending.then(
      () => undefined,
      () => undefined,
    );
    await pending;
    return result!;
  }

  async listMessages(conversationId?: string): Promise<LocalChatMessage[]> {
    return this.messageStore.listMessages(conversationId);
  }

  async #runOnce(): Promise<IntentWakeCycleResult> {
    const now = this.#clock.now().toISOString();
    const due = await this.service.intentStore.listIntents({
      dueAtOrBefore: now,
      ...(this.#options.evaluationLimit === undefined
        ? {}
        : { limit: this.#options.evaluationLimit }),
    });
    const userStates: Record<string, ContactPolicyState> = {};
    for (const record of due) {
      const key = targetKey(record.intent.target);
      if (!Object.hasOwn(userStates, key)) {
        userStates[key] = await this.#options.userStateProvider(
          record.intent.target,
          now,
        );
      }
    }
    const evaluation = await this.service.runModelEvaluation({
      now,
      policyVersion: this.#options.policyVersion,
      userStates,
      contextEventLimit: this.#options.contextEventLimit,
      routeClosureThreshold: this.#options.routeClosureThreshold,
      ...(this.#options.evaluationLimit === undefined
        ? {}
        : { limit: this.#options.evaluationLimit }),
    });
    const generatedMessages = await this.#generatePendingMessages(now);
    return {
      startedAt: now,
      dueIntentCount: due.length,
      evaluation,
      generatedMessages,
    };
  }

  async #generatePendingMessages(now: string): Promise<GeneratedMessageResult[]> {
    await this.service.reconcile();
    const pending = (await this.service.listOutbox()).filter(
      (item) => item.status === "awaiting-generation",
    );
    const results: GeneratedMessageResult[] = [];
    for (const item of pending) {
      const record = await this.service.intentStore.getIntent(item.intentId);
      if (!record) {
        throw new InvalidIntentDrivenAppInputError(
          `Outbox item ${item.id} references missing intent ${item.intentId}`,
        );
      }
      const conversationId = record.intent.metadata?.sourceConversationId;
      if (typeof conversationId !== "string" || !conversationId) {
        throw new InvalidIntentDrivenAppInputError(
          `Intent ${record.intent.id} has no sourceConversationId`,
        );
      }
      const decision = decisionForItem(
        await this.service.intentStore.listDecisions(record.intent.id),
        item,
      );
      const existing = (await this.messageStore.listMessages()).find(
        (message) => message.sourceDecisionId === decision.id,
      );
      let append: AppendProactiveMessageResult;
      if (existing) {
        append = { outcome: "duplicate", message: existing };
      } else {
        if (!this.service.eventStore) {
          throw new InvalidIntentDrivenAppInputError(
            "The intent-driven app requires a conversation event store",
          );
        }
        const latestEvents = await this.service.eventStore.listEvents({
          conversationId,
          atOrBefore: now,
          limit: this.#options.contextEventLimit,
        });
        const draft = await this.#options.messageGenerator.generate({
          intent: record.intent,
          decision,
          latestEvents,
          now,
          ...(this.#options.timeZone === undefined
            ? {}
            : { timeZone: this.#options.timeZone }),
        });
        append = await this.messageStore.appendProactiveMessage({
          conversationId,
          content: draft.content,
          createdAt: now,
          sourceIntentId: record.intent.id,
          sourceDecisionId: decision.id,
          evidenceRefs: [
            ...new Set([
              ...decision.evidenceRefs,
              ...decision.counterEvidenceRefs,
            ]),
          ],
          metadata: {
            ...(draft.metadata ?? {}),
            channel: "local-chat",
          },
        });
      }
      const receipt = await this.service.recordReceipt(item.id, {
        id: `receipt:local-chat:generated:${decision.id}`,
        recordedAt: append.message.createdAt,
        status: "generated",
        providerMessageId: append.message.id,
        metadata: { channel: "local-chat" },
      });
      results.push({ outboxItem: item, append, receipt });
    }
    return results;
  }
}
