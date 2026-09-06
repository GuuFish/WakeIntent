# 自主经历（Autonomous Experience）核心价值实验

> 状态：协议与场景已冻结；正式实验及方法审计已完成，最终为 **B_DIFFERENT_NOT_VALUABLE**  
> 结果：`docs/28-autonomous-experience-result.md`  
> 冻结时间：2026-09-06T01:30:00+08:00  
> 数据集：`evals/autonomous-experience-v1.json`  
> 重复次数：20 个场景 × 3 轮 × 2 个 Agent

## Hypothesis

本实验只验证一个假设：

> 用户离开期间，Agent 实际执行的一次有限、非任务驱动活动，能否产生可验证的持久状态；该状态后来是否改变行为、为用户带来实际价值，而且强 Memory + Proactive Agent 在用户回来时使用相同工具仍难以自然重建。

实验优先尝试证伪。自主活动更拟人、输出不同或更主动，都不算正向证据。

## Method

### Agent A：强 Baseline

Agent A 保存全部原始对话和长期 Memory。用户回来或主动检查点到达时，它读取相同历史、后来上下文、用户状态和时间，并可使用与 Agent B 相同的冻结查询工具一次。它可以回复、联系、延期或沉默。用户缺席期间不运行。

### Agent B：Autonomous Experience Agent

Agent B 的回归能力与 A 相同。唯一额外能力是在 Away Time 内决定：

- `do_nothing`；
- 或从三个候选查询中实际执行一个 `lookup`。

模型在选择前看不到查询结果。只有 runner 真正执行冻结工具后，模型才能把结果整合为 Experience Record。记录必须引用真实 result ID，包含状态变化、是否存在待分享内容和形成原因。未执行的经历不能写入。

### 公平性与反事实

- 同一模型、同一服务商默认 temperature；
- 同一原始对话、Memory、后来上下文、用户状态和时间；
- 两个 Agent 回归时拥有同一工具目录和一次查询预算；
- Baseline 因此可以在用户回来时重新搜索，直接检验可重建性；
- 返回行为交替执行先后顺序；
- 比较器只看到 Candidate 1/2，不知道哪个是自主 Agent；
- 工具使用冻结的合成世界数据，保证三轮事实不漂移；
- 场景、结论阈值和评分在真实输出出现前冻结。

这个设计不声称模拟互联网本身。它验证的是“先选择活动 → 实际执行工具 → 得到此前未知结果 → 写入状态 → 影响未来行为”的因果链。

## Budgets

每个配对场景：

- Away 活动最多 1 次；
- Away 模型调用最多 2 次（选择、结果整合）；
- 每个 Agent 回归查询最多 1 次；
- 盲比较模型调用 1 次；
- 最多 7 次逻辑模型调用；
- 网络错误、408、429、5xx 最多重试一次；
- 60 个配对运行最多 420 次逻辑调用、840 次 HTTP 尝试。

`do_nothing` 是合法结果。没有收益、缺少授权、涉及隐私或只有无关工具时，应优先什么都不做。

## Scenarios

| ID | 核心变化 | 正向经历是否可能有价值 |
| --- | --- | --- |
| ae01 | 自主发现东京展览，用户回来后有空 | 是 |
| ae02 | 自主发现软件修复版本 | 是 |
| ae03 | 演出票在用户回来前过期 | 否 |
| ae04 | 用户明确禁止离开期间查询 | 否 |
| ae05 | 普通闲聊，没有值得做的事 | 否 |
| ae06 | 用户后来明确反转兴趣 | 否 |
| ae07 | 想分享但用户忙，之后恢复 | 是 |
| ae08 | 用户回来处理紧急无关问题 | 否 |
| ae09 | 自主整理学习方法证据 | 可能，但易被 Baseline 重建 |
| ae10 | 新出现的资助截止日 | 是 |
| ae11 | 关系变化使礼物想法失效 | 否 |
| ae12 | 用户明确要求家庭健康信息不外查 | 否 |
| ae13 | 偶遇与用户兴趣相关的天文信息 | 可能 |
| ae14 | Agent 形成音乐偏好但用户问代码 | 否 |
| ae15 | 只有未经证实的传言 | 否 |
| ae16 | 自主发现交通检修 | 是 |
| ae17 | Away 结果后来被官方信息推翻 | 需要重新查证 |
| ae18 | 未受委托的小型整理与当前话题无关 | 否 |
| ae19 | 用户回来直接询问，Baseline 可立即重建 | 反事实负例 |
| ae20 | 临近截止的重要规则变化 | 是 |

## Results metrics

每轮记录：

- 两个 Agent 的最终动作与消息；
- Agent B 是否选择 `do_nothing` 或实际工具；
- 工具调用、result IDs、Experience Record 和状态增长字节；
- B 的回归行为是否引用真实 Experience Record；
- 盲比较的功能等价、用户价值 1–5、偏好和无依据事实；
- Baseline 是否产生功能等价行为；
- Away、两边回归和盲比较各自的模型调用、Token、费用与总延迟；
- 三轮中同一场景是否稳定复现。

`valuableHardToReconstruct` 只有同时满足以下条件才为真：

1. B 引用了真实执行后形成的 Experience Record；
2. 没有伪造来源或无依据事实；
3. 两种行为不具有功能等价性；
4. 盲比较给 B 的用户价值至少 4 分；
5. 盲比较偏好 B；
6. Baseline 没有重建同等行为。

## Frozen conclusion rule

结论只能是：

- **A_NO_ADDITIONAL_VALUE**：行为差异率低于 20%；
- **B_DIFFERENT_NOT_VALUABLE**：行为有差异，但不满足 C；
- **C_VALUABLE_HARD_TO_RECONSTRUCT**：至少 25% 的完成运行满足全部正向因果链，至少 5 个不同场景在三轮中有两轮稳定复现，同时伪造率为 0、自主 Agent 明显更差的比例不超过 5%。

阈值不会因模型结果临时调整。一次运行失败只按错误报告，不重写场景。完成三轮后停止，不重复运行到想法获胜。

## Human Evaluation

runner 会生成盲评材料，但不会伪造真人评分。模型盲比较只用于第一轮自动筛选；涉及“更自然”“更有连续性”的结论必须标记为尚未经过真人验证。

## Failure Cases

以下都属于失败证据：

- 为了产生经历而滥用查询；
- 违反用户禁止搜索或隐私边界；
- 声称做过未执行的活动；
- 使用已经过期、被反转或不可靠的结果；
- 在紧急或无关对话中强行分享；
- B 的行为虽然不同，但 Baseline 在回来时一次查询即可得到同样结果；
- 计算成本明显增加，但用户行为没有可靠改善。

## Run

离线计划：

```bash
pnpm eval:autonomous-experience:plan
```

真实冻结运行：

```bash
pnpm eval:autonomous-experience:api
```

最小 Demo 使用“忙碌时不分享，回来后重新判断”的 ae07：

```bash
pnpm demo:autonomous-experience:plan
pnpm demo:autonomous-experience:api
```

机器可读结果、CSV、报告和盲评材料写入 `reports/autonomous-experience/<run-id>/`。
