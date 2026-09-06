import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

function csv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return '"' + text.replaceAll('"', '""') + '"';
}

function pct(value) {
  return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "n/a";
}

function usageRow(label, usage) {
  return "| " + label + " | " + usage.calls + " | " +
    (usage.inputTokens ?? "n/a") + " | " + (usage.outputTokens ?? "n/a") +
    " | " + (usage.totalTokens ?? "n/a") + " | " + (usage.costUsd ?? "n/a") + " |";
}

function conclusionText(value) {
  if (value === "C_VALUABLE_HARD_TO_RECONSTRUCT") {
    return "结果 C：自主经历产生了达到冻结阈值的、有价值且难以由 Baseline 重建的差异。";
  }
  if (value === "B_DIFFERENT_NOT_VALUABLE") {
    return "结果 B：自主经历改变了行为，但没有证明这些差异具有足够用户价值或不可重建性。";
  }
  return "结果 A：自主经历没有证明额外价值；强 Baseline 基本能产生相同结果。";
}

function createStableSwap(value) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 2 === 0;
}

export async function renderAutonomousExperienceArtifacts(reportPath) {
  const absolute = resolve(reportPath);
  const report = JSON.parse(await readFile(absolute, "utf8"));
  const outDir = dirname(absolute);
  const inputName = basename(absolute, ".json");
  const suffix = inputName === "results" ? "" : "." + inputName.replace(/^results\.?/, "");
  const outputName = (stem, extension) => stem + suffix + "." + extension;
  await mkdir(outDir, { recursive: true });

  const rows = [[
    "runKey", "scenarioId", "repetition", "error", "awayAction",
    "awayTool", "experienceRecorded", "baselineAction", "autonomousAction",
    "behaviorDifferent", "autonomousValue", "baselineValue", "preferred",
    "valuableHardToReconstruct", "fabricated", "harmful", "latencyMs",
  ]];
  for (const result of report.results) {
    rows.push([
      result.runKey,
      result.scenarioId,
      result.repetition,
      result.error,
      result.autonomous.away?.plan?.action,
      result.autonomous.away?.toolCall?.queryKey,
      result.autonomous.away?.experience?.recorded,
      result.baseline.reentry?.decision?.action,
      result.autonomous.reentry?.decision?.action,
      result.score?.behaviorDifferent,
      result.judge.result?.autonomousValue,
      result.judge.result?.baselineValue,
      result.judge.result?.preferred,
      result.score?.valuableHardToReconstruct,
      result.score?.fabricatedProvenance,
      result.score?.harmful,
      result.latencyMs,
    ]);
  }
  await writeFile(
    resolve(outDir, outputName("results", "csv")),
    rows.map((row) => row.map(csv).join(",")).join("\n") + "\n",
    "utf8",
  );

  const blind = [];
  const key = [];
  for (const result of report.results.filter((item) => !item.error)) {
    const swap = createStableSwap(result.runKey);
    const baseline = {
      action: result.baseline.reentry.decision.action,
      message: result.baseline.reentry.decision.message,
    };
    const autonomous = {
      action: result.autonomous.reentry.decision.action,
      message: result.autonomous.reentry.decision.message,
    };
    blind.push({
      itemId: result.runKey,
      context: result.context,
      candidateA: swap ? autonomous : baseline,
      candidateB: swap ? baseline : autonomous,
      questions: [
        "用户价值 1-5",
        "是否被打扰 1-5",
        "是否自然 1-5",
        "更偏好 A/B/相同",
      ],
    });
    key.push({
      itemId: result.runKey,
      candidateA: swap ? "autonomous" : "baseline",
      candidateB: swap ? "baseline" : "autonomous",
    });
  }
  await writeFile(
    resolve(outDir, outputName("blind-evaluation", "json")),
    JSON.stringify(blind, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    resolve(outDir, outputName("blind-key", "json")),
    JSON.stringify(key, null, 2) + "\n",
    "utf8",
  );

  const a = report.aggregate;
  const positives = report.results.filter((item) => item.score?.valuableHardToReconstruct);
  const failures = report.results.filter(
    (item) => item.score?.harmful || item.score?.fabricatedProvenance,
  );
  const markdown = [
    "# 自主经历核心价值实验报告",
    "",
    "## Hypothesis",
    "",
    report.dataset.hypothesis,
    "",
    "## Method",
    "",
    "冻结数据集版本 " + report.dataset.version +
      "，20 个场景，每个场景 3 次。两边回归时使用同一模型、上下文、用户状态和查询预算；只有 Autonomous Agent 可在 Away Time 执行一次有限活动。比较器不知道候选对应哪个系统。",
    "",
    "## Scenarios",
    "",
    "完成 " + a.pairedRunsCompleted + "/" + a.pairedRunsPlanned +
      " 个配对运行，错误 " + a.errors + " 个。场景定义见 `evals/autonomous-experience-v1.json`。",
    "",
    "## Results",
    "",
    "- 行为不等价：" + a.behaviorDifferentRuns + "/" + a.pairedRunsCompleted +
      "（" + pct(a.behaviorDifferenceRate) + "）",
    "- 有价值且难重建：" + a.valuableHardToReconstructRuns + "/" +
      a.pairedRunsCompleted + "（" + pct(a.valuableHardToReconstructRate) + "）",
    "- 稳定正向场景：" + a.stableValuableScenarioCount,
    "- 伪造或无依据：" + a.fabricatedRuns + "/" + a.pairedRunsCompleted +
      "（" + pct(a.fabricationRate) + "）",
    "- Autonomous 明显更差：" + a.harmfulRuns + "/" + a.pairedRunsCompleted +
      "（" + pct(a.harmfulRate) + "）",
    "- Away 工具调用：" + a.toolCalls.autonomousAway,
    "- 回归工具调用：Autonomous " + a.toolCalls.autonomousReturn +
      "，Baseline " + a.toolCalls.baselineReturn,
    "- Experience 状态增长：" + a.storageBytesAdded + " bytes",
    "",
    "| 阶段 | 模型调用 | 输入 Token | 输出 Token | 总 Token | 费用 USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    usageRow("Autonomous Away", a.usage.autonomousAway),
    usageRow("Autonomous 回归", a.usage.autonomousReturn),
    usageRow("Baseline 回归", a.usage.baselineReturn),
    usageRow("盲比较", a.usage.blindJudge),
    "",
    "## Human Evaluation",
    "",
    "尚未进行真人盲评。仓库只生成了盲评包，模型比较结果不能替代真实用户判断。",
    "",
    "## Positive cases",
    "",
    ...(positives.length
      ? positives.map((item) => "- " + item.runKey + ": " + item.judge.result.raw.rationale)
      : ["- 没有运行满足完整正向因果链。"]),
    "",
    "## Failure Cases",
    "",
    ...(failures.length
      ? failures.map((item) => "- " + item.runKey + ": " +
          (item.judge.result?.raw?.rationale ?? item.error))
      : ["- 自动评分未发现伪造或 Autonomous 明显更差的运行。"]),
    "",
    "## Conclusion",
    "",
    conclusionText(a.conclusion),
    "",
    "该结论只适用于冻结的合成世界和当前模型。没有真人盲评时，不对“活人感”作正面声明。",
    "",
  ].join("\n");
  await writeFile(resolve(outDir, outputName("experiment-report", "md")), markdown, "utf8");
}
