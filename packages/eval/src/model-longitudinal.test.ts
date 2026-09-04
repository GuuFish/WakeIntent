import { describe, expect, it, vi } from "vitest";
import type { ContactIntent, ConversationEvent } from "@wakeintent/core";
import { OpenAICompatibleStructuredClient } from "@wakeintent/model-openai-compatible";
import {
  HybridRelevanceRouter,
  ModelDueGatedBaselineAdapter,
  ModelRelevanceRouter,
} from "./model-longitudinal.js";

function queuedClient(outputs: unknown[]) {
  const fetchImplementation = vi.fn<typeof fetch>(async () => {
    const output = outputs.shift();
    return new Response(
      JSON.stringify({ output_text: JSON.stringify(output) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const client = new OpenAICompatibleStructuredClient({
    apiKey: "secret",
    baseUrl: "https://example.test/v1",
    model: "gpt-5.5",
    apiMode: "responses",
    timeoutMs: 1000,
    reasoningEffort: "low",
    extractionReasoningEffort: "none",
    decisionReasoningEffort: "low",
    textVerbosity: "low",
    fetchImplementation,
  });
  return { client, fetchImplementation };
}

const intent = (id: string, subject: string): ContactIntent => ({
  schemaVersion: "0.1.0",
  id,
  status: "active",
  subject,
  reason: `${subject} future follow-up`,
  target: { kind: "user", id: "user" },
  evidence: [{ eventId: "plan" }],
  notBefore: "2026-09-05T12:00:00.000Z",
  expiresAt: null,
  cancellationHints: [],
  priority: 0.8,
  interruptionCost: 0.2,
  confidence: 0.9,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
});

const latestEvent: ConversationEvent = {
  id: "found-internship",
  conversationId: "conversation",
  actor: "user",
  occurredAt: "2026-09-03T08:00:00.000Z",
  content: "找到实习了，双选会不去了。",
};

describe("ModelRelevanceRouter", () => {
  it("returns auditable selective matches using extraction-level reasoning", async () => {
    const { client, fetchImplementation } = queuedClient([
      {
        matches: [
          {
            intentId: "job-fair",
            eventIds: ["found-internship"],
            effect: "cancel",
            reason: "The new internship supersedes the job-fair goal.",
            confidence: 0.97,
          },
        ],
      },
    ]);
    const router = new ModelRelevanceRouter(client);
    const matches = await router.selectRelevant({
      intents: [intent("job-fair", "双选会"), intent("parcel", "快递")],
      events: [latestEvent],
      now: latestEvent.occurredAt,
    });

    expect(matches.map((match) => match.intentId)).toEqual(["job-fair"]);
    expect(router.getAudits()[0]).toMatchObject({
      matches: [{ intentId: "job-fair", eventIds: ["found-internship"] }],
    });
    const request = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.text.format.type).toBe("json_schema");
  });
});

describe("HybridRelevanceRouter", () => {
  it("routes explicit impact locally and does not call the model fallback", async () => {
    const { client, fetchImplementation } = queuedClient([]);
    const hybrid = new HybridRelevanceRouter(new ModelRelevanceRouter(client));
    const matches = await hybrid.selectRelevant({
      intents: [intent("job-fair", "双选会"), intent("parcel", "快递")],
      events: [latestEvent],
      now: latestEvent.occurredAt,
    });

    expect(matches.map((match) => match.intentId)).toEqual(["job-fair"]);
    expect(matches[0]?.effect).toBe("cancel");
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(hybrid.getAudits()[0]).toMatchObject({
      source: "deterministic",
      matches: [{ intentId: "job-fair", eventIds: ["found-internship"] }],
    });
  });

  it("falls back to the model for indirect changes without shared anchors", async () => {
    const { client, fetchImplementation } = queuedClient([
      {
        matches: [
          {
            intentId: "job-fair",
            eventIds: ["signed-offer"],
            effect: "cancel",
            reason: "Signing another offer may supersede the recruiting event.",
            confidence: 0.82,
          },
        ],
      },
    ]);
    const hybrid = new HybridRelevanceRouter(new ModelRelevanceRouter(client));
    const matches = await hybrid.selectRelevant({
      intents: [intent("job-fair", "双选会")],
      events: [
        {
          ...latestEvent,
          id: "signed-offer",
          content: "我已经签了另一家公司的 offer。",
        },
      ],
      now: latestEvent.occurredAt,
    });

    expect(matches.map((match) => match.intentId)).toEqual(["job-fair"]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(hybrid.getAudits()[0]?.source).toBe("model");
  });

  it("does not treat incidental Latin character fragments as topic anchors", async () => {
    const { client, fetchImplementation } = queuedClient([{ matches: [] }]);
    const hybrid = new HybridRelevanceRouter(new ModelRelevanceRouter(client));
    const matches = await hybrid.selectRelevant({
      intents: [intent("job-fair", "材料准备")],
      events: [
        {
          ...latestEvent,
          id: "offer-only",
          content: "我已经签了满意的 offer。",
        },
      ],
      now: latestEvent.occurredAt,
    });

    expect(matches).toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(hybrid.getAudits()[0]?.source).toBe("model");
  });

  it("does not deterministically route generic already language with topic overlap", async () => {
    const { client, fetchImplementation } = queuedClient([{ matches: [] }]);
    const hybrid = new HybridRelevanceRouter(new ModelRelevanceRouter(client));
    const matches = await hybrid.selectRelevant({
      intents: [intent("job-fair", "双选会")],
      events: [
        {
          ...latestEvent,
          id: "promotion-seen",
          content: "双选会已经开始宣传了，不过我的参会安排没变。",
        },
      ],
      now: latestEvent.occurredAt,
    });

    expect(matches).toEqual([]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(hybrid.getAudits()[0]?.source).toBe("model");
  });
});

describe("ModelDueGatedBaselineAdapter", () => {
  it("extracts due memories with none reasoning and decides with low reasoning", async () => {
    const { client, fetchImplementation } = queuedClient([
      {
        memories: [
          {
            summary: "Prepare materials for the job fair.",
            evidenceRefs: ["plan"],
            dueAt: "2026-09-05T12:00:00.000Z",
          },
        ],
      },
      {
        decisions: [
          {
            memoryId: "baseline-memory-1",
            action: "cancel",
            reason: "The user no longer plans to attend.",
            evidenceRefs: ["found-internship"],
            nextEvaluationAt: null,
          },
        ],
      },
    ]);
    const initialEvents: ConversationEvent[] = [
      {
        id: "plan",
        conversationId: "conversation",
        actor: "user",
        occurredAt: "2026-09-01T09:00:00.000Z",
        content: "周五参加双选会，提前问问我材料。",
      },
    ];
    const adapter = new ModelDueGatedBaselineAdapter(client, {
      initialEvents,
      target: { kind: "user", id: "user" },
      timeZone: "Asia/Hong_Kong",
    });
    const memories = await adapter.extract({
      events: initialEvents,
      target: { kind: "user", id: "user" },
      now: "2026-09-01T09:00:00.000Z",
      timeZone: "Asia/Hong_Kong",
    });
    const decisions = await adapter.decide({
      memories,
      latestEvents: [latestEvent],
      now: "2026-09-05T12:00:00.000Z",
      userState: { authorization: "granted" },
    });

    expect(memories[0]?.id).toBe("baseline-memory-1");
    expect(decisions[0]?.action).toBe("cancel");
    const extractionRequest = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    const decisionRequest = JSON.parse(
      String(fetchImplementation.mock.calls[1]?.[1]?.body),
    );
    expect(extractionRequest.reasoning).toEqual({ effort: "none" });
    expect(decisionRequest.reasoning).toEqual({ effort: "low" });
  });
});
