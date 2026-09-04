import type { ContactIntentStore } from "@wakeintent/core";

import type { JsonOutboxStore } from "./outbox.js";

export interface ReconciliationResult {
  contactDecisions: number;
  created: number;
  duplicates: number;
}

/**
 * Repairs the deliberate crash boundary between a committed core decision and
 * the host outbox. Replaying is safe because decisionId is the outbox key.
 */
export async function reconcileContactDecisions(
  intentStore: ContactIntentStore,
  outboxStore: JsonOutboxStore,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    contactDecisions: 0,
    created: 0,
    duplicates: 0,
  };
  const records = await intentStore.listIntents();
  for (const record of records) {
    const decisions = await intentStore.listDecisions(record.intent.id);
    for (const decision of decisions) {
      if (decision.action !== "contact") continue;
      result.contactDecisions += 1;
      const enqueue = await outboxStore.enqueueContact({
        decision,
        target: record.intent.target,
      });
      result[enqueue.outcome === "created" ? "created" : "duplicates"] += 1;
    }
  }
  return result;
}
