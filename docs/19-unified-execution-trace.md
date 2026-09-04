# WakeIntent 统一执行 Trace

> 状态：Implemented  
> 日期：2026-09-03  
> 范围：运行级 trace 结构、模型用量汇总、错误脱敏和 API 冒烟接入；不包含 trace 数据库或可视化界面。

## 1. 要回答的问题

一次主动联系决策必须能回答：

- 为什么这次系统会醒来；
- 哪些事件被路由到了哪些 ContactIntent；
- 唤醒请求是否真正持久化；
- 哪个阶段调用了模型、是否重试、消耗多少 Token；
- 最终是 contact、defer、cancel、resolve、silent，还是发生失败；
- 为什么没有联系。

`buildEvaluationRunTrace()` 将这些信息组合为框架无关的 `EvaluationRunTrace`。

## 2. Trace 内容

当前 `0.1.0` trace 包含：

- trace ID、开始/结束时间、持续时间和触发类型；
- 路由器是否调用、active intent 数、事件数、selection 和 evaluation-request ID；
- due evaluation 的工作量统计和每个意图的结果；
- 模型 schema、phase、reasoning effort、request ID、HTTP attempts、Token 和费用；
- usage/cost 是否完整，未知数据保持 null，不当作 0；
- 可选的宿主 metadata。

失败只输出 Error name 和持久化退避结果，不复制原始异常 message，避免把上游响应或敏感内容写入长期 trace。

## 3. 供应商无关

core 定义的是结构兼容的 `ModelCallTelemetryRecord`，不依赖 OpenAI-compatible adapter。任何模型适配器只要提供相同字段即可参与汇总。

`summarizeModelUsage()` 对负数 Token、无效 attempts、负费用和空 request ID 做确定性校验。只要任一调用缺失 Token 或费用，对应总值就保持 null，并标记 complete=false。

## 4. 当前接入

`scripts/run-core-event-wakeup-smoke.mjs` 已接入统一 trace。后续正式 runner 可以直接复用同一 builder，而无需重新实现一套统计逻辑。

当前没有实现 trace 持久化端口、查询索引或 UI；报告文件只是参考宿主如何保存 trace 的示例。
