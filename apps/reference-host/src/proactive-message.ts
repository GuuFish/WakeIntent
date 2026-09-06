import type {
  ContactDecision,
  ContactIntent,
  ConversationEvent,
} from "@wakeintent/core";
import type { OpenAICompatibleStructuredClient } from "@wakeintent/model-openai-compatible";

export interface ProactiveMessageGenerationInput {
  intent: ContactIntent;
  decision: ContactDecision;
  latestEvents: ConversationEvent[];
  now: string;
  timeZone?: string;
}

export interface ProactiveMessageDraft {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ProactiveMessageGenerator {
  generate(input: ProactiveMessageGenerationInput): Promise<ProactiveMessageDraft>;
}

const messageSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: { type: "string" },
  },
  required: ["content"],
};

export class OpenAICompatibleProactiveMessageGenerator
  implements ProactiveMessageGenerator
{
  constructor(
    private readonly client: Pick<OpenAICompatibleStructuredClient, "generate">,
  ) {}

  async generate(
    input: ProactiveMessageGenerationInput,
  ): Promise<ProactiveMessageDraft> {
    if (input.decision.action !== "contact") {
      throw new TypeError("A proactive message requires a contact decision");
    }
    const result = await this.client.generate<{ content: string }>({
      schemaName: "wakeintent_proactive_message",
      schema: messageSchema,
      instructions:
        "Write one concise, natural proactive chat message for the committed contact decision. Ground it in the supplied intent, decision, and latest conversation. Do not invent new facts, claim that an event happened when it is unknown, mention internal intent machinery, or add unrelated small talk. Ask at most one clear question. Return only the message content in the structured field.",
      input,
      phase: "decision",
    });
    const content = result.content?.trim();
    if (!content) throw new TypeError("Generated proactive message must not be empty");
    return { content, metadata: { generator: "openai-compatible" } };
  }
}
