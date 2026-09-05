# 开发期对照评测

> 文档状态：Implemented Draft 0.1  
> 更新日期：2026-09-02

## 1. 当前用途

当前评测器用于验证实验管线，而不是证明 WakeIntent 已经优于其他方案。`evals/development-v0.1.json` 明确标记为 `development-fixtures`，结果不得写成产品结论。

当前 `dev.4` 包含 10 个场景：有效联系、提前解决、显式取消、明确过期、暂时忙碌、明确频率下的未回应、软性许可下的未回应、隐式目标失效、过去事实负例和模糊未来愿望。

## 2. 对照系统

### WakeIntent

先调用候选提取器产生结构化 `ContactIntent`，再通过生命周期、确定性门控和最新上下文重验证输出决策。

### memory-heartbeat

先保存简化的未来跟进记忆，只允许 `summary`、来源证据和一个 `dueAt`；heartbeat 再读取这些记忆、最新对话、时间和用户状态输出决策。基线不能保存过期条件、取消条件、优先级、打扰成本或生命周期状态。

两组使用同一模型配置、原始事件、最新事件、评估时间、IANA 时区、用户状态、决策标签和结构化输出方式。

## 3. 当前评分

每个系统都会记录：

- 是否正确创建或拒绝候选；
- 决策是否属于人工标注允许集合；
- 必需证据是否被引用；
- 是否整体通过；
- 模型调用次数和端到端延迟；
- 每个逻辑模型调用的 request ID、重试次数、输入/输出/总 token；
- 在价格配置完整时的估算费用；价格或 provider usage 缺失时记录为 `null`；
- 错误信息。

报告还保存本次运行的全局、提取阶段和决策阶段 `reasoningEffort`，以及 `textVerbosity`。对 GPT-5.5，当前开发配置使用“候选/记忆提取 `none`、联系决策 `low`、文本冗长度 `low`”；两组使用相同分阶段配置，但最终结论仍必须在冻结配置后给出。

汇总指标包含通过率、创建准确率、决策准确率、证据准确率、无理由误触达率、有效联系 precision、平均调用次数、平均延迟、输入/输出/总 token 和估算费用。

模型适配器对网络错误、408、429 和 5xx 执行有限次数的受控重试；同一逻辑请求复用幂等键，非暂态 HTTP 错误和结构化输出错误不重试。重试次数和请求 ID会保存在逐调用记录中。

## 4. 运行方式

默认只跑前三个开发场景，两套系统合计最多 12 次模型调用：

```powershell
pnpm eval:api
```

指定少量场景：

```powershell
$env:WAKEINTENT_EVAL_IDS="resolve-before-window,cancel-explicitly"
pnpm eval:api
```

主动运行全部 10 个开发场景：

```powershell
$env:WAKEINTENT_EVAL_LIMIT="all"
pnpm eval:api
```

报告写入 `reports/runs/`，该目录默认不提交 Git。报告包含逐场景原始决策、评分、运行配置摘要和汇总指标，但不包含 API 密钥。

## 5. 得出结论前仍缺少什么

- 扩展并冻结不少于 40 个场景；
- 将开发集与最终测试集分离；
- 对每个配置重复运行并报告波动；
- 增加多意图竞争、时区、免打扰、敏感话题和并发恢复场景；
- 对含糊场景进行不知道系统来源的人工复核；
- 冻结提示词后再运行最终测试集。

在完成上述工作前，只能报告工程可行性和开发期观察，不能宣称 WakeIntent 稳定优于基线。

## 6. 已发现的标注问题

`dev.3` 曾把“用户明确要求本周每天晚上询问，但连续两次未回复”的第三次询问标为 `silent/defer`。真实运行中两组都选择 `contact`，WakeIntent 还明确把未回复列为反证。该结果暴露的是标注把“未回复”等同于“撤销明确频率”，而不是系统必然判断错误。

`dev.4` 保留这段实验历史，但将它拆成两个不同契约：明确每日频率时允许继续联系；只给予偶尔联系许可且明确不要天天催时，连续未回复后应 `silent/defer`。后续不得用 Prompt 强迫这两个场景输出同一动作。

另外，单点场景让两组在同一时刻各调用一次模型，无法评估长期空转。正式成本实验必须按 `docs/05-evaluation-and-acceptance.md` 的时间线协议，同时对比朴素 heartbeat 和带 `dueAt` 过滤的强基线。

## 7. 分阶段推理 A/B 观察

在同一 `resolve-implicit-goal-superseded` 场景、同一 GPT-5.5 中转链路上，`low/low` 与“提取 `none`、决策 `low`”各运行一次：

| 系统 | 配置 | 结果 | 总 Token | 延迟 |
|---|---|---:|---:|---:|
| WakeIntent | `low/low` | 通过 | 1902 | 27209 ms |
| WakeIntent | `none/low` | 通过 | 1187 | 15247 ms |
| memory-heartbeat | `low/low` | 通过 | 1052 | 14954 ms |
| memory-heartbeat | `none/low` | 通过 | 895 | 11842 ms |

该单次 A/B 说明分阶段配置值得保留，但不能据此声称稳定节省；冻结评测时仍需多次重复并报告方差。原始报告分别为 `reports/runs/2026-09-01T12-57-30.825Z.json` 与 `reports/runs/2026-09-01T13-05-38.922Z.json`。

## 8. 离线时间线实验

运行以下命令不会调用真实模型：

```powershell
pnpm eval:timeline
```

首份报告 `reports/timelines/2026-09-01T13-14-38.586Z.json` 显示：

- 30 天无联系机会时，朴素 heartbeat 产生 30 次模型调用；强 `dueAt` baseline 与 WakeIntent 都是 0 次；
- 30 天仅一个有效机会时，朴素 heartbeat 共 31 次，强 baseline 与 WakeIntent 都是 2 次；
- 一个意图提前失效时，强 baseline 与 WakeIntent 都是 2 次，但强 baseline 在到期检查前保留了 112 小时陈旧状态，WakeIntent 在相关上下文到来时清理；
- 三个同窗口意图中一个提前失效时，WakeIntent 比强 baseline 多一次语义判断（3 对 2），换取陈旧状态时长从 112 小时降为 0。

因此，当前数据明确否定“WakeIntent 天然比任何 heartbeat 更省模型调用”的宣传。它的待验证价值是：是否值得用一次可控的事件触发重验证，换取更短的陈旧状态、更少后续误触达和更清晰的生命周期审计。离线时间线只建立成本账本；语义收益仍需真实模型和冻结数据集证明。

## 9. 连续状态运行器

`packages/eval/src/longitudinal.ts` 已实现可注入模型的连续状态编排，而不是把每个评估点当成互不相关的选择题：

- 初始对话只提取一次候选；
- context step 先由可替换 relevance router 选择可能受影响的 active intent；
- 无关事件保留为最新上下文但不立即调用语义模型；
- 相关事件可在 `notBefore` 之前触发语义闭合；
- `resolve`、`cancel`、`expire` 会移除原调度，到期时不得再次唤醒；
- `defer` 更新 `nextEvaluationAt`；一次性 `contact` 后无后续时间则移除调度；
- 多个到期 memory 在强 baseline 中允许批量判断，避免用逐条调用人为削弱基线。

当前 FakeModel 测试覆盖提前解决、无关上下文、延期后联系、无明确 `notBefore`、多意图选择性路由、baseline 到期批量判断和重复决策拒绝。下一步是给 relevance router 接入受控的结构化模型实现，并把同一批连续场景同时跑在两套真实模型编排上。

## 10. 首轮真实连续时间线

`evals/longitudinal-development-v0.1.json` 当前包含两条双意图时间线。两条都要求只终止招聘相关意图，同时保留并按时联系快递意图。

### 10.1 明确影响事件

用户明确说“双选会不去了”。混合路由通过中文主题锚点和影响词在本地选择招聘意图，不调用路由模型。报告 `reports/longitudinal-runs/2026-09-01T13-52-36.509Z.json`：

- WakeIntent 与强 baseline 均通过，都是 3 次模型调用；
- WakeIntent 2164 Token，baseline 1882 Token，额外约 15%；
- WakeIntent 在新上下文到来时取消意图，比 baseline 到期检查提前清理 26 小时；
- 两组都没有误联系已失效的双选会事项，且都正确联系快递。

### 10.2 间接影响事件

用户只说“已签满意 offer，后续招聘活动都不参加”，不出现“双选会”。首次混合路由运行 `2026-09-01T13-55-28.365Z.json` 虽然选对意图，却以无意义英文字符片段 `er` / `of` 为依据，该结果必须视为无效。随后路由改为中文汉字二元组与完整英文词特征，并过滤常见词；间接变化因此回退结构化模型。

有效报告 `reports/longitudinal-runs/2026-09-01T13-59-58.226Z.rescored.json`：

- 模型路由只选择招聘意图，WakeIntent 提前 `cancel`，快递仍 `contact`；
- 强 baseline 到期时以 `expire` 表示该 memory 已失效，且同样正确联系快递；
- WakeIntent 4 次调用、3023 Token；baseline 3 次调用、1900 Token；
- WakeIntent 仍提前清理 26 小时，但为间接语义路由多付一次调用，总 Token 高约 59%。

该结果支持“技术上可行”，但尚不支持“整体价值已证明”。下一阶段必须验证提前清理是否在足够多的长时间线中降低误触达、多意图串扰或重复联系，并判断收益是否值得明确事件约 15%、间接事件约 59% 的当前额外 Token。router model 已做成独立可配置项，也可由宿主在本来就会发生的对话模型回合中提供路由结果，但这些优化都必须分别评测，不能只作理论宣传。

## 11. 独立 relevance router 评测

为避免候选抽取、调度和最终决策掩盖路由问题，新增 `evals/relevance-routing-v0.1.json`，直接向路由器提供三个已存在的 active intent 和最新事件。14 个开发场景覆盖明确取消、间接目标替代、提前完成、延期、暂停、临时全局免打扰、全局撤销、多意图影响、无关完成、表面话题重合、语义诱饵、含糊更新和 assistant 复述。

单轮结果：

| 路由方式 | 精确匹配 | 模型调用 | 总 Token |
|---|---:|---:|---:|
| 混合路由 | 14/14 | 7 | 6428 |
| 全模型路由 | 14/14 | 14 | 12610 |

在该开发集上，混合路由把调用数和 Token 都降低约一半，同时没有降低单轮准确率。对应报告为 `reports/relevance-runs/2026-09-01T14-23-05.591Z-hybrid.json` 与 `reports/relevance-runs/2026-09-01T14-26-28.886Z-model.json`。

上述两份报告使用只返回匹配意图的 `0.1.1` 路由协议。增加 `reevaluate` / `cancel` / `resolve` 影响类型后的 `0.2.0` 协议再次运行 14 个场景，结果仍为 14/14、7 次模型调用，总 Token 为 7012；报告为 `reports/relevance-runs/2026-09-02T01-10-44.357Z-hybrid.json`。影响类型增加了少量输出成本，因此新旧 Token 不应直接混为同一配置。

随后对 `0.2.0` 做两个定向复验：

- `global-followup-withdrawal` 正确选择三个 intent，并全部输出 `cancel`，报告为 `reports/relevance-runs/2026-09-02T01-11-34.880Z-hybrid.json`；
- `temporary-global-do-not-disturb` 只选择了本周到期的求职 intent，漏掉同样在本周到期的快递 intent；已选项安全输出 `reevaluate`，没有误终止，但 route recall 只有 0.5，报告为 `reports/relevance-runs/2026-09-02T01-11-58.738Z-hybrid.json`。

这个复验推翻了“路由稳定 100%”的解释。全局免打扰本质上应先转成 `ContactPolicyState`，再由硬门控统一作用于所有 pending intent，而不应依赖逐 intent 的语义相关性判断。当前已经实现“自然对话 → 候选策略草稿 → core 证据校验 → 正式策略信号”的独立入口，并接入连续时间线：免打扰窗口内的多个排期会被确定性地统一推迟，提前恢复时会还原原排期。尚未完成的是用真实模型验证自然语言策略变化的召回与误报。

### 全局策略信号提取器的离线边界

OpenAI-compatible 参考适配器使用严格 JSON Schema 提取候选信号，提示词明确区分全局策略与单话题取消，并规定“我很忙”本身不构成免打扰。core 不信任模型给出的证据归属和发生时间：仅接受现有用户事件引用，正式 `occurredAt` 取自该事件；免打扰截止时间必须晚于证据事件。时间线假模型测试进一步证明：一条全局免打扰可以同时重排两个意图，在原到期点保持 0 次语义调用；清除免打扰后原排期可恢复。下面的冻结真实评测进一步检验全局拒绝、有限免打扰、恢复授权、普通忙碌和单意图取消。

### 首轮冻结策略信号真实评测

`evals/policy-signal-extraction-v0.1.json` 在提示词调整前冻结，共 20 条：9 个正例和 11 个负例。真实 GPT-5.5 中转运行报告为 `reports/policy-signal-runs/2026-09-02T02-26-21.954Z.json`：18/20 场景精确通过，signal precision/recall 均为 0.90，无请求错误，总计 11,117 Token。11 个负例全部通过，包括普通忙碌、单意图取消、过去时策略、第三方指令、转述、假设句、assistant 证据和含蓄抱怨。

两个失败都发生在“现在可以联系”的恢复语义：一个多输出了授权恢复，另一个少输出了免打扰清除。这暴露的不是普通分类问题，而是输入缺少当前策略状态。`0.2.0` 因此增加 `currentPolicy`，并建立 `evals/policy-signal-extraction-v0.2.json`：原 20 条降为 `regression`，另加 8 条此前未运行的状态转换 holdout。

第二轮全量报告 `reports/policy-signal-runs/2026-09-02T02-36-02.840Z.json` 为 27/28 精确通过、precision 1.0、recall 0.875、0 个误报、17,549 Token；关键的新 holdout 为 8/8，precision/recall 均为 1.0。唯一失败是模型把“清除免打扰”和“授权恢复”正确表达在同一个结构化对象中，适配器因要求两个对象而拒绝。`0.2.1` 增加确定性复合归一化：只有两个字段都明确时才拆分，清除和设置同一免打扰窗口等真正矛盾仍拒绝。修复后的定向真实复验报告 `reports/policy-signal-runs/2026-09-02T02-38-32.310Z.json` 为 1/1、672 Token。该单点复验不等价于重新获得全量 28/28。

截至当前，4 个包构建和类型检查通过，101 项离线测试通过。上述结果证明策略抽取边界具有初步可行性，但仍需重复运行测波动，并在端到端时间线中与强 heartbeat 比较模型调用、误触达和排期变化。

### 三轮稳定性与输出协议修正

在用户明确授权后，`0.2.1` 对 8 条状态 holdout 连续运行三轮，共 24 次真实请求。报告 `reports/policy-signal-runs/2026-09-02T03-50-31.164Z.json` 显示：23/24 精确通过，precision 1.0、recall 0.889、0 个误报、16,909 Token；第 1/3 轮为 8/8，第 2 轮为 7/8。7/8 场景三轮预测完全一致且每轮通过，唯一波动仍是复合恢复：模型第二轮把当前旧免打扰截止时间带进 `clear-do-not-disturb` 对象，本地契约因此拒绝；平均延迟约 10.1 秒，范围 5.1–23.5 秒。

该失败说明混合 union Schema 本身不稳：为了满足 strict Structured Outputs，所有操作共享 `doNotDisturbUntil` 与 `authorization` 两个 nullable 字段，给模型留下了回填无关字段的空间。`0.3.0` 将输出改为 `setDoNotDisturb`、`clearDoNotDisturb`、`setAuthorization` 三个独立数组，每类对象只暴露自身字段，从结构上消除“清除同时携带旧截止时间”。适配器仍拒绝缺少任一操作集合的代理响应。离线构建、类型检查与 101 项测试已通过。

在用户只授权同一个合成复合恢复场景三次后，`0.3.0` 定向冒烟报告 `reports/policy-signal-runs/2026-09-02T04-51-09.282Z.json` 三轮均精确通过：3/3，signal precision/recall/F1 均为 1.0，0 个错误、误报和漏报；三轮都生成 `clear-do-not-disturb` 与 `set-authorization=granted`，`stablePredictionScenarios=1`。共 3 次请求、1506 输入 Token、825 输出 Token、2331 总 Token；费用为 `null`，因为未配置价格，不代表免费。该报告是针对已知失败形状的回归冒烟，不是新的独立 holdout，也不等价于全量稳定性证明。

随后连续运行三轮，共 42 次路由预测。原始标签把“这周别主动联系，下周再说”错误标为影响全部三个 intent；但学习 intent 的 `notBefore` 是下周一，本来就不在免打扰窗口内。模型三轮均只选择本周到期的求职和快递 intent。原始 39/42 报告被保留，数据集升为 `0.1.0-dev.2` 并记录标签变更理由，离线重评分为 42/42、precision/recall/F1 均为 1.0，三轮预测集合一致。原始与重评分报告分别为：

- `reports/relevance-runs/2026-09-01T14-37-54.635Z-hybrid.json`
- `reports/relevance-runs/2026-09-01T14-37-54.635Z-hybrid.rescored.json`

这只能证明路由机制在当前开发集上可行。标签在观察结果后发生过一次有审计记录的修订，因此该数据集绝不能伪装成独立测试集。

P1 离线准备新增 `evals/longitudinal-policy-development-v0.1.json`，包含两个原排期都落在全局免打扰窗口内的意图。`packages/eval/src/longitudinal.test.ts` 的 FakeModel 测试验证 WakeIntent 将策略广播给两个意图并保留两个排期，强 due-gated baseline 则在原到期点用一次批量决策覆盖两个 memory；没有为削弱 baseline 而拆成逐意图调用。该 fixture 和测试没有调用真实模型。

后续已将上述 fixture、两套离线 oracle、评分器和报告脚本真正串联，而不是只保留相互独立的硬编码测试。运行 `pnpm eval:policy-timeline-offline` 生成 `reports/policy-longitudinal-offline/2026-09-02T06-28-49.066Z.json`：两套系统最终都产生两次 `contact`；WakeIntent 在原排期产生 0 个到期唤醒批次，并在策略事件到达时立即更新策略，强 baseline 在原排期使用一次公平批处理覆盖两个 memory，首次响应策略的延迟为 52 小时。当前离线 oracle 管线的逻辑阶段调用上限为 WakeIntent 5 次、baseline 3 次，Token 均为 `null`。因此该实验支持“提前治理共享状态并避免原排期唤醒”，不支持“WakeIntent 更省总调用或 Token”。离线 oracle 只验证编排、记账和 baseline 公平性，不能替代真实模型语义评测。

## 12. 复用路由闭合结论

此前路由已经识别出“意图被取消或已完成”，运行器却丢弃影响类型，再调用一次 decision model。现在 relevance route 会返回 `reevaluate`、`cancel` 或 `resolve`：

- 只有明确取消或明确完成才允许复用为终止决策；
- 延期、忙碌、策略变化、混合影响和含糊变化仍进入完整重验证；
- 复用的结论保留来源事件、置信度和 `relevance-route-closure` 审计元数据；
- 重复 intent match 会合并；影响类型冲突时降级为 `reevaluate`，而不是冒险终止。

同时，候选提取提示词要求 `cancellationHints` 不只描述直接完成，还应在原对话合理支持时记录上游目标完成或被替代，但不得编造具体公司、结果或用户偏好。

最终关键复验 `reports/longitudinal-runs/2026-09-02T01-06-18.414Z.json`：

| 系统 | 是否通过 | 模型调用 | 总 Token | 状态清理时间 |
|---|---:|---:|---:|---:|
| WakeIntent | 是 | 2 | 2854 | 新上下文到达时 |
| 强 due-gated heartbeat | 是 | 3 | 2280 | 到期检查时 |

两组都正确取消求职事项并联系快递。WakeIntent 少一次模型调用，并提前 26 小时清理失效状态；但总 Token 仍高约 25%，主要来自更丰富的首次意图抽取和审计字段。因此可以报告“该场景下减少一次模型调用”，不能报告“整体 Token 或费用更低”。

## 13. 当前证据边界

现有证据已支持：

- 不需要常驻模型自行思考；宿主只在新对话事件或已到时间窗口时调用引擎；
- 它不是固定 heartbeat 换皮：对话会创建带失效条件的持续意图，新上下文可选择性关闭意图并删除未来调度；
- 在明确且可复用的提前失效场景中，可以比强 due-gated baseline 少一次模型调用；
- 无关上下文可以保持无匹配，不必唤醒所有 active intent。

现有证据仍不支持：

- WakeIntent 在总体 Token、费用或最终消息准确率上稳定优于强 baseline；
- 14 个开发场景可以代表真实世界分布；
- 模型或本地规则给出的 `cancel` / `resolve` 在生产环境具有足够低的误终止率；
- 用户一定能感知提前 26 小时清理内部状态；当前强 baseline 在到期时读取完整最新上下文，也能避免错误消息。

正式比较必须把“路由准确率”“终止影响类型准确率”“用户可见误触达”“状态陈旧时长”“模型调用”和“Token/费用”分开报告。

## 14. 核心价值证伪实验最终结果

冻结的 20 个场景、每场景 3 次重复已从正式检查点断点续跑完成：60/60 组、0 个运行错误、327 次 HTTP 尝试；WakeIntent 发生 1 次传输重试，Baseline 没有重试。正式报告目录为 `reports/intent-continuity-value/2026-09-05T11-50-41.477Z/`。

最终指标为：WakeIntent 误触达 0/48、漏跟进 3/21、172 次模型调用、155,455 Token；Baseline 误触达 0/48、漏跟进 1/21、146 次调用、109,353 Token。WakeIntent 比 Baseline 多约 17.8% 调用和 42.2% 总 Token；动作序列一致率为 61/69（88.4%），低于冻结的 90% 阈值。费用不可得，因为没有配置模型单价。三轮通过率分别为 17/20、18/20、18/20。

动作序列差异只出现在四个场景：`s16-two-intents-one-cancelled` 中 WakeIntent 三轮都误取消了仍应联系的第二个意图，造成 3 次漏跟进；`s17-similar-learning-update` 中 WakeIntent 只在第一轮优于 Baseline，后两轮两边一致；`s19-vague-no-new-reason` 主要是 WakeIntent 不创建意图与 Baseline 到期后终止/沉默的内部路径差异，双方都没有用户可见消息；`s20-unanswered-outreach` 双方均无误触达，仅有允许的 `silent/defer` 动作差异。关键 `s07-living-demo-busy-then-free` 三轮均为 `defer -> contact`，两边最终实际消息都合理，不能作为 WakeIntent 独有优势。

本轮盲评材料已生成 20 个 A/B 项目，但没有至少 5 名真实测试者评分，因此 Q3 只能记为“待真人验证”。Q1 的自动答案是“有差异但未达到独立价值阈值”；Q2 的主要稳定差异是 `s16` 的 WakeIntent 漏跟进；Q4 是“用户可见结果大体近似，但内部路径不同，且 WakeIntent 成本更高”。按冻结停止规则，最终选择**结论 3：与强 Baseline 基本相同或成本不成比例，应收缩或合并实现**。原始结果、失败案例和计分限制均保留，不据此修改场景或评分。

## 15. 有限 Alpha 收口集

为了避免长期停留在“继续证明价值”，新增冻结集 `evals/alpha-closure-longitudinal-v0.1.json`，固定 12 条连续时间线及 GO/REVIEW 停止规则。`packages/eval/src/alpha-closure.ts` 负责按意图来源证据匹配两套系统的时间、动作和决策证据，并单独统计意外 trace、误触达、策略信号与陈旧状态时间差；`scripts/run-alpha-closure-eval.mjs` 同时接入 WakeIntent 候选/决策适配器、`0.3.0` 策略提取器、混合 relevance router 和强 due-gated baseline。

真实 runner 默认是 dry-run，只有显式 `--execute` 的 API 脚本才会加载 `.env`。当前计划输出 12 条合成时间线、保守请求上限 84 次；收口运行强制 0 次自动重试，并对超出冻结数量的候选或 baseline memory 立即停止，因此最多也是 84 次 HTTP 尝试。用户已经授权过一轮，但该进程在网络/会话中断后消失，旧版 runner 又只在全量结束时写报告，因此没有留下可评分结果，也无法审计中断前实际发出了多少请求；这轮不得伪装成失败或成功结果，也不得在原 84 次授权下自动重跑。

实现过程中修复了 baseline 公平性缺陷：此前在一个到期批次完成后会清空最新上下文，使更晚到期的 memory 看不到早先的全局撤销或取消信息；现在每个后续批次都会读取完整累计上下文。另补充全局授权撤销广播：`set-authorization=denied` 一旦通过证据验证，会在当前 context step 通过确定性 hard gate 立即取消所有 active intent，保留用户原话证据，不调用逐意图语义决策模型。

中断暴露的可靠性缺口已修复：runner 现在先创建 `running` 报告，在每次 HTTP 尝试前持久化请求预算与 request ID，并在每个场景完成后 checkpoint；`--resume=<report-path>` 会校验数据集、模型、API 模式与场景选择，跳过已完成场景，并为未完成场景复用确定性幂等键。即使代理不支持幂等缓存，所有恢复请求仍计入同一 84 次硬上限。

在真实收口运行前，4 个包构建和类型检查通过，共 108 项离线测试通过：core 43、schemas 9、model-openai-compatible 14、eval 42。这里证明的是数据、评分、编排、公平性和请求前记账可运行；当时 12 条真实语义结果仍待一个重新明确授权的新收口轮次。

## 16. 有限 Alpha 真实收口结果

用户重新明确授权后，冻结的 12 条合成连续时间线完成了一次真实中转 API 运行。原始报告为 `reports/alpha-closure-runs/2026-09-02T07-37-32.948Z.json`；由于原 runner 在两个 baseline 过量提取场景中中止且旧停止判定只接受 12 条全部可评分，原报告的 `stopDecision` 为 `null`。未修改任何原始场景结果的审计报告为 `reports/alpha-closure-runs/2026-09-02T07-37-32.948Z.audited.json`，修正后的冻结判定是 **REVIEW**：8/12 通过，10/12 可评分，WakeIntent 已评分场景误触达为 0。

本轮实际进行了 60 次 HTTP 尝试，没有自动重试，低于 84 次授权上限。原报告保留了 56 条完整调用记录，全部 `attempts=1`；另有 4 次成功请求的调用记录被旧错误路径丢弃。可审计的 56 次调用共 47,642 Token，其中 WakeIntent 34 次、30,995 Token，强 due-gated baseline 22 次、16,647 Token；另外 4 次的 Token 未知。所有费用字段均为 `null`，因为没有配置价格，不能解释为免费。

逐场景结果：

- 通过：明确到期联系、提前获知结果、显式取消、间接目标失效、无关上下文、免打扰提前解除、全局撤销授权、明确联系频率；
- `global-dnd-two-intents`：全局免打扰被正确提取并同时推迟两个意图，安静期内 0 误触达；周一重验证时模型把已错过的双选会询问判为 `expire`，而冻结标签要求迟到联系。baseline 同样只恢复联系一个事项。这暴露的是“免打扰结束后，错过原时间的明确联系应补发还是过期”的共享策略契约缺失，不是全局广播失效；
- `soft-consent-no-reply-silent`：WakeIntent 和 baseline 都没有在 9 月 4 日产生第三次联系，用户可见安全目标已经满足；但两者分别把最早检查排到 9 月 6 日和 9 月 10 日，冻结评分却要求 9 月 4 日必须留下 `silent/defer` 决策。因此原始失败必须保留，但该标签把“不唤醒”错误地当成“未证明沉默”；
- `expiry-hard-gate`：baseline 将一段含到期/失效条件的对话拆成 2 条 memory，超过冻结预期 1，旧 runner 直接中止，WakeIntent 已完成的候选结果没有被保存，无法评分；
- `vague-future-wish-no-active-intent`：WakeIntent 候选数量保护没有触发，说明它正确返回了 0 个候选；baseline 却把“以后有空也许学日语”提取成 1 条 memory。旧 runner 因 baseline 超量中止并丢失 Wake 结果，因此原始报告仍按 error 处理，不能事后记为通过。

这次运行支持的价值结论是：WakeIntent 能在新上下文到达时提前完成、取消或广播策略，并能在一个关键模糊愿望负例上比 memory baseline 更保守；它不是固定 heartbeat 的同义实现。运行也明确否定了“当前版本总体更省模型调用或 Token”这一说法：已保存场景中 WakeIntent 的调用和 Token 均更高。强 baseline 在已评分场景同样保持 0 误触达，因此当前可见优势主要是更早的状态治理、可解释生命周期和框架复用边界，还不是稳定的最终消息准确率或成本优势。

收口后的动作是进入有限 Alpha，而不是继续扩充可行性比较。只保留三项直接来自失败的契约修正：明确免打扰结束后的迟到联系策略；让评分器承认“尚未 eligible 所以完全不唤醒”也是正确沉默；baseline 过量提取应继续运行并作为评分失败保留，任何异常路径都必须保存已完成的模型记录。原始 8/12 REVIEW 永久保留，不通过重跑或改标签覆盖。

收口修复后的最终离线检查通过：core 43、schemas 9、model-openai-compatible 14、eval 43，共 109 项测试。
