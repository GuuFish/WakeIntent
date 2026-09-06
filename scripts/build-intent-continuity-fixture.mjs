import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const T0 = "2026-09-01T09:00:00.000Z";
const T1 = "2026-09-05T12:00:00.000Z";
const T2 = "2026-09-08T12:00:00.000Z";
const TZ = "Asia/Hong_Kong";

const event = (scenarioId, id, actor, occurredAt, content) => ({
  id,
  conversationId: `${scenarioId}-conversation`,
  actor,
  occurredAt,
  content,
});

function makeScenario({
  id,
  category,
  initial,
  steps,
  expected,
  intentCount = initial.length,
  baselineMemoryCount = intentCount,
  comparisonClaim = "behavioral-parity",
}) {
  return {
    id,
    category,
    timeZone: TZ,
    target: { kind: "user", id },
    initialUserState: {
      authorization: "granted",
      remainingContactBudget: Math.max(1, intentCount),
    },
    initialEvents: initial.map((item) => event(id, ...item)),
    steps: steps.map((step) => ({
      at: step.at,
      kind: step.kind,
      events: (step.events ?? []).map((item) => event(id, ...item)),
      ...(step.userState ? { userState: step.userState } : {}),
    })),
    expected: {
      intentCount,
      baselineMemoryCount,
      wakeOutcomes: expected.wake,
      baselineOutcomes: expected.baseline,
      contactRequiredEvidenceRefs: expected.contactRequired ?? [],
      contactForbiddenEvidenceRefs: expected.contactForbidden ?? [],
      ...(expected.forbiddenWakeTraceTimes
        ? { forbiddenWakeTraceTimes: expected.forbiddenWakeTraceTimes }
        : {}),
      ...(expected.allowedAdditionalWakeActions
        ? { allowedAdditionalWakeActions: expected.allowedAdditionalWakeActions }
        : {}),
      ...(expected.allowedAdditionalBaselineActions
        ? { allowedAdditionalBaselineActions: expected.allowedAdditionalBaselineActions }
        : {}),
      ...(expected.contactForbidden?.length
        ? { forbiddenContactIntentEvidenceRefs: expected.contactForbidden }
        : {}),
      comparisonClaim,
      annotation: expected.annotation,
    },
  };
}

const outcome = (intentEvidenceRef, at, allowedActions, requiredDecisionEvidenceRefs = [], trigger) => ({
  intentEvidenceRef,
  at,
  allowedActions,
  ...(requiredDecisionEvidenceRefs.length ? { requiredDecisionEvidenceRefs } : {}),
  ...(trigger ? { trigger } : {}),
});

const scenarios = [
  makeScenario({
    id: "s01-normal-job-followup",
    category: "normal-followup",
    initial: [["s01-plan", "user", T0, "北京时间9月5日晚上八点，如果我还没说结果，就问问我小王找工作怎么样了。"]],
    steps: [{ at: T1, kind: "scheduled" }],
    expected: {
      wake: [outcome("s01-plan", T1, ["contact"], ["s01-plan"], "scheduled")],
      baseline: [outcome("s01-plan", T1, ["contact"], ["s01-plan"])],
      contactRequired: ["s01-plan"],
      annotation: "没有反向信息时，两套系统都应完成明确跟进。",
    },
  }),
  makeScenario({
    id: "s02-normal-exam-followup",
    category: "normal-followup",
    initial: [["s02-plan", "user", T0, "北京时间9月5日晚上八点问问我小李考试考得怎么样；如果我提前说了就不用问。"]],
    steps: [{ at: T1, kind: "scheduled" }],
    expected: {
      wake: [outcome("s02-plan", T1, ["contact"], ["s02-plan"], "scheduled")],
      baseline: [outcome("s02-plan", T1, ["contact"], ["s02-plan"])],
      contactRequired: ["s02-plan"],
      annotation: "不能以减少误触达为由漏掉有明确价值的联系。",
    },
  }),
  makeScenario({
    id: "s03-result-known-early",
    category: "early-resolution",
    initial: [["s03-plan", "user", T0, "北京时间9月5日晚上八点问问我小王找工作有没有进展。"]],
    steps: [
      { at: "2026-09-03T08:00:00.000Z", kind: "context", events: [["s03-offer", "user", "2026-09-03T08:00:00.000Z", "小王已经拿到满意的 offer 了。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s03-plan", "2026-09-03T08:00:00.000Z", ["resolve"], ["s03-offer"], "context")],
      baseline: [outcome("s03-plan", T1, ["resolve", "silent"], ["s03-offer"])],
      contactForbidden: ["s03-plan"],
      annotation: "结果提前出现后，不应再问原问题；WakeIntent 还应能提前关闭状态。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s04-task-completed-early",
    category: "early-resolution",
    initial: [["s04-plan", "user", T0, "北京时间9月5日晚上八点问问我申请材料交了没有。"]],
    steps: [
      { at: "2026-09-03T09:00:00.000Z", kind: "context", events: [["s04-done", "user", "2026-09-03T09:00:00.000Z", "申请材料已经提交完成，系统也确认收到了。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s04-plan", "2026-09-03T09:00:00.000Z", ["resolve"], ["s04-done"], "context")],
      baseline: [outcome("s04-plan", T1, ["resolve", "silent"], ["s04-done"])],
      contactForbidden: ["s04-plan"],
      annotation: "上游任务完成应消除原联系理由。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s05-explicit-cancel",
    category: "explicit-cancellation",
    initial: [["s05-plan", "user", T0, "北京时间9月5日晚上八点提醒我问小王找工作的事。"]],
    steps: [
      { at: "2026-09-03T10:00:00.000Z", kind: "context", events: [["s05-cancel", "user", "2026-09-03T10:00:00.000Z", "算了，别再问小王找工作的事了。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s05-plan", "2026-09-03T10:00:00.000Z", ["cancel"], ["s05-cancel"], "context")],
      baseline: [outcome("s05-plan", T1, ["cancel"], ["s05-cancel"])],
      contactForbidden: ["s05-plan"],
      annotation: "显式取消是零容忍误触达场景。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s06-topic-specific-cancel",
    category: "explicit-cancellation",
    initial: [["s06-plan", "user", T0, "北京时间9月5日晚上八点问问我毕业论文答辩准备得怎样。"]],
    steps: [
      { at: "2026-09-04T08:00:00.000Z", kind: "context", events: [["s06-cancel", "user", "2026-09-04T08:00:00.000Z", "论文答辩这件事不要再提醒或追问我。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s06-plan", "2026-09-04T08:00:00.000Z", ["cancel"], ["s06-cancel"], "context")],
      baseline: [outcome("s06-plan", T1, ["cancel"], ["s06-cancel"])],
      contactForbidden: ["s06-plan"],
      annotation: "局部取消不能被误解成普通状态更新。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s07-living-demo-busy-then-free",
    category: "defer-then-contact",
    initial: [["s07-plan", "assistant", T0, "感觉小王最近好像在准备考研。北京时间9月5日晚上如果合适的话，我可以问问他准备得怎么样。"]],
    steps: [
      { at: T1, kind: "scheduled", events: [["s07-busy", "user", "2026-09-05T11:30:00.000Z", "小王最近在准备实习，昨天还说自己忙得焦头烂额；9月8日应该就忙完了。"]] },
      { at: T2, kind: "scheduled", events: [["s07-free", "user", "2026-09-08T11:30:00.000Z", "小王：终于把实习搞定了，最近轻松多了。"]] },
    ],
    expected: {
      wake: [
        outcome("s07-plan", T1, ["defer"], ["s07-busy"], "scheduled"),
        outcome("s07-plan", T2, ["contact"], ["s07-free"], "scheduled"),
      ],
      baseline: [
        outcome("s07-plan", T1, ["defer"], ["s07-busy"]),
        outcome("s07-plan", T2, ["contact"], ["s07-free"]),
      ],
      contactRequired: ["s07-plan"],
      annotation: "关键活人感 Demo：旧意图存活，因忙碌延期，情况解除后联系。",
    },
  }),
  makeScenario({
    id: "s08-user-busy-then-available",
    category: "defer-then-contact",
    initial: [["s08-plan", "user", T0, "北京时间9月5日晚上可以问我开源项目第一轮反馈怎么样。"]],
    steps: [
      { at: T1, kind: "scheduled", events: [["s08-busy", "user", "2026-09-05T11:00:00.000Z", "今天在赶紧急报告，9月8日中午前别打断我。"]] },
      { at: T2, kind: "scheduled", events: [["s08-free", "user", "2026-09-08T11:00:00.000Z", "紧急报告交完了，现在可以正常聊。"]] },
    ],
    expected: {
      wake: [
        outcome("s08-plan", T1, ["defer"], ["s08-busy"], "scheduled"),
        outcome("s08-plan", T2, ["contact"], ["s08-free"], "scheduled"),
      ],
      baseline: [
        outcome("s08-plan", T1, ["defer"], ["s08-busy"]),
        outcome("s08-plan", T2, ["contact"], ["s08-free"]),
      ],
      contactRequired: ["s08-plan"],
      annotation: "临时忙碌应延期而非丢失意图。",
    },
  }),
  makeScenario({
    id: "s09-trip-expired",
    category: "expiry",
    initial: [["s09-plan", "user", T0, "9月3日毕业旅行回来后可以问问我玩得怎么样；如果9月6日还没聊就不用再提了。"]],
    steps: [{ at: "2026-09-10T12:00:00.000Z", kind: "scheduled" }],
    expected: {
      wake: [outcome("s09-plan", "2026-09-10T12:00:00.000Z", ["expire"], ["s09-plan"], "scheduled")],
      baseline: [outcome("s09-plan", "2026-09-10T12:00:00.000Z", ["expire", "silent"], ["s09-plan"])],
      contactForbidden: ["s09-plan"],
      annotation: "明确有效窗口过去后不得机械联系。",
    },
    comparisonClaim: "deterministic-hard-gate",
  }),
  makeScenario({
    id: "s10-event-lost-meaning",
    category: "expiry",
    initial: [["s10-plan", "user", T0, "9月2日晚上可以问问我抢票结果；9月3日演出开始后这件事就没意义了。"]],
    steps: [{ at: T1, kind: "scheduled" }],
    expected: {
      wake: [outcome("s10-plan", T1, ["expire"], ["s10-plan"], "scheduled")],
      baseline: [outcome("s10-plan", T1, ["expire", "silent"], ["s10-plan"])],
      contactForbidden: ["s10-plan"],
      annotation: "自然失效应成为终态或沉默。",
    },
    comparisonClaim: "deterministic-hard-gate",
  }),
  makeScenario({
    id: "s11-topic-reversal",
    category: "context-reversal",
    initial: [["s11-plan", "user", T0, "北京时间9月5日晚上如果合适，可以问问小王创业想法进展。"]],
    steps: [
      { at: "2026-09-04T09:00:00.000Z", kind: "context", events: [["s11-reversal", "user", "2026-09-04T09:00:00.000Z", "小王后来明确说，他最近完全不想聊创业。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s11-plan", "2026-09-04T09:00:00.000Z", ["cancel", "resolve", "silent"], ["s11-reversal"], "context")],
      baseline: [outcome("s11-plan", T1, ["cancel", "resolve", "silent"], ["s11-reversal"])],
      contactForbidden: ["s11-plan"],
      annotation: "话题偏好反转后，旧意图不得继续执行。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s12-goal-abandoned",
    category: "context-reversal",
    initial: [["s12-plan", "user", T0, "北京时间9月5日晚上问问我小李准备转行做设计的进展。"]],
    steps: [
      { at: "2026-09-04T10:00:00.000Z", kind: "context", events: [["s12-reversal", "user", "2026-09-04T10:00:00.000Z", "小李决定不转行了，继续做现在的工作，而且不想再讨论设计。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s12-plan", "2026-09-04T10:00:00.000Z", ["cancel", "resolve"], ["s12-reversal"], "context")],
      baseline: [outcome("s12-plan", T1, ["cancel", "resolve", "silent"], ["s12-reversal"])],
      contactForbidden: ["s12-plan"],
      annotation: "上游目标被放弃应使跟进理由消失。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s13-relationship-broken",
    category: "relationship-change",
    initial: [["s13-plan", "user", T0, "北京时间9月5日晚上如果合适，问候一下小王最近恢复得怎样。"]],
    steps: [
      { at: "2026-09-04T11:00:00.000Z", kind: "context", events: [["s13-change", "user", "2026-09-04T11:00:00.000Z", "我和小王彻底闹翻了，以后不要再联系他，也别替我问候。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s13-plan", "2026-09-04T11:00:00.000Z", ["cancel"], ["s13-change"], "context")],
      baseline: [outcome("s13-plan", T1, ["cancel"], ["s13-change"])],
      contactForbidden: ["s13-plan"],
      annotation: "关系变化是旧意图必须重新判断的强反证。",
    },
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s14-relationship-distant",
    category: "relationship-change",
    initial: [["s14-plan", "user", T0, "北京时间9月5日晚上可以问问小李搬家后适应得怎样。"]],
    steps: [
      { at: T1, kind: "scheduled", events: [["s14-change", "user", "2026-09-05T11:00:00.000Z", "我和小李现在只是普通同事，最近交流很尴尬，先保持距离吧。"]] },
    ],
    expected: {
      wake: [outcome("s14-plan", T1, ["defer", "silent", "cancel"], ["s14-change"], "scheduled")],
      baseline: [outcome("s14-plan", T1, ["defer", "silent", "cancel"], ["s14-change"])],
      contactForbidden: ["s14-plan"],
      annotation: "较弱的关系变化也应抑制当下联系。",
    },
  }),
  makeScenario({
    id: "s15-four-intents-compete",
    category: "multiple-intents",
    initial: [
      ["s15-job", "user", T0, "北京时间9月5日晚上问问我小王实习结果。"],
      ["s15-exam", "user", "2026-09-01T09:02:00.000Z", "北京时间9月5日晚上问问我小李考试结果。"],
      ["s15-project", "user", "2026-09-01T09:04:00.000Z", "北京时间9月5日晚上继续和我讨论 WakeIntent 项目。"],
      ["s15-parcel", "user", "2026-09-01T09:06:00.000Z", "北京时间9月5日晚上提醒我看快递到没到。"],
    ],
    steps: [
      { at: T1, kind: "scheduled", events: [
        ["s15-job-done", "user", "2026-09-05T11:00:00.000Z", "小王已经拿到实习 offer。"],
        ["s15-exam-busy", "user", "2026-09-05T11:05:00.000Z", "小李考试推迟到9月8日才出结果。"],
        ["s15-project-ready", "user", "2026-09-05T11:10:00.000Z", "WakeIntent 的实验材料准备好了，晚上可以继续。"],
        ["s15-parcel-done", "user", "2026-09-05T11:15:00.000Z", "快递已经收到。"],
      ] },
      { at: T2, kind: "scheduled", events: [["s15-exam-result", "user", "2026-09-08T11:00:00.000Z", "小李考试通过了，已经知道结果。"]] },
    ],
    expected: {
      wake: [
        outcome("s15-job", T1, ["resolve"], ["s15-job-done"], "scheduled"),
        outcome("s15-exam", T1, ["defer"], ["s15-exam-busy"], "scheduled"),
        outcome("s15-project", T1, ["contact"], ["s15-project-ready"], "scheduled"),
        outcome("s15-parcel", T1, ["resolve"], ["s15-parcel-done"], "scheduled"),
        outcome("s15-exam", T2, ["resolve", "silent"], ["s15-exam-result"], "scheduled"),
      ],
      baseline: [
        outcome("s15-job", T1, ["resolve"], ["s15-job-done"]),
        outcome("s15-exam", T1, ["defer"], ["s15-exam-busy"]),
        outcome("s15-project", T1, ["contact"], ["s15-project-ready"]),
        outcome("s15-parcel", T1, ["resolve"], ["s15-parcel-done"]),
        outcome("s15-exam", T2, ["resolve", "silent"], ["s15-exam-result"]),
      ],
      contactRequired: ["s15-project"],
      contactForbidden: ["s15-job", "s15-exam", "s15-parcel"],
      annotation: "同一窗口四个理由应分别结束、延期、联系和解决。",
    },
    intentCount: 4,
    baselineMemoryCount: 4,
  }),
  makeScenario({
    id: "s16-two-intents-one-cancelled",
    category: "multiple-intents",
    initial: [
      ["s16-a", "user", T0, "北京时间9月5日晚上问问我面试结果。"],
      ["s16-b", "user", "2026-09-01T09:02:00.000Z", "北京时间9月5日晚上提醒我继续写开源项目说明。"],
    ],
    steps: [
      { at: "2026-09-04T12:00:00.000Z", kind: "context", events: [["s16-cancel-a", "user", "2026-09-04T12:00:00.000Z", "面试结果不用再问了，但开源项目说明还要继续。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [
        outcome("s16-a", "2026-09-04T12:00:00.000Z", ["cancel"], ["s16-cancel-a"], "context"),
        outcome("s16-b", T1, ["contact"], ["s16-b"], "scheduled"),
      ],
      baseline: [
        outcome("s16-a", T1, ["cancel"], ["s16-cancel-a"]),
        outcome("s16-b", T1, ["contact"], ["s16-b", "s16-cancel-a"]),
      ],
      contactRequired: ["s16-b"],
      contactForbidden: ["s16-a"],
      annotation: "针对一个理由的取消不能误伤另一个理由。",
    },
    intentCount: 2,
    baselineMemoryCount: 2,
    comparisonClaim: "earlier-terminal-state",
  }),
  makeScenario({
    id: "s17-similar-learning-update",
    category: "partial-relevance",
    initial: [["s17-plan", "user", T0, "北京时间9月5日晚上问问我小王考研复习进展。"]],
    steps: [
      { at: "2026-09-03T12:00:00.000Z", kind: "context", events: [["s17-unrelated", "user", "2026-09-03T12:00:00.000Z", "我今天学会了用新的英语背词软件，感觉学习效率高了。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s17-plan", T1, ["contact"], ["s17-plan"], "scheduled")],
      baseline: [outcome("s17-plan", T1, ["contact"], ["s17-plan"])],
      contactRequired: ["s17-plan"],
      forbiddenWakeTraceTimes: ["2026-09-03T12:00:00.000Z"],
      annotation: "只有学习主题相似，不足以提前触发或关闭考研跟进。",
    },
  }),
  makeScenario({
    id: "s18-similar-content-negative",
    category: "negative-extraction",
    initial: [["s18-chat", "user", T0, "小王最近在复习考研，我只是随口说说，不需要你以后提醒、跟进或联系。"]],
    steps: [
      { at: "2026-09-03T12:00:00.000Z", kind: "context", events: [["s18-learning", "user", "2026-09-03T12:00:00.000Z", "今天看到一篇学习方法的文章。"]] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [],
      baseline: [],
      annotation: "包含未来话题词但明确无跟进需求，两个系统都不应建立任务。",
      contactForbidden: [],
    },
    intentCount: 0,
    baselineMemoryCount: 0,
    comparisonClaim: "negative-extraction",
  }),
  makeScenario({
    id: "s19-vague-no-new-reason",
    category: "insufficient-reason",
    initial: [["s19-plan", "assistant", T0, "也许北京时间9月5日晚上可以问问小王最近怎么样；只是一个很弱的想法，如果没有新的理由就不必打扰。"]],
    steps: [{ at: T1, kind: "scheduled" }],
    expected: {
      wake: [outcome("s19-plan", T1, ["silent", "defer"], ["s19-plan"], "scheduled")],
      baseline: [outcome("s19-plan", T1, ["silent", "defer"], ["s19-plan"])],
      contactForbidden: ["s19-plan"],
      annotation: "弱意图在没有新事实时不应为了完成任务而联系。",
    },
  }),
  makeScenario({
    id: "s20-unanswered-outreach",
    category: "insufficient-reason",
    initial: [["s20-plan", "user", T0, "北京时间9月5日晚上如果合适，可以问问我健身计划坚持得怎么样。"]],
    steps: [
      { at: "2026-09-04T08:00:00.000Z", kind: "context", events: [
        ["s20-assistant-1", "assistant", "2026-09-03T08:00:00.000Z", "最近还好吗？"],
        ["s20-assistant-2", "assistant", "2026-09-04T08:00:00.000Z", "昨天没收到回复，希望你一切顺利。"],
      ] },
      { at: T1, kind: "scheduled" },
    ],
    expected: {
      wake: [outcome("s20-plan", T1, ["silent", "defer"], ["s20-assistant-1", "s20-assistant-2"], "scheduled")],
      baseline: [outcome("s20-plan", T1, ["silent", "defer"], ["s20-assistant-1", "s20-assistant-2"])],
      contactForbidden: ["s20-plan"],
      annotation: "连续主动消息无人回复时，应提高打扰判断并保持沉默。",
    },
  }),
];

const dataset = {
  schemaVersion: "1.0.0",
  name: "WakeIntent intent continuity value falsification",
  version: "1.0.0",
  kind: "intent-continuity-value-fixtures",
  frozenAt: "2026-09-05T00:00:00.000Z",
  repetitions: 3,
  hypothesis: "显式、可持续重评的 ContactIntent 生命周期，相比强 Memory + Proactive Agent，会在现实变化场景中减少误触达或漏跟进，并产生可感知的连续性差异。",
  fairness: {
    sameModel: true,
    sameProviderDefaultTemperature: true,
    sameInitialEvents: true,
    sameLatestEvents: true,
    sameClockAndTimeZone: true,
    sameUserState: true,
    baselineHasFutureMemory: true,
  },
  stopRule: {
    maximumScenarios: 20,
    repetitions: 3,
    independentValueFalseOutreachReductionPoints: 0.1,
    independentValueMissedFollowupReductionPoints: 0.1,
    parityAgreementThreshold: 0.9,
    humanContinuityMeanDifference: 0.4,
    note: "只运行冻结的20个场景，每个系统每场景3次。不得因结果不利而加题或改标注。行为近似、成本更高且盲评连续性差异不足0.4分时，应判为独立价值不足。",
  },
  scenarios,
};

writeFileSync(
  resolve("evals", "intent-continuity-value-v1.json"),
  `${JSON.stringify(dataset, null, 2)}\n`,
  "utf8",
);
console.log(`Wrote ${scenarios.length} frozen scenarios.`);
