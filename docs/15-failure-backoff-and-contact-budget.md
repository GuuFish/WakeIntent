# WakeIntent 失败退避与共享联系预算

> 状态：Implemented  
> 日期：2026-09-02  
> 范围：评估失败的持久化退避、批次内共享联系预算、JSON 快照 `0.1.2`；不包含真实投递和跨进程配额。

## 1. 为什么这是核心能力

主动联系系统不仅要在语义上判断“该不该联系”，还必须在故障和多个意图竞争时保持克制。否则一次模型故障会让已到期意图立刻再次被唤醒，形成请求与 Token 消耗循环；同一用户的多个意图同时到期时，也可能各自都判断为 contact，造成连续打扰。

本阶段增加两个框架无关的确定性边界：

- 失败退避回答“这次没有得到可信决策，何时再试，以及何时停止自动重试”；
- 共享联系预算回答“多个独立意图都想联系同一目标时，本轮最多允许几个 contact 决策”。

## 2. 失败是审计事件，不是语义决策

新增 `ContactIntentEvaluationFailure` 与 `evaluation-failed` 审计事件。它记录：

- 失败发生时间与阶段：context、semantic 或 evaluation；
- 经过清洗的错误类别，不保存原始错误消息；
- 连续失败次数、是否耗尽、下一次评估时间；
- 当时使用的策略版本。

失败事件会原子推进存储 revision 并更新 `nextEvaluationAt`，但不会改变 ContactIntent 的 status、subject、reason 或 `updatedAt`。这使“领域状态发生变化”和“本次计算没有成功”不会混为一谈。

默认退避策略从 1 分钟开始，按 2 倍增长，单次最多 1 小时，连续 5 次后停止自动排期。宿主可以显式传入其他策略，也可以用 `false` 关闭自动记录。耗尽后意图仍为 active，但 `nextEvaluationAt = null`，计划器会返回 idle；未来可由相关新事件或人工操作重新激活评估，而不是无限重试。

评估循环只为 context、semantic 或决策计算阶段的失败记录退避。提交阶段失败不会再追加失败事件，因为此时存储本身可能不可用，或另一个执行者已经推进 revision；强行写入会掩盖真实的持久化/并发问题。

## 3. 共享联系预算

`SharedContactBudgetPolicy` 在单次 `evaluateDueContactIntents()` 调用内按 `target.kind + target.id` 共享配额。当前支持：

- `maxContactDecisionsPerTarget`：同一目标最多保留的 contact 决策数；
- `onExhausted: silent | defer`：超额意图保持沉默或延后；
- defer 延迟和产品自定义解释。

语义模型仍然可以独立提出 contact，但批次策略会在提交前将超额 contact 改写为确定性的 silent/defer，并在 metadata 中保留原始动作与理由。只有成功提交或确认幂等重复的 contact 才消耗本轮配额。

这不是投递频控的替代品。它解决的是“同一批到期意图竞争”这一最靠近决策层的问题；跨进程、跨批次、按天/周统计的真实触达配额仍应由持久化策略状态或投递系统治理。

## 4. 可观察性

`EvaluationWorkStats` 新增：

- batch policy 决策、实际 contact 决策、预算抑制数量；
- 已记录失败、已安排重试、已耗尽重试；
- 失败记录自身的 revision 冲突和持久化失败。

这些计数可区分“模型判断失败”“退避已生效”“预算主动保持沉默”和“存储故障”，为后续比较 heartbeat 的空转成本提供可解释数据。

## 5. 存储兼容性与不变量

JSON 快照升级为 `0.1.2`，仍可读取 `0.1.0` decision-only 与 `0.1.1` audit-event 快照，并在下一次成功写入时升级。

已验证的不变量：

- exact replay 不会重复增加 failure attempt 或 revision；
- failure attempt 必须连续，retry 时间必须晚于 failedAt；
- exhausted 与 `nextEvaluationAt = null` 必须一致；
- 重启后 retry 排期、审计和幂等记录仍然成立；
- 原始异常消息不会进入快照；
- 失败事件不会伪装成 ContactDecision，也不会改变 `intent.updatedAt`；
- 同一目标两个 contact 提案在配额为 1 时只提交一个 contact。

## 6. 尚未实现

- 跨批次、跨进程和跨渠道的持久化联系预算；
- 失败耗尽后的 dead-letter/人工恢复接口；
- 按错误类别区分可重试与不可重试失败；
- 多进程 lease 与投递 receipt；
- 将应用服务工作量与模型 adapter 的 Token/费用统一成一次 trace。

事件相关性路由的核心契约已在后续切片实现，见 `docs/16-core-relevance-routing.md`。下一阶段优先级应是路由结果的持久化唤醒操作与应用级 usage trace，而不是继续扩展客户端外壳。
