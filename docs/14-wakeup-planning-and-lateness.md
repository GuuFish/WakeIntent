# WakeIntent 唤醒计划与迟到策略

> 状态：Implemented  
> 日期：2026-09-02  
> 范围：最近唤醒时间计算、迟到门控、工作量统计；不实现后台常驻进程。

## 1. 设计目标

WakeIntent 不应靠固定 heartbeat 周期扫描全部记忆。宿主只需要询问“最近一个已激活意图何时值得重新判断”，并将该时间交给自己的任务系统、移动端后台能力或 Agent runtime。

`planNextWakeup()` 返回三种状态：

- `idle`：没有已排期的 active intent，宿主不需要安排唤醒；
- `scheduled`：返回最近的 `nextEvaluationAt` 和等待时长；
- `ready`：最近时间已经到达或错过，宿主应立即调用 `evaluateDueContactIntents()`。

计划器不创建 timer、不常驻、不调用模型，也不发送消息。它只读取存储投影，因此可以接入不同宿主而不绑定 cron、队列或操作系统 API。

## 2. 为什么必须定义迟到行为

移动设备休眠、进程退出、限流和机器故障都可能使宿主晚于 `nextEvaluationAt` 唤醒。如果不定义策略，系统可能在事情已经过去很久后机械补发，产生比漏发更差的体验。

`LateWakePolicy` 包含：

- `maxLatenessMs`：仍可正常重验证的最大迟到时间；
- `onTooLate`：超过容忍度后的动作；
- 可选 `reason`：产品自己的可解释理由。

支持动作：

| 动作 | 语义 | 状态结果 | Context/语义调用 |
| --- | --- | --- | --- |
| `evaluate` | 即使很晚仍结合最新上下文判断 | 由正常重验证决定 | 正常发生 |
| `silent` | 这次过时窗口不值得打扰 | 保持 active，但清空当前时间排期 | 0 / 0 |
| `expire` | 过时后此意图不再有价值 | 进入 expired | 0 / 0 |

边界采用严格大于：`latenessMs > maxLatenessMs` 才算“过度迟到”。恰好位于边界时仍正常重验证。

## 3. 决策优先级

迟到策略不能掩盖意图自己的真实过期边界：

1. 如果已经超过 `expiresAt`，继续进入硬门控并产生 `expire`；
2. 尚未真实过期但超过迟到容忍度，才应用 late policy；
3. 未超过容忍度，加载最新上下文并执行正常重验证。

迟到产生的 `silent` / `expire` 是确定性 Decision，包含 lateness、阈值、策略版本和来源 metadata，并与状态、排期原子提交。

`silent` 不等于永久取消：它停止基于当前时间窗口的再次唤醒；未来若宿主的相关事件路由发现新的强相关上下文，仍可显式重新评估该 active intent。需要永久结束时应使用 `cancel`、`resolve` 或 `expire`。

## 4. 成本与可观察性

每次 `evaluateDueContactIntents()` 返回 `EvaluationWorkStats`：

- 到期意图数量；
- context 加载次数；
- semantic adapter 调用次数；
- hard-gate、semantic、late-policy 各自决策数；
- committed、duplicate、conflict、failure 数量。

这些是工作量计数，不等同于 HTTP 请求数或 Token。模型适配器内部的重试与 Token 仍由 adapter usage 记录；两层统计以后可以组合，从而回答“WakeIntent 相比 heartbeat 到底少唤醒、少调用了多少”。

## 5. 已验证不变量

- candidate 和 active-but-unscheduled 不会产生宿主唤醒；
- 多个排期只返回最近一个；
- 已错过的时间返回 `ready` 与准确 overdue；
- 过度迟到 `silent` / `expire` 不加载 context、不调用语义模型；
- 超过真实 `expiresAt` 时 hard-gate expire 优先；
- 每次确定性迟到决策仍遵守 revision、幂等和审计规则。

## 6. 尚未实现

- 真实 timer、cron、队列或移动端后台任务适配器；
- 多进程抢占和 lease；
- 进程运行期间自动重新注册下一唤醒；
- Persona 驱动的不同迟到容忍度；
- HTTP 请求、Token 与费用的统一应用服务账本。
