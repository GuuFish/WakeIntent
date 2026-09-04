import { describe, expect, it, vi } from "vitest";
import {
  ModelConfigurationError,
  ModelRequestError,
  OpenAICompatiblePolicySignalAdapter,
  OpenAICompatibleStructuredClient,
  OpenAICompatibleModelAdapter,
  configFromEnv,
} from "./index.js";

describe("configFromEnv", () => {
  it("loads a safe configurable API setup", () => {
    expect(
      configFromEnv({
        WAKEINTENT_API_KEY: "secret",
        WAKEINTENT_BASE_URL: "https://example.test/v1/",
        WAKEINTENT_MODEL: "model-a",
        WAKEINTENT_API_MODE: "chat-completions",
        WAKEINTENT_REASONING_EFFORT: "low",
        WAKEINTENT_EXTRACTION_REASONING_EFFORT: "none",
        WAKEINTENT_DECISION_REASONING_EFFORT: "medium",
        WAKEINTENT_TEXT_VERBOSITY: "low",
        WAKEINTENT_EXTRA_HEADERS_JSON: '{"x-provider":"local"}',
      }),
    ).toMatchObject({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "chat-completions",
      timeoutMs: 60000,
      reasoningEffort: "low",
      extractionReasoningEffort: "none",
      decisionReasoningEffort: "medium",
      textVerbosity: "low",
      maxRetries: 1,
      retryBaseDelayMs: 250,
      pricing: {
        inputCostPerMillionUsd: null,
        outputCostPerMillionUsd: null,
      },
      extraHeaders: { "x-provider": "local" },
    });
  });

  it("rejects missing credentials before making a request", () => {
    expect(() => configFromEnv({ WAKEINTENT_MODEL: "model-a" })).toThrow(
      ModelConfigurationError,
    );
  });

  it("rejects the checked-in API key placeholder", () => {
    expect(() =>
      configFromEnv({
        WAKEINTENT_API_KEY: "PASTE_YOUR_API_KEY_HERE",
        WAKEINTENT_MODEL: "model-a",
      }),
    ).toThrow(ModelConfigurationError);
  });

  it("prevents custom headers from replacing authorization", () => {
    expect(() =>
      configFromEnv({
        WAKEINTENT_API_KEY: "secret",
        WAKEINTENT_MODEL: "model-a",
        WAKEINTENT_EXTRA_HEADERS_JSON: '{"Authorization":"unsafe"}',
      }),
    ).toThrow(ModelConfigurationError);
  });

  it("rejects unsupported reasoning and verbosity values", () => {
    expect(() =>
      configFromEnv({
        WAKEINTENT_API_KEY: "secret",
        WAKEINTENT_MODEL: "model-a",
        WAKEINTENT_REASONING_EFFORT: "turbo",
      }),
    ).toThrow(ModelConfigurationError);
    expect(() =>
      configFromEnv({
        WAKEINTENT_API_KEY: "secret",
        WAKEINTENT_MODEL: "model-a",
        WAKEINTENT_TEXT_VERBOSITY: "tiny",
      }),
    ).toThrow(ModelConfigurationError);
  });
});

describe("OpenAICompatibleModelAdapter", () => {
  it("maps a structured Responses API result into a candidate", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      candidates: [
                        {
                          subject: "询问面试结果",
                          reason: "结果预计稍后公布",
                          evidence: [{ eventId: "event-1", quote: null }],
                          notBefore: "2026-09-04T09:00:00.000Z",
                          expiresAt: "2026-09-11T09:00:00.000Z",
                          cancellationHints: ["用户已经说明结果"],
                          priority: 0.7,
                          interruptionCost: 0.3,
                          confidence: 0.9,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      reasoningEffort: "low",
      extractionReasoningEffort: "none",
      textVerbosity: "low",
      fetchImplementation,
    });

    const result = await adapter.generate({
      events: [
        {
          id: "event-1",
          conversationId: "conversation-1",
          actor: "user",
          occurredAt: "2026-09-01T09:00:00.000Z",
          content: "周五应该能收到面试结果。",
        },
      ],
      target: { kind: "user", id: "user-1" },
      now: "2026-09-01T09:01:00.000Z",
    });

    expect(result[0]?.evidence).toEqual([{ eventId: "event-1" }]);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://example.test/v1/responses",
    );
    const requestBody = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(requestBody.reasoning).toEqual({ effort: "none" });
    expect(requestBody.text.verbosity).toBe("low");
    expect(requestBody.instructions).toContain(
      "upstream goal completion or supersession",
    );
    expect(adapter.getCallRecords()[0]?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("conservatively removes an invalid model expiry and audits the repair", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            candidates: [
              {
                subject: "双选会材料",
                reason: "用户希望会前跟进。",
                evidence: [{ eventId: "event-1", quote: null }],
                notBefore: "2026-09-04T10:00:00.000Z",
                expiresAt: "2026-09-04T09:00:00.000Z",
                cancellationHints: [],
                priority: 0.8,
                interruptionCost: 0.2,
                confidence: 0.9,
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatibleModelAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "gpt-5.5",
      apiMode: "responses",
      timeoutMs: 1000,
      fetchImplementation,
    });
    const [result] = await adapter.generate({
      events: [
        {
          id: "event-1",
          conversationId: "conversation",
          actor: "user",
          occurredAt: "2026-09-01T09:00:00.000Z",
          content: "会前问问我材料。",
        },
      ],
      target: { kind: "user", id: "user" },
      now: "2026-09-01T09:00:00.000Z",
    });

    expect(result).toMatchObject({
      expiresAt: null,
      metadata: {
        temporalRepair: {
          originalValue: "2026-09-04T09:00:00.000Z",
          reason: "not-after-notBefore-removed",
        },
      },
    });
  });

  it("retries transient failures with one stable idempotency key", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({ candidates: [] }),
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          }),
          { status: 200 },
        ),
      );
    const client = new OpenAICompatibleStructuredClient({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      maxRetries: 1,
      retryBaseDelayMs: 0,
      pricing: {
        inputCostPerMillionUsd: 1,
        outputCostPerMillionUsd: 2,
      },
      fetchImplementation,
    });

    const result = await client.generateWithMetadata<{ candidates: [] }>({
      schemaName: "wakeintent_candidates",
      schema: { type: "object" },
      instructions: "test",
      input: {},
      phase: "extraction",
    });

    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
    expect(result.costUsd).toBeCloseTo(0.000018);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchImplementation.mock.calls[0]?.[1]
      ?.headers as Record<string, string>;
    const secondHeaders = fetchImplementation.mock.calls[1]?.[1]
      ?.headers as Record<string, string>;
    expect(firstHeaders["Idempotency-Key"]).toBe(
      secondHeaders["Idempotency-Key"],
    );
    expect(client.getCallRecords()).toHaveLength(1);
  });

  it("allows a caller to durably account for an attempt before network I/O", async () => {
    const events: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
      events.push("fetch");
      return new Response(
        JSON.stringify({ output_text: JSON.stringify({ candidates: [] }) }),
        { status: 200 },
      );
    });
    const client = new OpenAICompatibleStructuredClient({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImplementation,
      requestIdFactory: () => "stable-request-id",
      beforeRequestAttempt: async (attempt) => {
        events.push(`journal:${attempt.requestId}:${attempt.attempt}`);
      },
    });

    await client.generate({
      schemaName: "wakeintent_candidates",
      schema: { type: "object" },
      instructions: "test",
      input: {},
      phase: "extraction",
    });

    expect(events).toEqual(["journal:stable-request-id:1", "fetch"]);
    const headers = fetchImplementation.mock.calls[0]?.[1]
      ?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("stable-request-id");
    expect(client.getCallRecords()[0]?.requestId).toBe("stable-request-id");
  });

  it("does not retry non-transient HTTP errors", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("bad request", { status: 400 }),
    );
    const client = new OpenAICompatibleStructuredClient({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      maxRetries: 3,
      retryBaseDelayMs: 0,
      fetchImplementation,
    });

    await expect(
      client.generateWithMetadata({
        schemaName: "wakeintent_candidates",
        schema: { type: "object" },
        instructions: "test",
        input: {},
      }),
    ).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(client.getCallRecords()[0]?.attempts).toBe(1);
  });
});

describe("OpenAICompatiblePolicySignalAdapter", () => {
  it("requests a strict global-policy extraction and maps the result", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            setDoNotDisturb: [
              {
                evidenceRef: "event-quiet",
                reason: "用户明确要求今晚不要主动联系。",
                doNotDisturbUntil: "2026-09-02T22:00:00.000+08:00",
              },
            ],
            clearDoNotDisturb: [],
            setAuthorization: [],
          }),
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatiblePolicySignalAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      extractionReasoningEffort: "none",
      fetchImplementation,
    });
    const result = await adapter.generatePolicySignals({
      events: [
        {
          id: "event-quiet",
          conversationId: "conversation-1",
          actor: "user",
          occurredAt: "2026-09-02T10:00:00.000Z",
          content: "今晚十点前别主动联系我。",
        },
      ],
      now: "2026-09-02T10:01:00.000Z",
      timeZone: "Asia/Hong_Kong",
      currentPolicy: { authorization: "granted" },
    });

    expect(result).toEqual([
      {
        kind: "set-do-not-disturb",
        evidenceRef: "event-quiet",
        reason: "用户明确要求今晚不要主动联系。",
        doNotDisturbUntil: "2026-09-02T22:00:00.000+08:00",
      },
    ]);
    const requestBody = JSON.parse(
      String(fetchImplementation.mock.calls[0]?.[1]?.body),
    );
    expect(fetchImplementation.mock.calls[0]?.[0]).toBe(
      "https://example.test/v1/responses",
    );
    expect(requestBody.reasoning).toEqual({ effort: "none" });
    expect(requestBody.text.format).toMatchObject({
      type: "json_schema",
      name: "wakeintent_policy_signals",
      strict: true,
    });
    expect(
      requestBody.text.format.schema.properties.clearDoNotDisturb.items
        .properties,
    ).toEqual({
      evidenceRef: { type: "string" },
      reason: { type: "string" },
    });
    expect(requestBody.instructions).toContain("globally change");
    expect(requestBody.instructions).toContain("intent-specific");
    expect(JSON.parse(requestBody.input)).toMatchObject({
      timeZone: "Asia/Hong_Kong",
      now: "2026-09-02T10:01:00.000Z",
      currentPolicy: { authorization: "granted" },
    });
    expect(adapter.getCallRecords()[0]).toMatchObject({
      schemaName: "wakeintent_policy_signals",
      phase: "extraction",
      reasoningEffort: "none",
    });
  });

  it("preserves an empty result when no explicit global instruction exists", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            setDoNotDisturb: [],
            clearDoNotDisturb: [],
            setAuthorization: [],
          }),
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatiblePolicySignalAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      fetchImplementation,
    });

    await expect(
      adapter.generatePolicySignals({
        events: [
          {
            id: "event-busy",
            conversationId: "conversation-1",
            actor: "user",
            occurredAt: "2026-09-02T10:00:00.000Z",
            content: "我今天挺忙的。",
          },
          {
            id: "event-topic",
            conversationId: "conversation-1",
            actor: "user",
            occurredAt: "2026-09-02T10:01:00.000Z",
            content: "别再问我双选会了。",
          },
        ],
        now: "2026-09-02T10:02:00.000Z",
      }),
    ).resolves.toEqual([]);
  });

  it("maps two explicit transitions from independent operation collections", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            setDoNotDisturb: [],
            clearDoNotDisturb: [
              {
                evidenceRef: "event-1",
                reason: "用户同时撤销两项限制。",
              },
            ],
            setAuthorization: [
              {
                evidenceRef: "event-1",
                reason: "用户同时撤销两项限制。",
                authorization: "granted",
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatiblePolicySignalAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      fetchImplementation,
    });

    await expect(
      adapter.generatePolicySignals({ events: [], now: "2026-09-02T10:00:00.000Z" }),
    ).resolves.toEqual([
      {
        kind: "clear-do-not-disturb",
        evidenceRef: "event-1",
        reason: "用户同时撤销两项限制。",
      },
      {
        kind: "set-authorization",
        evidenceRef: "event-1",
        reason: "用户同时撤销两项限制。",
        authorization: "granted",
      },
    ]);
  });

  it("rejects a proxy response that omits the operation collections", async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            signals: [
              {
                kind: "clear-do-not-disturb",
                evidenceRef: "event-1",
                reason: "Contradictory quiet-window operation.",
                doNotDisturbUntil: "2026-09-03T10:00:00.000Z",
                authorization: null,
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    );
    const adapter = new OpenAICompatiblePolicySignalAdapter({
      apiKey: "secret",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiMode: "responses",
      timeoutMs: 1000,
      fetchImplementation,
    });

    await expect(
      adapter.generatePolicySignals({ events: [], now: "2026-09-02T10:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ModelRequestError);
  });
});
