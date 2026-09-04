# WakeIntent 对话事件驱动的持久化唤醒

> 状态：Implemented  
> 日期：2026-09-03  
> 范围：路由、评估请求、重启恢复与高置信度关闭闭环；不包含消息投递。

## 1. 完成的核心链路

当前核心链路已经能够表达：

1. 正常对话产生 active ContactIntent；
2. 后续新对话经过 `RelevanceRouter`，只选择可能受影响的意图；
3. `requestRelevantEvaluations()` 将选择结果写成 `evaluation-requested` 审计事件；
4. 该事件原子推进 revision 并把 `nextEvaluationAt` 拉近；
5. 即使进程此时重启，JSON store 仍能恢复唤醒原因和排期；
6. `evaluateDueContactIntents()` 处理请求并提交 cancel、resolve 或正常重验证结果。

这使“用户后来已经解决了事情”不再依赖下一次固定 heartbeat 恰好重新读到旧对话。

## 2. `notBefore` 的语义修正

本切片明确区分：

- `notBefore`：最早允许 contact 的时间；
- `nextEvaluationAt`：下一次允许系统重新判断意图的时间。

新事件可以在 `notBefore` 之前触发重新判断或取消。否则 Day 3 的“我已经找到实习了”会被 Day 4 的联系窗口挡住，系统只能机械保留已经失效的意图。

这个修正不会允许提前联系：contact 仍然必须经过 not-before、授权、免打扰、预算、过期和其他硬门控。

## 3. 高置信度关闭

当最新 `evaluation-requested` 的 effect 为 cancel 或 resolve，且 confidence 达到 `routeClosureThreshold`（默认 0.9）时，引擎直接生成可审计的 `route-closure` 决策：

- 引用原始 ContactIntent 证据和导致关闭的新事件；
- 保留路由理由、请求 ID 和策略版本；
- 不再次加载上下文，也不再调用第二个语义模型；
- 仍通过 revision 和幂等提交进入正式生命周期。

低置信度请求不会直接关闭，仍进入正常重验证流程。阈值可由宿主配置。

## 4. 调度与幂等

同一 `routeRunId + intentId` 的请求可重复执行而不增加 revision。请求只能把评估拉近：如果意图本来已经更早到期，存储保留更早时间，不会被后到的新事件推迟。

新的路由请求也会结束上一轮“连续失败”序列，因此一个真实的新上下文能够重新唤醒此前因多次故障而停止自动重试的 active intent。

JSON 快照版本升级为 `0.1.3`，可读取 `0.1.0`、`0.1.1` 和 `0.1.2`，下一次成功写入时统一升级。

## 5. 已验证场景

- Day 1 保存“双选会”跟进，Day 3 收到“已找到实习，不去了”；
- Day 3 在 Day 4 的 notBefore 之前立即创建评估请求；
- 请求写盘后重启进程；
- 重启后的引擎不调用第二次模型，直接 cancel；
- 重复 route run 不产生重复请求；
- 路由不能虚构 intent ID 或 event ID；
- 新请求不会推迟已经更早到期的评估。

## 6. 剩余边界

- “语义有效性重验证”和“是否允许 contact”已经在后续切片拆成显式两阶段管线，见 `docs/18-validity-and-contact-eligibility.md`；
- 路由事件内容仍由宿主的对话存储提供，WakeIntent 只持久化 event ID 和路由证据；
- 多进程 lease、真实 delivery receipt 和跨批次联系预算尚未实现；
- 应用服务工作量与模型 Token/费用仍需统一 trace。

## 7. 真实 API 冒烟结果

2026-09-03 使用项目已配置的 OpenAI-compatible Responses 中转接口和 `gpt-5.5` 运行两次无重试请求：

1. 从合成对话“周五准备参加双选会，结束后可能想聊聊结果”提取 active ContactIntent；
2. 将“已经找到实习，不去双选会了，这件事不用再问我”路由到该意图。

路由返回 `effect = cancel`、`confidence = 0.99`。评估请求写入 JSON 后重新打开 store，引擎以 `route-closure` 提交 cancel；额外 context load 为 0，额外 semantic call 为 0，最终状态为 cancelled。

本次共 2 个 HTTP attempt、1532 Token（输入 967、输出 565）。费用为 null，因为未配置该中转模型的单价。结果证明这条具体工程链路能够工作，但单次合成冒烟不代表普遍准确率。

原始报告：`reports/core-api-smoke/2026-09-03T03-11-27.232Z.json`。
