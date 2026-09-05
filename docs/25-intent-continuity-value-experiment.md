# WakeIntent 核心价值证伪实验（v1）

## Hypothesis

待验证的假设是：

> 当过去产生的未来联系理由遇到现实变化时，把它保存成持续存在、可更新、可取消、可过期并可审计的 ContactIntent，会比强 Memory + Proactive Agent 更少误触达或漏跟进，并产生可感知的连续性。

本实验优先尝试推翻假设。主动联系、保存记忆、六种决策动作本身都不算 WakeIntent 的独特价值。

## Method

对照系统只有两套：

- **Baseline A：Memory + Proactive Agent**。模型从初始对话保存简洁的未来跟进 memory（摘要、来源事件、到期时间）。到期后读取完整初始对话、累计最新事件、当前时间、时区和用户状态，再直接判断 CONTACT / DEFER / CANCEL / RESOLVE / EXPIRE / SILENT。它能识别间接解决和上下文反转，不使用 ContactIntent 生命周期字段。
- **System B：WakeIntent**。复用现有候选提取、持久意图字段、相关事件路由、确定性门控和语义重评，不为实验改写核心架构。

公平约束：

1. 同一轮双方使用同一个模型、API 模式和服务商默认 temperature。
2. 双方接收相同的原始对话、累计新上下文、时钟、时区和用户状态。
3. Baseline 获得一条正常现代 Agent 会保存的未来跟进 memory，而非弱提醒。
4. 运行顺序交替，降低先后顺序导致的服务波动。传输层重试不改变模型输入、场景轮次或计分。
5. 网络错误、408、429 和 5xx 对同一幂等请求最多重试 1 次；运行器在每次 HTTP 尝试前写检查点，全部尝试仍受同一个冻结硬上限约束。
6. 结果不利时不新增场景、不改标注、不无限重跑。

数据集固定为 [intent-continuity-value-v1.json](../evals/intent-continuity-value-v1.json)：20 个场景，每场景 3 次，每次同时运行两套系统，共 60 组盲对照、120 次系统运行。

预先冻结的“独立价值不足”信号：

- 完整动作序列一致率至少 90%；
- WakeIntent 的误触达率改善低于 10 个百分点；
- WakeIntent 的漏跟进率改善低于 10 个百分点；
- 真人盲评“连续性”均值优势低于 0.4 / 5；
- 同时 WakeIntent 的调用、Token 或实现复杂度更高。

满足这些条件时，应明确选择“核心机制没有产生足够明显的行为差异”，而不是继续加题寻找胜利。

## Scenarios

20 个冻结场景覆盖：

- 正常跟进 × 2；
- 提前得知结果或任务完成 × 2；
- 显式取消 × 2；
- 忙碌延期后恢复联系 × 2；
- 自然过期 × 2；
- 话题或目标反转 × 2；
- 关系变化 × 2；
- 多意图竞争 × 2；
- 相似但不相关信息或负例 × 2；
- 没有充分联系理由、连续不回复 × 2。

关键 Demo 是 `s07-living-demo-busy-then-free`：过去形成“考研跟进”想法；第一次到期时小王在忙实习，预期 DEFER；第二次到期时实习完成且轻松，预期 CONTACT。两套系统接收完全相同的三段对话和时间。

## Results

运行以下命令只显示计划，不加载 `.env`、不调用 API：

```powershell
pnpm eval:intent-continuity:plan
```

经授权后执行冻结实验：

```powershell
pnpm eval:intent-continuity:api
```

只运行关键 Demo 的计划或真实复验：

```powershell
pnpm demo:intent-continuity:plan
pnpm demo:intent-continuity:api
```

每次真实运行在 `reports/intent-continuity-value/<run-id>/` 写出：

- `results.json`：逐请求、逐意图、逐决策与总体指标；
- `results.csv`：每个系统运行一行的机器可读对比；
- `experiment-report.md`：本次运行的人类可读报告；
- `blind-evaluation.json`：隐藏系统身份的 A/B 材料；
- `blind-key.json`：单独保存的身份答案；
- `human-ratings-template.csv`：真人评分表。

### Final Frozen Run

从正式检查点 `reports/intent-continuity-value/2026-09-05T11-50-41.477Z/results.json` 续跑第三轮后，冻结实验完成 60/60 组，0 个运行错误，实际 327 次 HTTP 尝试，其中 WakeIntent 发生 1 次传输重试，Baseline 0 次。原始 `results.json` 未被修改。

| 指标 | WakeIntent | 强 Baseline |
|---|---:|---:|
| 漏掉应联系 | 3 / 21 (14.3%) | 1 / 21 (4.8%) |
| 无理由误触达 | 0 / 48 (0.0%) | 0 / 48 (0.0%) |
| 模型调用 | 172 | 146 |
| 输入 Token | 87,609 | 57,889 |
| 输出 Token | 67,846 | 51,464 |
| 总 Token | 155,455 | 109,353 |
| 总运行延迟（ms） | 1,663,908.933 | 1,263,852.935 |
| 费用 | 不可得 | 不可得 |

WakeIntent 比 Baseline 多 26 次模型调用（约 +17.8%）、多 46,102 个 Token（约 +42.2%）和约 31.7% 的累计运行延迟。动作序列一致率为 61/69（88.4%），低于冻结的 90% 近似阈值。三轮分别通过 17/20、18/20、18/20 组。费用不可得，因为本轮没有配置模型单价。

完整报告、CSV 和盲评材料见 `reports/intent-continuity-value/2026-09-05T11-50-41.477Z/`。目录包含 `results.json`、`results.csv`、`experiment-report.md`、`blind-evaluation.json`、`blind-key.json` 和 `human-ratings-template.csv`。盲评材料有 20 个 A/B 项目，但尚无至少 5 名真实测试者评分。

三轮中只有四个场景出现动作序列差异：

- `s16-two-intents-one-cancelled`：三轮均将应保留的第二个项目意图一并取消，WakeIntent 漏跟进 3 次；Baseline 三轮均取消第一个意图并联系第二个。
- `s17-similar-learning-update`：第一轮 Baseline 把不相关的学习软件更新误判为取消，WakeIntent 正确联系；后两轮两边均联系，说明这是一次随机波动而非稳定优势。
- `s19-vague-no-new-reason`：WakeIntent 在部分轮次不创建意图，Baseline 创建 memory 后在到期时 `silent`、`expire` 或 `resolve`；用户可见结果均没有消息，主要是内部路径差异。
- `s20-unanswered-outreach`：双方均没有误触达，第三轮仅在允许的 `silent/defer` 之间出现差异。

关键 Demo `s07-living-demo-busy-then-free` 三轮两边动作均为 `defer -> contact`。WakeIntent 的实际联系消息示例为“**小王，听说你最近把实习搞定了，轻松多了。之前想问问你考研准备得怎么样了，最近还顺利吗？**”；Baseline 的实际联系消息示例为“**小王，听说你最近终于把实习搞定了，辛苦啦！现在轻松些了，考研准备得怎么样？**”。两边都正确完成延期后联系，消息差异属于措辞差异，不能据此宣称连续性感知优势。

## Human Evaluation

至少 5 名真实测试者在不知道 A/B 身份的情况下，对每个场景抽取的一组 A/B 行为（共 20 项）分别给 1–5 分：

- 自然程度；
- 是否像 AI 真的记得这件事；
- 是否像 AI 根据后续变化改变了主意；
- 被打扰程度（越低越好）；
- 连续性感受。

测试者不能看到 `blind-key.json`。填完评分表后运行：

```powershell
node scripts/score-intent-continuity-human-eval.mjs --ratings=<完成的CSV> --key=<blind-key.json>
```

脚本拒绝少于 5 个不同 tester_id，也拒绝缺失或超出 1–5 的评分。项目不会用模型评分冒充真人评价。

## Failure Cases

以下情况都必须保留在结果中：

- 任一系统把反转、取消、过期或连续不回复判为 CONTACT；
- 任一系统漏掉明确且仍有价值的跟进；
- WakeIntent 因路由或状态调度没有在延期后再次醒来；
- Baseline 仅靠普通 memory 也稳定得到相同行为；
- WakeIntent 只增加可审计字段，却没有改变对用户的实际行为；
- 三次重复出现明显波动；
- WakeIntent 的额外模型调用和 Token 没有换来行为或盲评收益。

## Conclusion

最终只接受三个结论：

1. 行为差异和真人连续性感知都达到冻结阈值，支持独立 ContactIntent 模块；
2. 有部分工程价值，但差异不足以支持独立产品，更适合作为主动聊天系统内部子系统；
3. 与强 Baseline 基本相同或成本不成比例，应收缩或合并实现。

在真实 API 的 60 组对照与至少 5 人盲评完成前，本文件不预写“继续做”或“停止”的答案。

### Final Answer

- Q1：有一定行为差异，但没有达到独立价值阈值。动作序列一致率为 88.4%，误触达双方均为 0，WakeIntent 漏跟进率反而高于 Baseline。
- Q2：差异集中在 `s16` 多意图竞争、`s17` 相似但不相关更新、`s19` 无充分新理由和 `s20` 连续未回应。只有 `s16` 是稳定且不利于 WakeIntent 的差异；`s17` 的一次 Baseline 误判没有跨轮稳定。
- Q3：待真人验证。已经生成 20 项盲评材料，但没有至少 5 名真实测试者的评分，不能声称更自然或更有连续性。
- Q4：在本冻结实验的用户可见结果范围内，只保留 Memory + LLM 可以得到大体近似的结果；但内部生命周期路径不同，且 WakeIntent 没有减少误触达或漏跟进，调用和 Token 更高。

**明确选择结论 3：与强 Baseline 基本相同或成本不成比例，应收缩或合并实现。**
