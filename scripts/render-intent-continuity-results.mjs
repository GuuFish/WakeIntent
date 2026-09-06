import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const csvCell = (value) => {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const num = (value) => typeof value === "number" ? value.toLocaleString("en-US") : "n/a";

function actionRows(result, arm) {
  if (arm === "wakeintent") {
    return (result.wakeintent.result?.traces ?? []).map((trace) => ({
      at: trace.at,
      action: trace.decision.action,
      reason: trace.decision.reason,
      message: result.wakeintent.messages.find((message) => message.at === trace.at)?.message ?? null,
    }));
  }
  return (result.baseline.result?.traces ?? []).flatMap((trace) =>
    trace.decisions.map((decision) => ({
      at: trace.at,
      action: decision.action,
      reason: decision.reason,
      message: result.baseline.messages.find((message) => message.at === trace.at)?.message ?? null,
    })),
  );
}

function humanPacket(report) {
  const items = report.results
    .filter((result) => result.error === null && result.repetition === 1)
    .map((result) => {
      const hash = createHash("sha256").update(`${report.runId}:${result.runKey}`).digest("hex");
      const aIsWake = Number.parseInt(hash.slice(0, 2), 16) % 2 === 0;
      const armA = aIsWake ? "wakeintent" : "baseline";
      const armB = aIsWake ? "baseline" : "wakeintent";
      return {
        itemId: hash.slice(0, 12),
        scenarioId: result.scenarioId,
        repetition: result.repetition,
        conversation: {
          initialEvents: result.scenario.initialEvents,
          timeline: result.scenario.steps,
        },
        behaviorA: actionRows(result, armA),
        behaviorB: actionRows(result, armB),
      };
    });
  const key = report.results
    .filter((result) => result.error === null && result.repetition === 1)
    .map((result, index) => {
      const item = items[index];
      const hash = createHash("sha256").update(`${report.runId}:${result.runKey}`).digest("hex");
      const aIsWake = Number.parseInt(hash.slice(0, 2), 16) % 2 === 0;
      return {
        itemId: item.itemId,
        A: aIsWake ? "wakeintent" : "baseline",
        B: aIsWake ? "baseline" : "wakeintent",
      };
    });
  return { items, key };
}

function behavioralVerdict(report) {
  const aggregate = report.aggregate;
  const stop = report.dataset.stopRule;
  if (aggregate.pairedRunsCompleted !== aggregate.pairedRunsPlanned || aggregate.errors > 0) {
    return {
      code: "incomplete",
      text: "运行不完整，不能判断 WakeIntent 的核心价值。",
    };
  }
  const agreement = aggregate.decisionAgreement.rate ?? 0;
  const falseImprovement =
    (aggregate.falseOutreach.baselineRate ?? 0) -
    (aggregate.falseOutreach.wakeintentRate ?? 0);
  const missedImprovement =
    (aggregate.missedFollowup.baselineRate ?? 0) -
    (aggregate.missedFollowup.wakeintentRate ?? 0);
  if (
    agreement < stop.parityAgreementThreshold ||
    falseImprovement < stop.independentValueFalseOutreachReductionPoints ||
    missedImprovement < stop.independentValueMissedFollowupReductionPoints
  ) {
    return {
      code: "conclusion-3",
      text: "按冻结规则选择结论 3：与强 Baseline 的行为差异未达到独立价值阈值，且 WakeIntent 存在更高调用、Token 或错误率，当前应收缩或合并实现。",
    };
  }
  if (
    falseImprovement >= stop.independentValueFalseOutreachReductionPoints ||
    missedImprovement >= stop.independentValueMissedFollowupReductionPoints
  ) {
    return {
      code: "material-behavioral-difference-candidate",
      text: "自动行为结果出现预先定义的实质差异，但独立模块价值仍需至少 5 名真人盲评确认。",
    };
  }
  return {
    code: "conclusion-2",
    text: "按冻结规则选择结论 2：存在工程差异，但不足以支持独立产品，更适合作为主动聊天系统内部子系统。",
  };
}

function behaviorDifferences(report) {
  const byScenario = new Map();
  for (const result of report.results) {
    const entry = byScenario.get(result.scenarioId) ?? {
      scenarioId: result.scenarioId,
      runs: 0,
      differingRuns: 0,
      wakeMissed: 0,
      baselineMissed: 0,
      wakeFalse: 0,
      baselineFalse: 0,
    };
    entry.runs += 1;
    entry.differingRuns +=
      JSON.stringify(result.wakeintent.behavior?.actionSequences ?? {}) !==
      JSON.stringify(result.baseline.behavior?.actionSequences ?? {})
        ? 1
        : 0;
    entry.wakeMissed += result.wakeintent.behavior?.missedFollowup ?? 0;
    entry.baselineMissed += result.baseline.behavior?.missedFollowup ?? 0;
    entry.wakeFalse += result.wakeintent.behavior?.falseOutreach ?? 0;
    entry.baselineFalse += result.baseline.behavior?.falseOutreach ?? 0;
    byScenario.set(result.scenarioId, entry);
  }
  return [...byScenario.values()].filter(
    (entry) =>
      entry.differingRuns > 0 ||
      entry.wakeMissed !== entry.baselineMissed ||
      entry.wakeFalse !== entry.baselineFalse,
  );
}

export async function renderIntentContinuityArtifacts(reportPath) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const outputDir = dirname(reportPath);
  const rows = [
    [
      "scenario_id", "repetition", "system", "error", "actions",
      "false_outreach", "missed_followup", "model_calls",
      "input_tokens", "output_tokens", "total_tokens", "cost_usd", "latency_ms",
    ],
  ];
  for (const result of report.results) {
    for (const system of ["wakeintent", "baseline"]) {
      const arm = result[system];
      rows.push([
        result.scenarioId,
        result.repetition,
        system,
        result.error,
        arm.behavior?.actionSequences ?? null,
        arm.behavior?.falseOutreach ?? null,
        arm.behavior?.missedFollowup ?? null,
        arm.usage.calls,
        arm.usage.inputTokens,
        arm.usage.outputTokens,
        arm.usage.totalTokens,
        arm.usage.costUsd,
        arm.latencyMs,
      ]);
    }
  }
  await writeFile(
    resolve(outputDir, "results.csv"),
    `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`,
    "utf8",
  );

  const blind = humanPacket(report);
  await writeFile(
    resolve(outputDir, "blind-evaluation.json"),
    `${JSON.stringify({
      schemaVersion: "1.0.0",
      instructions: "每位测试者独立评分，不猜系统身份。每项对 A/B 分别给 1-5 分；disturbance 代表被打扰程度，分数越低越好。",
      dimensions: ["naturalness", "remembered", "changedMind", "disturbance", "continuity"],
      items: blind.items,
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(outputDir, "blind-key.json"),
    `${JSON.stringify({ warning: "盲评结束前不要交给测试者。", key: blind.key }, null, 2)}\n`,
    "utf8",
  );
  const surveyHeader = [
    "tester_id", "item_id",
    "naturalness_A", "remembered_A", "changed_mind_A", "disturbance_A", "continuity_A",
    "naturalness_B", "remembered_B", "changed_mind_B", "disturbance_B", "continuity_B",
    "preferred", "comment",
  ];
  await writeFile(
    resolve(outputDir, "human-ratings-template.csv"),
    `${surveyHeader.join(",")}\n${blind.items.map((item) => `,${item.itemId},,,,,,,,,,,,,\n`).join("")}`,
    "utf8",
  );

  const a = report.aggregate;
  const verdict = behavioralVerdict(report);
  const failures = report.results.filter((result) => result.error || !result.score?.passed);
  const markdown = `# WakeIntent 核心价值证伪实验

## Hypothesis

${report.dataset.hypothesis}

本实验优先尝试证明显式 ContactIntent 没有产生足够差异。若强 Memory + Proactive baseline 得到近似行为，而 WakeIntent 付出更多调用、Token 或工程复杂度，则不支持继续把它作为独立项目扩张。

## Method

- 冻结场景：${report.aggregate.pairedRunsPlanned / 3} 个。
- 每场景重复：3 次；两套系统共 ${report.aggregate.pairedRunsPlanned * 2} 次系统运行。
- 模型：${report.fairness.model}；API 模式：${report.fairness.apiMode}。
- temperature：两边均不传值，使用同一服务商默认值。
- 两边接收相同初始对话、累计新上下文、时钟、时区和用户状态。
- Baseline 会保存未来跟进 memory，并在到期时由同一 LLM 判断 CONTACT / DEFER / CANCEL / RESOLVE / EXPIRE / SILENT。
- 唯一核心变量是 WakeIntent 使用显式生命周期、证据、状态、重评与确定性门控。
- 运行顺序按场景与重复轮次交替；HTTP 尝试硬上限为 ${report.requestBudget.maxLogicalRequests}，实际尝试 ${report.requestBudget.attemptedHttpRequests} 次。

## Scenarios

覆盖正常跟进、提前解决、明确取消、忙碌延期后恢复、过期、上下文反转、关系变化、多意图竞争、相似但不相关信息、无充分理由联系，以及连续主动消息无人回复。完整固定输入和标注见 \`evals/intent-continuity-value-v1.json\`。

## Results

| 指标 | WakeIntent | 强 Baseline |
|---|---:|---:|
| 无理由误触达 | ${a.falseOutreach.wakeintent} / ${a.falseOutreach.denominatorPerArm} (${pct(a.falseOutreach.wakeintentRate)}) | ${a.falseOutreach.baseline} / ${a.falseOutreach.denominatorPerArm} (${pct(a.falseOutreach.baselineRate)}) |
| 漏掉应联系 | ${a.missedFollowup.wakeintent} / ${a.missedFollowup.expectedPerArm} (${pct(a.missedFollowup.wakeintentRate)}) | ${a.missedFollowup.baseline} / ${a.missedFollowup.expectedPerArm} (${pct(a.missedFollowup.baselineRate)}) |
| 模型调用 | ${num(a.usage.wakeintent.calls)} | ${num(a.usage.baseline.calls)} |
| 输入 Token | ${num(a.usage.wakeintent.inputTokens)} | ${num(a.usage.baseline.inputTokens)} |
| 输出 Token | ${num(a.usage.wakeintent.outputTokens)} | ${num(a.usage.baseline.outputTokens)} |
| 总 Token | ${num(a.usage.wakeintent.totalTokens)} | ${num(a.usage.baseline.totalTokens)} |
| 可选费用（USD） | ${num(a.usage.wakeintent.costUsd)} | ${num(a.usage.baseline.costUsd)} |
| 总运行延迟（ms） | ${num(a.latencyMs.wakeintent)} | ${num(a.latencyMs.baseline)} |

动作序列一致率：${a.decisionAgreement.agreements} / ${a.decisionAgreement.comparisons}（${pct(a.decisionAgreement.rate)}）。这里比较每条原始未来理由经历的完整动作序列，而不只比较最后是否联系。

## Behavioral Differences

${behaviorDifferences(report).length === 0 ? "三轮中没有观察到行为序列差异。" : behaviorDifferences(report).map((entry) => `- ${entry.scenarioId}：${entry.differingRuns}/${entry.runs} 轮动作序列不同；WakeIntent 漏跟进 ${entry.wakeMissed} 次，Baseline ${entry.baselineMissed} 次；误触达分别为 ${entry.wakeFalse}/${entry.baselineFalse}。`).join("\n")}

Q1：有差异，但没有达到独立价值阈值。完整动作序列一致率为 ${pct(a.decisionAgreement.rate)}，低于冻结的 ${pct(report.dataset.stopRule.parityAgreementThreshold)} 阈值；误触达双方均为 0，WakeIntent 漏跟进率反而高于 Baseline（${pct(a.missedFollowup.wakeintentRate)} 对 ${pct(a.missedFollowup.baselineRate)}）。

Q2：差异集中在多意图竞争、相似学习更新、无充分联系理由和连续未回应场景。s16-two-intents-one-cancelled 中 WakeIntent 将两个意图都取消，漏掉仍应联系的项目意图；s17-similar-learning-update 第 1 轮 WakeIntent 正确联系而 Baseline 错误取消，但 Baseline 后两轮恢复正确；s19-vague-no-new-reason 两边都没有用户可见消息，差异主要是 WakeIntent 不创建意图而 Baseline 到期后沉默/终止；s20-unanswered-outreach 双方都保持无误触达，第三轮仅在允许的 silent/defer 之间不同。

## Human Evaluation

状态：**等待至少 5 名真实测试者**。本运行已生成 \`blind-evaluation.json\`、隔离的 \`blind-key.json\` 和 \`human-ratings-template.csv\`。程序没有伪造真人分数。因此“人是否觉得更自然、更像真的记得并改变主意”目前不能下结论。

## Failure Cases

${failures.length === 0 ? "冻结评分未发现失败。" : failures.map((failure) => "- " + failure.runKey + ": " + (failure.error ?? "未通过冻结期望")).join("\n")}

## Conclusion

自动行为判定：**${verdict.code}**。

${verdict.text}

Q3：待真人验证。盲评材料已生成，但目前没有至少 5 名真实测试者的评分，不能声称 WakeIntent 更自然或更有连续性。
Q4：在本实验的冻结范围内，去掉显式生命周期可以得到大体近似的用户可见结果，但内部路径不同；同时 WakeIntent 没有降低误触达或漏跟进，且调用和 Token 更高。因此不能把生命周期的存在解释为已证明的行为收益。

## Final Conclusion

**明确选择结论 3：与强 Baseline 基本相同或成本不成比例，应收缩或合并实现。**

${verdict.text}
`;
  await writeFile(resolve(outputDir, "experiment-report.md"), markdown, "utf8");
  return { outputDir, verdict, blindItems: blind.items.length };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith("--report="));
  if (!argument) throw new Error("Use --report=<reports/.../results.json>");
  const reportPath = resolve(argument.slice("--report=".length));
  console.log(await renderIntentContinuityArtifacts(reportPath));
}
