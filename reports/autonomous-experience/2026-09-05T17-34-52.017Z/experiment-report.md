# 自主经历核心价值实验报告

## Hypothesis

A bounded, actually executed autonomous activity during user absence can create persistent state that later causes useful behavior which a strong Memory + Proactive Agent cannot naturally reconstruct at return time.

## Method

冻结数据集版本 1.0.0，20 个场景，每个场景 3 次。两边回归时使用同一模型、上下文、用户状态和查询预算；只有 Autonomous Agent 可在 Away Time 执行一次有限活动。比较器不知道候选对应哪个系统。

## Scenarios

完成 3/3 个配对运行，错误 0 个。场景定义见 `evals/autonomous-experience-v1.json`。

## Results

- 行为不等价：2/3（66.7%）
- 有价值且难重建：2/3（66.7%）
- 稳定正向场景：1
- 伪造或无依据：0/3（0.0%）
- Autonomous 明显更差：1/3（33.3%）
- Away 工具调用：3
- 回归工具调用：Autonomous 0，Baseline 0
- Experience 状态增长：2586 bytes

| 阶段 | 模型调用 | 输入 Token | 输出 Token | 总 Token | 费用 USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Autonomous Away | 6 | 2829 | 3090 | 5919 | n/a |
| Autonomous 回归 | 3 | 2574 | 1742 | 4316 | n/a |
| Baseline 回归 | 3 | 1881 | 1383 | 3264 | n/a |
| 盲比较 | 3 | 3653 | 1316 | 4969 | n/a |

## Human Evaluation

尚未进行真人盲评。仓库只生成了盲评包，模型比较结果不能替代真实用户判断。

## Positive cases

- ae07-pending-share-after-busy:r1: 两者都能回应“项目怎么收口”，但 candidate1 更贴合上下文：它把用户之前想聊的开源维护复盘自然接到当前收口问题上，并给出更具体的冻结范围、整理成果与失败经验的建议，实际可用性更强。candidate2 也合格，但更通用，少了与前文经验的直接连接。两者内容相近但不算功能等价。
- ae07-pending-share-after-busy:r3: 两者都能回应“项目怎么收口”，也都避免在用户忙碌期继续打扰，整体都可用。但 candidate1 更贴合前文可用的开源维护复盘经验，把“冻结实验、记录负面结论”具体落到收口建议上，实用性和上下文连贯性更强。candidate2 更简洁稳妥，但少了这个额外的、与记忆/工具结果一致的定制价值，因此略逊一筹。

## Failure Cases

- ae07-pending-share-after-busy:r2: 两者都准确回应了用户当前需求：在作业完成后讨论项目如何收口，并都提供了结构化收尾思路和进一步协助的邀请。候选1更直接地把收口拆成可执行的四块（交付物、目标、风险、交接/复盘），略更具体，因而稍优；候选2同样有用，但表达更泛一些。两者没有明显事实性断言或工具结果。

## Conclusion

结果 B：自主经历改变了行为，但没有证明这些差异具有足够用户价值或不可重建性。

该结论只适用于冻结的合成世界和当前模型。没有真人盲评时，不对“活人感”作正面声明。
