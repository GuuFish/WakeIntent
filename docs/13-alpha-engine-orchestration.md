# WakeIntent Alpha 0.1 应用服务编排

> 状态：Implemented  
> 日期：2026-09-02  
> 范围：候选激活、提取结果注册、到期重验证；不包含后台调度和真实投递。

## 1. 本切片解决的问题

第一切片已经能可靠保存意图，但调用方仍要自行拼接生命周期步骤。本切片提供最小、框架无关的应用服务，使宿主能够：

1. 幂等注册已经完成的提取结果；
2. 显式激活低置信度 candidate，并保存激活理由、证据和首个评估时间；
3. 只查询真正到期的 active intent；
4. 加载最新上下文与用户策略；
5. 先执行确定性门控，再按需执行语义重验证；
6. 把决策、状态和下一次评估时间原子提交。

## 2. 为什么激活不是一条伪造的 Decision

激活表达的是“这个候选现在值得进入持续跟进生命周期”，而 `ContactDecision` 表达的是“一个 active intent 在当前时刻应联系、推迟、取消、过期、沉默或解决”。二者语义不同。

因此新增 `ContactIntentActivation`，并将存储审计从 decision-only 扩展为 `ContactIntentAuditEvent`：

- `activated`：candidate → active；
- `decision`：active 的一次重验证结果。

revision 现在等于创建后的所有审计事件数量加一，不再错误地假设所有状态变化都是联系决策。幂等索引也由过窄的 `decisionId` 改为 `operationId`。

JSON 快照版本升级为 `0.1.1`。适配器可读取既有 `0.1.0` decision-only 快照，并在下一次成功写入时迁移；损坏或语义不一致的文件仍拒绝加载。

## 3. 为什么不提供黑盒 `ingest(events)`

模型提取存在非确定性。如果一个黑盒接口在“模型已返回、只保存了一部分结果”时中断，直接重试可能得到不同数量、顺序或 ID 的候选，造成重复或幂等冲突。

Alpha 明确拆成两步：

1. `extractContactIntents()` 生成一个确定的提取结果；
2. 调用方保存该结果和稳定的 `extractionRunId`，再用 `registerExtractedIntents()` 逐条幂等注册。

注册不是多意图数据库事务，但可恢复：相同提取结果重放时，已成功的项目返回 `duplicate`，未完成的项目继续创建。将来若需要模型调用与批量写入完全原子化，应增加 extraction-run 领域记录，而不是依赖 Prompt 稳定性。

## 4. 到期重验证语义

`evaluateDueContactIntents()` 在一个固定 `now` 快照下查询到期意图，并按排期、优先级顺序逐条处理：

1. 为 `(intentId, revision)` 生成稳定的 decision ID 和幂等键；
2. 从宿主提供的 `DueEvaluationContextProvider` 获取最新事件和用户策略；
3. 调用现有 `reevaluateContactIntent()`，先走硬门控；
4. 仅在规则不足以决定时调用语义模型；
5. 以查询到的 revision 原子提交；
6. 单个项目失败或并发冲突会记录为逐项结果，不阻断后续到期意图。

Alpha 有意使用顺序执行，避免一次唤醒并发轰炸模型、放大 Token 消耗或触发限流。后续只有在有真实吞吐数据时才增加有界并发。

## 5. 与 heartbeat 的实际差异

WakeIntent 仍需要宿主在 `nextEvaluationAt` 附近唤醒代码，但它不按固定周期把所有记忆交给模型：

- 没有到期意图时，context 加载和语义调用都是零；
- candidate 在激活前不会进入到期查询；
- 已取消、解决和过期的意图不会再次唤醒；
- 确定性过期等情况不调用语义模型；
- defer 只安排该意图自己的下一候选窗口；
- 到期后仍会结合最新上下文取消、推迟或保持沉默。

这意味着调度器只是“按最近的 `nextEvaluationAt` 唤醒引擎”的基础设施，不承担“是否值得联系”的判断。

## 6. 已验证场景

- 没有到期意图：0 次 context 调用、0 次语义调用；
- candidate 与 active 的初始排期不同；
- 相同 extraction run 重放不重复创建；
- candidate 激活跨重启恢复，激活审计保留；
- 意图到期但用户已表示“找到实习，不去双选会”：决策为 `cancel`，状态进入 `cancelled`，排期清空；
- 已超过 `expiresAt`：硬门控产生 `expire`，不调用语义模型；
- 一个意图模型失败：该项保持原 revision，后续到期意图继续处理；
- 旧版 `0.1.0` JSON 快照可迁移到 `0.1.1`。

## 7. 明确边界

- `evaluateDueContactIntents()` 不是后台 daemon，也不会自行常驻；
- `contact` 仍然只是决策，不代表消息已生成、已尝试或已送达；
- context provider 由宿主实现，core 不抓取聊天、邮箱或屏幕；
- Alpha 不保证多个进程同时处理同一个 JSON 文件；
- 当前逐项错误结果包含原始 `Error`，日志与对外 API 层必须自行脱敏；
- Persona 以后只能影响软性关注和表达，不能绕过授权、免打扰和安全门控。

## 8. 本地可运行演示

执行：

```bash
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
```

第一次运行会保存两个意图并重新打开 JSON store 模拟重启：过度迟到的低价值问候由 late policy 直接 `silent`，不加载 context、不调用模型；双选会意图根据“已经找到实习，不去双选会”的最新事件提交 `cancel`。因此两个到期意图只发生一次 context 和一次语义调用。对同一状态文件再次运行时，注册结果为 `duplicate`、到期数量为 0、语义调用为 0、审计数量不增加，证明重复启动不会因原排期再次联系。

该演示使用确定性 fake semantic model，不读取 `.env`，不访问网络，也不产生模型 Token。

## 9. 下一切片

1. 连接模型 adapter usage 与应用服务工作量统计，量化相对 heartbeat 的实际成本；
2. 在核心稳定后再设计 Persona Policy 和参考聊天壳。
