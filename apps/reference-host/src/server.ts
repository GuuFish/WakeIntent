import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  ContactIntentNotFoundError,
  ContactIntentStoreConflictError,
  IdempotencyConflictError,
  InvalidEngineInputError,
  InvalidStoreInputError,
  InvalidUseCaseInputError,
  type ContactIntent,
  type ConversationEvent,
} from "@wakeintent/core";
import {
  configFromEnv,
  OpenAICompatibleModelAdapter,
  OpenAICompatibleRelevanceRouter,
  OpenAICompatibleStructuredClient,
} from "@wakeintent/model-openai-compatible";

import {
  ConversationEventStoreConflictError,
  InvalidConversationEventStoreInputError,
} from "./event-store.js";
import {
  InvalidOutboxInputError,
  OutboxConflictError,
  OutboxNotFoundError,
  type DeliveryReceipt,
} from "./outbox.js";
import {
  InvalidReferenceHostInputError,
  ReferenceHostCapabilityError,
  ReferenceHostService,
  type ProcessConversationInput,
  type RunEvaluationInput,
  type RunModelEvaluationInput,
} from "./service.js";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;

export interface ReferenceHostHttpServerOptions {
  maxBodyBytes?: number;
}

class InvalidHttpRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHttpRequestError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new InvalidHttpRequestError(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new InvalidHttpRequestError("Request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidHttpRequestError("Request body must be valid JSON");
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const content = `${JSON.stringify(body, jsonReplacer, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
  });
  response.end(content);
}

function errorStatus(error: unknown): number {
  if (error instanceof ReferenceHostCapabilityError) return 503;
  if (error instanceof ContactIntentNotFoundError || error instanceof OutboxNotFoundError) {
    return 404;
  }
  if (
    error instanceof ContactIntentStoreConflictError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ConversationEventStoreConflictError ||
    error instanceof OutboxConflictError
  ) {
    return 409;
  }
  if (
    error instanceof InvalidHttpRequestError ||
    error instanceof InvalidReferenceHostInputError ||
    error instanceof InvalidConversationEventStoreInputError ||
    error instanceof InvalidOutboxInputError ||
    error instanceof InvalidEngineInputError ||
    error instanceof InvalidStoreInputError ||
    error instanceof InvalidUseCaseInputError
  ) {
    return 400;
  }
  return 500;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new InvalidReferenceHostInputError(
      "WAKEINTENT_HOST_PORT must be an integer from 1 to 65535",
    );
  }
  return parsed;
}

export function createReferenceHostHttpServer(
  service: ReferenceHostService,
  options: ReferenceHostHttpServerOptions = {},
): Server {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://reference-host.local");

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "wakeintent-reference-host",
          apiVersion: "v1",
          conversationProcessingEnabled: service.conversationCapabilityEnabled,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/v1/state") {
        sendJson(response, 200, await service.getState());
        return;
      }

      if (method === "GET" && url.pathname === "/v1/intents") {
        sendJson(response, 200, { intents: await service.listIntents() });
        return;
      }

      const intentMatch = /^\/v1\/intents\/([^/]+)$/.exec(url.pathname);
      if (method === "GET" && intentMatch) {
        const intentId = decodeURIComponent(intentMatch[1] ?? "");
        const record = await service.intentStore.getIntent(intentId);
        if (!record) throw new ContactIntentNotFoundError(intentId);
        sendJson(response, 200, { record });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/intents") {
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isObject(body)) throw new InvalidHttpRequestError("Body must be an object");
        const result = await service.registerIntent({
          intent: body.intent as ContactIntent,
          nextEvaluationAt: body.nextEvaluationAt as string | null,
          idempotencyKey: body.idempotencyKey as string,
        });
        sendJson(response, result.outcome === "created" ? 201 : 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/evaluations") {
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isObject(body)) throw new InvalidHttpRequestError("Body must be an object");
        const result = await service.runEvaluation(body as unknown as RunEvaluationInput);
        sendJson(response, 200, result);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/model-evaluations") {
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isObject(body)) throw new InvalidHttpRequestError("Body must be an object");
        const result = await service.runModelEvaluation(
          body as unknown as RunModelEvaluationInput,
        );
        sendJson(response, 200, result);
        return;
      }

      const conversationEventsMatch =
        /^\/v1\/conversations\/([^/]+)\/events$/.exec(url.pathname);
      if (conversationEventsMatch) {
        const conversationId = decodeURIComponent(
          conversationEventsMatch[1] ?? "",
        );
        if (method === "GET") {
          sendJson(response, 200, {
            events: await service.listConversationEvents(conversationId),
          });
          return;
        }
        if (method === "POST") {
          const body = await readJsonBody(request, maxBodyBytes);
          if (!isObject(body)) {
            throw new InvalidHttpRequestError("Body must be an object");
          }
          const result = await service.processConversation({
            ...body,
            conversationId,
            events: body.events as ConversationEvent[],
          } as unknown as ProcessConversationInput);
          sendJson(
            response,
            result.outcome === "created" ? 201 : 200,
            result,
          );
          return;
        }
      }

      if (method === "GET" && url.pathname === "/v1/outbox") {
        sendJson(response, 200, { items: await service.listOutbox() });
        return;
      }

      const receiptMatch = /^\/v1\/outbox\/([^/]+)\/receipts$/.exec(url.pathname);
      if (method === "POST" && receiptMatch) {
        const itemId = decodeURIComponent(receiptMatch[1] ?? "");
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isObject(body)) throw new InvalidHttpRequestError("Body must be an object");
        const result = await service.recordReceipt(itemId, body as unknown as DeliveryReceipt);
        sendJson(response, result.outcome === "recorded" ? 201 : 200, result);
        return;
      }

      sendJson(response, 404, { error: "Route not found" });
    } catch (error) {
      const status = errorStatus(error);
      sendJson(response, status, {
        error: status === 500 ? "Internal server error" : error instanceof Error ? error.message : String(error),
        ...(status === 500 ? {} : { type: error instanceof Error ? error.name : "Error" }),
      });
    }
  });
}

async function main(): Promise<void> {
  const dataDirectory = resolve(
    process.env.WAKEINTENT_HOST_DIR ?? ".wakeintent/reference-host-api",
  );
  const modelEnabled =
    process.argv.includes("--model") ||
    process.env.WAKEINTENT_HOST_MODEL_ENABLED === "true";
  let conversationRuntime;
  if (modelEnabled) {
    const config = configFromEnv();
    const modelAdapter = new OpenAICompatibleModelAdapter(config);
    const routingClient = new OpenAICompatibleStructuredClient(config);
    conversationRuntime = {
      candidateGenerator: modelAdapter,
      semanticReevaluator: modelAdapter,
      relevanceRouter: new OpenAICompatibleRelevanceRouter(routingClient),
      getTelemetrySnapshot: () => ({
        candidateAndDecisionCalls: [...modelAdapter.getCallRecords()],
        relevanceCalls: [...routingClient.getCallRecords()],
      }),
    };
  }
  const service = await ReferenceHostService.open({
    intentStorePath: resolve(dataDirectory, "intents.json"),
    outboxPath: resolve(dataDirectory, "outbox.json"),
    eventStorePath: resolve(dataDirectory, "events.json"),
    ...(conversationRuntime === undefined ? {} : { conversationRuntime }),
  });
  const server = createReferenceHostHttpServer(service);
  const host = process.env.WAKEINTENT_HOST_BIND ?? DEFAULT_HOST;
  const port = parsePort(process.env.WAKEINTENT_HOST_PORT);
  server.listen(port, host, () => {
    console.log(`WakeIntent reference host listening on http://${host}:${port}`);
    console.log(`Persistent data directory: ${dataDirectory}`);
    console.log(
      modelEnabled
        ? "Natural-language extraction, relevance routing, and model reevaluation are enabled."
        : "Structured mode only. Set WAKEINTENT_HOST_MODEL_ENABLED=true and use host:start:model to enable model processing.",
    );
    console.log("This Alpha host does not generate or send messages.");
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
