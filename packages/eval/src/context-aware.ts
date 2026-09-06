import type { ConversationEvent, ContactPolicyState } from "@wakeintent/core";
import type { OpenAICompatibleStructuredClient } from "@wakeintent/model-openai-compatible";

export const CONTEXT_AWARE_PROMPT = "You are a thoughtful proactive conversational companion. At each event or timer wake, inspect the supplied conversation, current time, time zone, user state and previous deliveries. Decide directly whether anything is worth saying now. You have no stored future intentions. Do not assume a follow-up exists: ordinary facts, wishes and hypothetical examples are not commitments. Consider all distinct topics, explicit timing, completion, withdrawal, expired opportunities, busy periods and repeated unanswered outreach. Recent evidence overrides old plans. Never repeat an already delivered follow-up without a new reason. Defer only to a concrete future time; otherwise remain silent when no useful message is justified. Distinguish intent_driven follow-ups grounded in a specific earlier reason from spontaneous expression grounded in current conversational atmosphere. Spontaneous expression is welcome only when the supplied conversation supports it and user policy allows it. Return one decision per relevant topic, or one silent/none decision if there are none. Cite supplied event IDs for decisive evidence, including contrary evidence. Recognition labels describe this decision only, not persistent lifecycle state. Explain your actual action concisely. Do not invent evidence or future events.";

export interface ContextDecision {
  action: "contact" | "defer" | "silent";
  kind: "intent_driven" | "spontaneous" | "none";
  recognition: "open" | "resolved" | "cancelled" | "expired" | "busy" | "unanswered" | "none";
  reason: string;
  evidenceRefs: string[];
  nextEvaluationAt: string | null;
}
export interface ContextInput {
  events: ConversationEvent[];
  now: string;
  timeZone: string;
  userState: ContactPolicyState;
  deliveries: Array<{ at: string; evidenceRefs: string[]; reason: string }>;
}
const properties = {
  action: { type: "string", enum: ["contact", "defer", "silent"] },
  kind: { type: "string", enum: ["intent_driven", "spontaneous", "none"] },
  recognition: { type: "string", enum: ["open", "resolved", "cancelled", "expired", "busy", "unanswered", "none"] },
  reason: { type: "string" },
  evidenceRefs: { type: "array", items: { type: "string" } },
  nextEvaluationAt: { type: ["string", "null"] },
};
export class ContextAwareBaseline {
  constructor(private readonly client: Pick<OpenAICompatibleStructuredClient, "generate">) {}
  async decide(input: ContextInput): Promise<ContextDecision[]> {
    const result = await this.client.generate<{ decisions: ContextDecision[] }>({
      schemaName: "context_aware_decisions", phase: "decision", instructions: CONTEXT_AWARE_PROMPT,
      schema: { type: "object", additionalProperties: false, required: ["decisions"], properties: {
        decisions: { type: "array", minItems: 1, maxItems: 8, items: {
          type: "object", additionalProperties: false, properties, required: Object.keys(properties),
        } },
      } }, input,
    });
    if (!Array.isArray(result.decisions) || !result.decisions.length || result.decisions.length > 8) throw new Error("Invalid baseline decisions");
    const allowed = new Set(input.events.map(e => e.id));
    for (const delivery of input.deliveries) for (const id of delivery.evidenceRefs) allowed.add(id);
    for (const decision of result.decisions) {
      if (!["contact", "defer", "silent"].includes(decision.action) || !decision.reason?.trim()) throw new Error("Invalid baseline action/reason");
      if (!Array.isArray(decision.evidenceRefs) || decision.evidenceRefs.some(id => !allowed.has(id))) throw new Error("Unknown baseline evidence");
      if (decision.action === "defer" && (!decision.nextEvaluationAt || !(Date.parse(decision.nextEvaluationAt) > Date.parse(input.now)))) throw new Error("Invalid baseline defer time");
      if (decision.action === "contact" && (!decision.evidenceRefs.length || decision.kind === "none")) throw new Error("Ungrounded baseline contact");
    }
    return result.decisions;
  }
}
export function recentContext(events: ConversationEvent[], now: string): ConversationEvent[] {
  return events.filter(e => Date.parse(e.occurredAt) <= Date.parse(now)).slice(-8);
}
