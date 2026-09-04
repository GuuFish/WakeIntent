# WakeIntent 核心事件相关性路由

> 状态：Implemented  
> 日期：2026-09-03  
> 范围：框架无关的路由端口、输出校验、路由结果绑定，以及纵向评测复用；持久化唤醒见 `docs/17-persisted-event-wakeup.md`。

## 1. 目标

新对话不应让所有 ContactIntent 都调用重验证模型。核心需要先回答一个更便宜的问题：这批事件是否可能改变某个 active intent 的有效性、时间、取消/完成状态或打扰价值？

新增 `routeConversationEvents()` 和 `RelevanceRouter` 端口。宿主可接规则、Embedding、小模型或混合路由器；core 不绑定任何模型供应商。

## 2. 核心边界

输入包括当前意图、新对话事件和统一的 `now`。core 只把 active intents 交给路由器，并返回：

- 通过校验的 selection；
- selection 对应的 ContactIntent；
- selection 实际引用的 ConversationEvent；
- 是否真的调用了路由器，以及本次输入规模。

selection 的 effect 只表达路由器认为事件可能造成的影响：`reevaluate`、`cancel` 或 `resolve`。它是后续重验证的证据/提示，不等于 ContactDecision，也不会自行改变生命周期。

## 3. 为什么把输出视为不可信

模型结构化输出仍可能语义或引用错误，因此 core 会拒绝：

- 不存在或非 active 的 intent ID；
- 不属于本批输入的 event ID；
- 同一 intent 的重复 selection；
- selection 内重复 event ID 或无证据；
- 空理由、越界置信度和未知 effect；
- 晚于路由时间的未来事件；
- 输入侧重复 intent/event ID。

传给 adapter 的对象和返回给宿主的绑定结果均为副本，adapter 不能意外篡改调用方持有的领域对象。

## 4. 成本语义

没有 active intent 或没有新事件时，core 直接返回空结果，不调用 router。该行为使“平时保持沉默”可以从管线最前端就减少无意义计算，而不是等到重验证阶段才节流。

原本只存在于 `@wakeintent/eval` 的纵向评测已改为调用 core 路由契约，因此评测与未来实际宿主不会各自维护一套不同的输入/输出校验。

## 5. 当前限制与下一步

本切片故意没有让路由结果直接修改 store。原因是“事件影响了意图”与“领域决策已经发生”是不同事实，不能借用 defer/contact 决策伪造一次唤醒。

下一步应增加独立、可审计、幂等的 evaluation-request 操作：它把相关事件及 route effect 写入审计，并将 `nextEvaluationAt` 提前到当前时间；之后继续复用现有 due evaluation、失败退避和共享预算。该操作完成后，宿主才能在进程重启后可靠恢复一次由新上下文触发的提前重验证。

随后再把 router 调用、semantic 调用和 adapter 内部重试的 usage 合并为一次应用级 trace，准确比较事件驱动方案与 heartbeat 的调用数、Token 和费用。
