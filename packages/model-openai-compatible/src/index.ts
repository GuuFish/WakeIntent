import { randomUUID } from "node:crypto";
import type {
  CandidateDraft,
  CandidateGenerationInput,
  CandidateGenerator,
  ContactPolicySignalDraft,
  PolicySignalGenerationInput,
  PolicySignalGenerator,
  SemanticDecisionProposal,
  SemanticReevaluationInput,
  SemanticReevaluator,
} from "@wakeintent/core";

export type OpenAICompatibleApiMode = "responses" | "chat-completions";
export type OpenAICompatibleReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type OpenAICompatibleTextVerbosity = "low" | "medium" | "high";
export const WAKEINTENT_MODEL_PROMPT_VERSION = "0.1.3";
export const WAKEINTENT_POLICY_SIGNAL_PROMPT_VERSION = "0.3.0";

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ModelPricing {
  inputCostPerMillionUsd: number | null;
  outputCostPerMillionUsd: number | null;
}

export interface ModelGenerationResult<T> {
  value: T;
  usage: ModelUsage;
  requestId: string;
  attempts: number;
  costUsd: number | null;
}

export interface ModelCallRecord {
  schemaName: string;
  phase: StructuredRequest["phase"] | null;
  reasoningEffort: OpenAICompatibleReasoningEffort | null;
  usage: ModelUsage;
  requestId: string;
  attempts: number;
  costUsd: number | null;
}

export interface ModelRequestIdentity {
  schemaName: string;
  phase: StructuredRequest["phase"] | null;
}

export interface ModelRequestAttempt extends ModelRequestIdentity {
  requestId: string;
  attempt: number;
}

const candidateInstructions =
  "You extract future conversational follow-up opportunities. Create a candidate only when the conversation provides evidence that contacting the target later could be useful. Do not turn ordinary facts, wishes, or small talk into follow-ups. Use only supplied event IDs. Resolve relative time against now and return ISO 8601 instants. Set expiresAt only when the conversation gives a clear expiry condition or a narrow validity window is strongly supported by the evidence; otherwise return null. Never invent a narrow expiry merely because a due time exists. Whenever both values are non-null, expiresAt must be strictly later than notBefore. For cancellationHints, include concise conditions that would make this follow-up unnecessary: direct withdrawal or completion, plus upstream goal completion or supersession when that relationship is reasonably implied by the source conversation. Keep hints general and grounded; never invent a specific future event, organization, outcome, or user preference. Keep candidates empty when no justified follow-up exists.";

const reevaluationInstructions =
  "You decide whether a previously extracted follow-up is still worth contacting about. Explicitly inspect the latest events before deciding and cite every latest event that materially supports the decision. Treat recent assistant outreach without a later user reply as increased interruption evidence. Prefer resolve when newer context shows the outcome is already known, cancel when the user withdrew consent or explicitly rejected follow-up, defer only with a future nextEvaluationAt, expire only when the opportunity is genuinely no longer meaningful, silent when contacting would currently add no value, and contact only when the follow-up remains useful now. Use only supplied event IDs and explain the decisive evidence.";

const policySignalInstructions =
  "Extract only explicit user-authored instructions that globally change whether or when the assistant may proactively contact the user. Compare the instruction with currentPolicy and emit only the state transitions it actually justifies; do not emit a redundant authorization or quiet-window change. A general status such as 'I am busy' is not a do-not-disturb instruction unless the user links it to contact or interruptions. An instruction about one topic, such as 'do not ask me about the job fair again', is intent-specific and must not become a global policy signal. Set a do-not-disturb boundary only for an explicit finite quiet window, deny authorization for an indefinite refusal of proactive contact, grant authorization when the user explicitly restores denied or unknown permission, and clear do-not-disturb when the user explicitly ends the current quiet window. Emit both restoration operations only when currentPolicy contains both restrictions and the user clearly withdraws both. Represent every justified state transition separately in its corresponding operation collection. Use only supplied user event IDs. Resolve relative time from now and timeZone. Return empty operation collections when no explicit global policy change exists.";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  apiMode: OpenAICompatibleApiMode;
  timeoutMs: number;
  reasoningEffort?: OpenAICompatibleReasoningEffort;
  extractionReasoningEffort?: OpenAICompatibleReasoningEffort;
  decisionReasoningEffort?: OpenAICompatibleReasoningEffort;
  textVerbosity?: OpenAICompatibleTextVerbosity;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  pricing?: ModelPricing;
  extraHeaders?: Record<string, string>;
  fetchImplementation?: typeof fetch;
  requestIdFactory?: (request: ModelRequestIdentity) => string;
  beforeRequestAttempt?: (attempt: ModelRequestAttempt) => void | Promise<void>;
}

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

export class ModelRequestError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ModelRequestError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

function requireValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ModelConfigurationError(`${name} is required`);
  }
  return trimmed;
}

function parseExtraHeaders(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelConfigurationError(
      "WAKEINTENT_EXTRA_HEADERS_JSON must be valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new ModelConfigurationError(
      "WAKEINTENT_EXTRA_HEADERS_JSON must be a JSON object",
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    const normalized = name.toLowerCase();
    if (
      normalized === "authorization" ||
      normalized === "content-type" ||
      normalized === "idempotency-key" ||
      normalized === "x-client-request-id"
    ) {
      throw new ModelConfigurationError(
        `WAKEINTENT_EXTRA_HEADERS_JSON cannot override ${name}`,
      );
    }
    if (typeof headerValue !== "string") {
      throw new ModelConfigurationError(
        `Extra header ${name} must have a string value`,
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function parseNonNegativeInteger(
  value: string | undefined,
  name: string,
  defaultValue: number,
): number {
  const parsed = Number(value?.trim() || defaultValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ModelConfigurationError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(
  value: string | undefined,
  name: string,
  defaultValue: number | null,
): number | null {
  if (!value?.trim()) return defaultValue;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ModelConfigurationError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseEnum<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!allowed.includes(normalized as T)) {
    throw new ModelConfigurationError(
      `${name} must be one of: ${allowed.join(", ")}`,
    );
  }
  return normalized as T;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleConfig {
  const timeoutText = env.WAKEINTENT_TIMEOUT_MS?.trim() || "60000";
  const timeoutMs = Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ModelConfigurationError(
      "WAKEINTENT_TIMEOUT_MS must be a positive integer",
    );
  }

  const maxRetries = parseNonNegativeInteger(
    env.WAKEINTENT_MAX_RETRIES,
    "WAKEINTENT_MAX_RETRIES",
    1,
  );
  const retryBaseDelayMs = parseNonNegativeInteger(
    env.WAKEINTENT_RETRY_BASE_DELAY_MS,
    "WAKEINTENT_RETRY_BASE_DELAY_MS",
    250,
  );

  const rawMode = env.WAKEINTENT_API_MODE?.trim() || "responses";
  if (rawMode !== "responses" && rawMode !== "chat-completions") {
    throw new ModelConfigurationError(
      "WAKEINTENT_API_MODE must be responses or chat-completions",
    );
  }

  const apiKey = requireValue(
    env.WAKEINTENT_API_KEY ?? env.OPENAI_API_KEY,
    "WAKEINTENT_API_KEY (or OPENAI_API_KEY)",
  );
  if (apiKey === "PASTE_YOUR_API_KEY_HERE" || apiKey === "replace-me") {
    throw new ModelConfigurationError(
      "Replace the API key placeholder in .env before running a real model",
    );
  }

  const reasoningEffort = parseEnum(
    env.WAKEINTENT_REASONING_EFFORT,
    "WAKEINTENT_REASONING_EFFORT",
    ["none", "low", "medium", "high", "xhigh"] as const,
  );
  const textVerbosity = parseEnum(
    env.WAKEINTENT_TEXT_VERBOSITY,
    "WAKEINTENT_TEXT_VERBOSITY",
    ["low", "medium", "high"] as const,
  );
  const extractionReasoningEffort = parseEnum(
    env.WAKEINTENT_EXTRACTION_REASONING_EFFORT,
    "WAKEINTENT_EXTRACTION_REASONING_EFFORT",
    ["none", "low", "medium", "high", "xhigh"] as const,
  );
  const decisionReasoningEffort = parseEnum(
    env.WAKEINTENT_DECISION_REASONING_EFFORT,
    "WAKEINTENT_DECISION_REASONING_EFFORT",
    ["none", "low", "medium", "high", "xhigh"] as const,
  );

  return {
    apiKey,
    baseUrl: (env.WAKEINTENT_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    ),
    model: requireValue(env.WAKEINTENT_MODEL, "WAKEINTENT_MODEL"),
    apiMode: rawMode,
    timeoutMs,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(extractionReasoningEffort ? { extractionReasoningEffort } : {}),
    ...(decisionReasoningEffort ? { decisionReasoningEffort } : {}),
    ...(textVerbosity ? { textVerbosity } : {}),
    maxRetries,
    retryBaseDelayMs,
    pricing: {
      inputCostPerMillionUsd: parseNonNegativeNumber(
        env.WAKEINTENT_INPUT_COST_PER_MILLION_USD,
        "WAKEINTENT_INPUT_COST_PER_MILLION_USD",
        null,
      ),
      outputCostPerMillionUsd: parseNonNegativeNumber(
        env.WAKEINTENT_OUTPUT_COST_PER_MILLION_USD,
        "WAKEINTENT_OUTPUT_COST_PER_MILLION_USD",
        null,
      ),
    },
    extraHeaders: parseExtraHeaders(env.WAKEINTENT_EXTRA_HEADERS_JSON),
  };
}

export interface StructuredRequest {
  schemaName: string;
  schema: Record<string, unknown>;
  instructions: string;
  input: unknown;
  phase?: "extraction" | "decision";
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractResponsesText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload.output)) return null;

  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        isRecord(content) &&
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        return content.text;
      }
    }
  }
  return null;
}

function extractChatCompletionsText(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  return typeof choice.message.content === "string"
    ? choice.message.content
    : null;
}

function extractUsage(payload: unknown): ModelUsage {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }
  const usage = payload.usage;
  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : null;
  const outputTokens =
    typeof usage.output_tokens === "number"
      ? usage.output_tokens
      : typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : null;
  const totalTokens =
    typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null;
  return { inputTokens, outputTokens, totalTokens };
}

function calculateCost(usage: ModelUsage, pricing: ModelPricing): number | null {
  if (
    usage.inputTokens === null ||
    usage.outputTokens === null ||
    pricing.inputCostPerMillionUsd === null ||
    pricing.outputCostPerMillionUsd === null
  ) {
    return null;
  }
  return (
    (usage.inputTokens * pricing.inputCostPerMillionUsd +
      usage.outputTokens * pricing.outputCostPerMillionUsd) /
    1_000_000
  );
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > 800 ? `${text.slice(0, 800)}…` : text;
}

export class OpenAICompatibleStructuredClient {
  readonly #config: OpenAICompatibleConfig;
  readonly #records: ModelCallRecord[] = [];

  constructor(config: OpenAICompatibleConfig) {
    const pricing = config.pricing ?? {
      inputCostPerMillionUsd: null,
      outputCostPerMillionUsd: null,
    };
    this.#config = {
      ...config,
      maxRetries: config.maxRetries ?? 1,
      retryBaseDelayMs: config.retryBaseDelayMs ?? 250,
      pricing,
    };
  }

  getCallRecords(): readonly ModelCallRecord[] {
    return this.#records.slice();
  }

  async generate<T>(request: StructuredRequest): Promise<T> {
    const result = await this.generateWithMetadata<T>(request);
    return result.value;
  }

  async generateWithMetadata<T>(
    request: StructuredRequest,
  ): Promise<ModelGenerationResult<T>> {
    const endpoint =
      this.#config.apiMode === "responses"
        ? `${this.#config.baseUrl}/responses`
        : `${this.#config.baseUrl}/chat/completions`;
    const phaseReasoningEffort =
      request.phase === "extraction"
        ? this.#config.extractionReasoningEffort ?? this.#config.reasoningEffort
        : request.phase === "decision"
          ? this.#config.decisionReasoningEffort ?? this.#config.reasoningEffort
          : this.#config.reasoningEffort;
    const body =
      this.#config.apiMode === "responses"
        ? {
            model: this.#config.model,
            store: false,
            instructions: request.instructions,
            input: JSON.stringify(request.input),
            ...(phaseReasoningEffort
              ? { reasoning: { effort: phaseReasoningEffort } }
              : {}),
            text: {
              ...(this.#config.textVerbosity
                ? { verbosity: this.#config.textVerbosity }
                : {}),
              format: {
                type: "json_schema",
                name: request.schemaName,
                strict: true,
                schema: request.schema,
              },
            },
          }
        : {
            model: this.#config.model,
            messages: [
              { role: "system", content: request.instructions },
              { role: "user", content: JSON.stringify(request.input) },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.schemaName,
                strict: true,
                schema: request.schema,
              },
            },
          };

    const fetchImplementation = this.#config.fetchImplementation ?? fetch;
    const requestIdentity: ModelRequestIdentity = {
      schemaName: request.schemaName,
      phase: request.phase ?? null,
    };
    const requestId = this.#config.requestIdFactory?.(requestIdentity) ?? randomUUID();
    const maxRetries = this.#config.maxRetries ?? 0;
    const retryBaseDelayMs = this.#config.retryBaseDelayMs ?? 0;
    const pricing = this.#config.pricing ?? {
      inputCostPerMillionUsd: null,
      outputCostPerMillionUsd: null,
    };

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      await this.#config.beforeRequestAttempt?.({
        ...requestIdentity,
        requestId,
        attempt,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#config.timeoutMs);
      try {
        const response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            ...this.#config.extraHeaders,
            Authorization: `Bearer ${this.#config.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": requestId,
            "X-Client-Request-Id": requestId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await readErrorBody(response);
          throw new ModelRequestError(
            `Model API returned HTTP ${response.status}: ${detail}`,
            { status: response.status, retryable: isRetryableStatus(response.status) },
          );
        }

        const payload: unknown = await response.json();
        const usage = extractUsage(payload);
        const text =
          this.#config.apiMode === "responses"
            ? extractResponsesText(payload)
            : extractChatCompletionsText(payload);
        if (!text) {
          throw new ModelRequestError("Model API response contained no text output");
        }

        let value: T;
        try {
          value = JSON.parse(text) as T;
        } catch {
          throw new ModelRequestError("Model API output was not valid JSON");
        }
        const costUsd = calculateCost(usage, pricing);
        this.#records.push({
          schemaName: request.schemaName,
          phase: request.phase ?? null,
          reasoningEffort: phaseReasoningEffort ?? null,
          usage,
          requestId,
          attempts: attempt,
          costUsd,
        });
        return { value, usage, requestId, attempts: attempt, costUsd };
      } catch (error) {
        const requestError =
          error instanceof ModelRequestError
            ? error
            : error instanceof Error && error.name === "AbortError"
              ? new ModelRequestError(
                  `Model API request timed out after ${this.#config.timeoutMs}ms`,
                  { retryable: true },
                )
              : new ModelRequestError(
                  `Model API request failed: ${error instanceof Error ? error.message : String(error)}`,
                  { retryable: true },
                );
        if (!requestError.retryable || attempt > maxRetries) {
          this.#records.push({
            schemaName: request.schemaName,
            phase: request.phase ?? null,
            reasoningEffort: phaseReasoningEffort ?? null,
            usage: { inputTokens: null, outputTokens: null, totalTokens: null },
            requestId,
            attempts: attempt,
            costUsd: null,
          });
          throw requestError;
        }
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            retryBaseDelayMs * 2 ** (attempt - 1),
          ),
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new ModelRequestError("Model API request exhausted retries");
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const candidateSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          subject: { type: "string" },
          reason: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                eventId: { type: "string" },
                quote: { type: ["string", "null"] },
              },
              required: ["eventId", "quote"],
            },
          },
          notBefore: { type: ["string", "null"] },
          expiresAt: { type: ["string", "null"] },
          cancellationHints: { type: "array", items: { type: "string" } },
          priority: { type: "number", minimum: 0, maximum: 1 },
          interruptionCost: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "subject",
          "reason",
          "evidence",
          "notBefore",
          "expiresAt",
          "cancellationHints",
          "priority",
          "interruptionCost",
          "confidence",
        ],
      },
    },
  },
  required: ["candidates"],
};

const decisionSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["contact", "defer", "cancel", "expire", "silent", "resolve"],
    },
    reason: { type: "string" },
    evidenceRefs: { type: "array", items: { type: "string" } },
    counterEvidenceRefs: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    nextEvaluationAt: { type: ["string", "null"] },
  },
  required: [
    "action",
    "reason",
    "evidenceRefs",
    "counterEvidenceRefs",
    "confidence",
    "nextEvaluationAt",
  ],
};

const policySignalSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    setDoNotDisturb: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          evidenceRef: { type: "string" },
          reason: { type: "string" },
          doNotDisturbUntil: { type: "string" },
        },
        required: ["evidenceRef", "reason", "doNotDisturbUntil"],
      },
    },
    clearDoNotDisturb: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          evidenceRef: { type: "string" },
          reason: { type: "string" },
        },
        required: ["evidenceRef", "reason"],
      },
    },
    setAuthorization: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          evidenceRef: { type: "string" },
          reason: { type: "string" },
          authorization: {
            type: "string",
            enum: ["granted", "denied", "unknown"],
          },
        },
        required: ["evidenceRef", "reason", "authorization"],
      },
    },
  },
  required: ["setDoNotDisturb", "clearDoNotDisturb", "setAuthorization"],
};

interface PolicySignalResponse {
  setDoNotDisturb: Array<{
    evidenceRef: string;
    reason: string;
    doNotDisturbUntil: string;
  }>;
  clearDoNotDisturb: Array<{
    evidenceRef: string;
    reason: string;
  }>;
  setAuthorization: Array<{
    evidenceRef: string;
    reason: string;
    authorization: "granted" | "denied" | "unknown";
  }>;
}

interface CandidateResponse {
  candidates: Array<
    Omit<CandidateDraft, "evidence"> & {
      evidence: Array<{ eventId: string; quote: string | null }>;
    }
  >;
}

function repairCandidateTemporalBounds(
  candidate: CandidateResponse["candidates"][number],
): CandidateResponse["candidates"][number] {
  if (candidate.expiresAt === null) return candidate;
  const expiresAt = Date.parse(candidate.expiresAt);
  const notBefore =
    candidate.notBefore === null ? null : Date.parse(candidate.notBefore);
  const expiryIsInvalid = Number.isNaN(expiresAt);
  const orderIsInvalid =
    notBefore !== null && !Number.isNaN(notBefore) && expiresAt <= notBefore;
  if (!expiryIsInvalid && !orderIsInvalid) return candidate;
  return {
    ...candidate,
    expiresAt: null,
    metadata: {
      ...(candidate.metadata ?? {}),
      temporalRepair: {
        field: "expiresAt",
        originalValue: candidate.expiresAt,
        reason: expiryIsInvalid
          ? "invalid-instant-removed"
          : "not-after-notBefore-removed",
      },
    },
  };
}

export class OpenAICompatibleModelAdapter
  implements CandidateGenerator, SemanticReevaluator
{
  readonly #client: OpenAICompatibleStructuredClient;

  constructor(config: OpenAICompatibleConfig) {
    this.#client = new OpenAICompatibleStructuredClient(config);
  }

  getCallRecords(): readonly ModelCallRecord[] {
    return this.#client.getCallRecords();
  }

  async generate(input: CandidateGenerationInput): Promise<CandidateDraft[]> {
    const result = await this.#client.generate<CandidateResponse>({
      schemaName: "wakeintent_candidates",
      schema: candidateSchema,
      instructions: candidateInstructions,
      input,
      phase: "extraction",
    });

    return result.candidates.map((rawCandidate) => {
      const candidate = repairCandidateTemporalBounds(rawCandidate);
      return {
      ...candidate,
      evidence: candidate.evidence.map((item) =>
        item.quote === null
          ? { eventId: item.eventId }
          : { eventId: item.eventId, quote: item.quote },
      ),
      };
    });
  }

  async evaluate(
    input: SemanticReevaluationInput,
  ): Promise<SemanticDecisionProposal> {
    return this.#client.generate<SemanticDecisionProposal>({
      schemaName: "wakeintent_decision",
      schema: decisionSchema,
      instructions: reevaluationInstructions,
      input,
      phase: "decision",
    });
  }
}

export class OpenAICompatiblePolicySignalAdapter
  implements PolicySignalGenerator
{
  readonly #client: OpenAICompatibleStructuredClient;

  constructor(config: OpenAICompatibleConfig) {
    this.#client = new OpenAICompatibleStructuredClient(config);
  }

  getCallRecords(): readonly ModelCallRecord[] {
    return this.#client.getCallRecords();
  }

  async generatePolicySignals(
    input: PolicySignalGenerationInput,
  ): Promise<ContactPolicySignalDraft[]> {
    const result = await this.#client.generate<PolicySignalResponse>({
      schemaName: "wakeintent_policy_signals",
      schema: policySignalSchema,
      instructions: policySignalInstructions,
      input,
      phase: "extraction",
    });
    if (
      !Array.isArray(result.setDoNotDisturb) ||
      !Array.isArray(result.clearDoNotDisturb) ||
      !Array.isArray(result.setAuthorization)
    ) {
      throw new ModelRequestError(
        "Policy signal output is missing one or more operation collections",
      );
    }
    return [
      ...result.setDoNotDisturb.map(
        (item): ContactPolicySignalDraft => ({
          kind: "set-do-not-disturb",
          evidenceRef: item.evidenceRef,
          reason: item.reason,
          doNotDisturbUntil: item.doNotDisturbUntil,
        }),
      ),
      ...result.clearDoNotDisturb.map(
        (item): ContactPolicySignalDraft => ({
          kind: "clear-do-not-disturb",
          evidenceRef: item.evidenceRef,
          reason: item.reason,
        }),
      ),
      ...result.setAuthorization.map(
        (item): ContactPolicySignalDraft => ({
          kind: "set-authorization",
          evidenceRef: item.evidenceRef,
          reason: item.reason,
          authorization: item.authorization,
        }),
      ),
    ];
  }
}
