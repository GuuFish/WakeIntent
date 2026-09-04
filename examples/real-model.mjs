import {
  FakeClock,
  extractContactIntents,
  reevaluateContactIntent,
} from "../packages/core/dist/index.js";
import {
  OpenAICompatibleModelAdapter,
  configFromEnv,
} from "../packages/model-openai-compatible/dist/index.js";

const adapter = new OpenAICompatibleModelAdapter(configFromEnv());
let sequence = 0;
const idGenerator = (kind) => `${kind}-${++sequence}`;
const initialEvent = {
  id: "event-plan",
  conversationId: "conversation-1",
  actor: "user",
  occurredAt: "2026-09-01T09:00:00.000Z",
  content: "周五应该能收到面试结果。",
};

const intents = await extractContactIntents({
  events: [initialEvent],
  target: { kind: "user", id: "user-1" },
  clock: new FakeClock("2026-09-01T09:01:00.000Z"),
  idGenerator,
  generator: adapter,
  policy: { activationThreshold: 0.7 },
});

const intent = intents[0];
if (!intent) {
  console.log(
    JSON.stringify(
      { extracted: [], note: "模型认为这段对话不应产生未来联系意图。" },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (intent.status !== "active") {
  console.log(
    JSON.stringify(
      { extracted: [intent], note: "候选置信度未达到激活阈值。" },
      null,
      2,
    ),
  );
  process.exit(0);
}

const resultEvent = {
  id: "event-result",
  conversationId: "conversation-1",
  actor: "user",
  occurredAt: "2026-09-04T09:30:00.000Z",
  content: "已经拿到 offer 了，谢谢，不用再问面试结果。",
};
const result = await reevaluateContactIntent({
  intent,
  latestEvents: [resultEvent],
  clock: new FakeClock("2026-09-04T10:00:00.000Z"),
  idGenerator,
  policyVersion: "api-demo-0.1",
  userState: { authorization: "granted", remainingContactBudget: 1 },
  semanticReevaluator: adapter,
});

console.log(
  JSON.stringify(
    {
      model: process.env.WAKEINTENT_MODEL,
      apiMode: process.env.WAKEINTENT_API_MODE || "responses",
      extracted: intent,
      reevaluation: result,
      expectedBehavior:
        "最新上下文已经给出结果，合理决定应为 resolve 或 cancel，而不是 contact。",
    },
    null,
    2,
  ),
);
