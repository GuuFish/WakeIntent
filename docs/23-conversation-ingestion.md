# 对话接入与模型模式

> 状态：Alpha 功能切片。目标是验证真实对话可以进入 WakeIntent 生命周期，而不是在这一阶段实现完整聊天产品。

## 1. 目标

本切片把参考宿主从“调用方必须自己构造 `ContactIntent` 和语义决策”推进到以下流程：

```text
自然语言事件
  -> 持久化事件批次
  -> 针对已有活跃意图做相关性路由
  -> 从本批事件提取新的 ContactIntent
  -> 保存不可变处理计划
  -> 注册新意图并请求受影响意图提前重评
  -> 使用已保存对话执行到期重评
  -> 仅将 contact 决策写入 outbox
```

它验证的是核心与真实对话之间的接入边界。聊天回复生成、角色人格和真实通知渠道仍属于后续切片。

## 2. 为什么先保存处理计划

一次事件请求可能触发两个模型任务：候选意图提取，以及已有意图的相关性路由。如果只保存原始事件，进程在模型返回后中断，重试就会再次花费 Token，而且第二次模型结果可能变化。

参考宿主因此把事件批次分成两个状态：

- `pending`：事件已经安全保存，但核心变更可能尚未全部应用；
- `completed`：处理计划中的意图注册和路由请求已经完成。

模型产生的候选意图与相关性选择会作为 `plan` 先持久化。重试已经保存 `plan` 的 `pending` 批次时复用该计划，核心侧继续依靠稳定 ID 和幂等键恢复；重放 `completed` 批次时直接返回，不调用模型、不写新意图，也不重复安排评估。若进程恰好在模型响应返回后、完整 `plan` 原子写入前终止，当前 Alpha 仍可能在恢复时重新请求该批次；后续需要用分阶段计划或提供商侧幂等结果缓存进一步缩小这一窗口。

这解决的是单进程 Alpha 中最常见的中断窗口，但不是跨服务分布式事务。多个进程不能同时写同一组 JSON 文件。

## 3. API

### 3.1 接收对话事件

```http
POST /v1/conversations/{conversationId}/events
```

请求示例：

```json
{
  "events": [
    {
      "id": "event:study-plan",
      "conversationId": "conversation:study",
      "actor": "user",
      "occurredAt": "2026-09-04T09:00:00.000Z",
      "content": "我打算明天学完操作系统第三章，但进程同步一直没搞懂。"
    }
  ],
  "target": { "kind": "user", "id": "student:1" },
  "now": "2026-09-04T09:01:00.000Z",
  "timeZone": "Asia/Hong_Kong",
  "idempotencyKey": "turn:study:1",
  "activationThreshold": 0.8,
  "routePolicyVersion": "study-route-0.1"
}
```

返回中的 `outcome` 为：

- `created`：第一次接收，执行并保存模型计划；
- `resumed`：此前已经保存事件，继续未完成计划（事件存储内部状态名为 `resume`）；
- `duplicate`：此前已经完成，不再执行模型工作。

`modelWorkPerformed` 明确说明本次请求是否产生了新的模型处理。

### 3.2 使用持久化上下文重评

```http
POST /v1/model-evaluations
```

请求示例：

```json
{
  "now": "2026-09-05T12:00:00.000Z",
  "policyVersion": "study-decision-0.1",
  "routeClosureThreshold": 0.9,
  "userStates": {
    "user:student:1": {
      "authorization": "granted",
      "remainingContactBudget": 1
    }
  }
}
```

`userStates` 的键由 `${target.kind}:${target.id}` 组成。用户授权仍由宿主显式提供，不允许角色 Prompt 或语义模型自行推断授权。

当相关性路由已经以足够高置信度判断新事件使理由 `cancel` 或 `resolve` 时，核心可以直接关闭意图，不再调用语义重评模型。其他已到期意图会从 `events.json` 加载不晚于 `now` 的最近事件，再调用语义重评器。

## 4. Token 边界

- 没有活跃意图时，相关性路由器不会调用模型；
- 完成批次的幂等重放不会调用任何模型；
- 高置信度 `cancel` / `resolve` 路由可以避免随后的语义重评；
- 每个新事件批次当前仍会执行一次候选提取；有活跃意图且没有确定性路由器时，还可能执行一次模型相关性路由；
- 当前实现没有宣称比所有 heartbeat 更省 Token，后续需要按“每次有效联系成本”评测，而不是只看单次请求。

## 5. 当前限制与下一步

- `events.json`、`intents.json` 和 `outbox.json` 仅支持单进程、单实例写入；
- 全局授权和免打扰策略尚未从自然语言自动提取并持久化，当前由调用方显式传入；
- 尚无后台唤醒循环，宿主必须调用 `/v1/model-evaluations`；
- 尚无角色策略、消息文案生成和真实投递；
- 尚未实现面向普通用户的聊天界面。

下一切片应建立学习伙伴垂直 Demo：先加入最小唤醒循环和应用内消息生成，再将角色主动程度限制在授权、有效理由和打扰预算之下。

## 6. 可重复真实模型验证

在本地 `.env` 已配置兼容 Responses API 的模型后运行：

```bash
pnpm smoke:host-ingestion-api
```

脚本使用两条合成中文学习对话，不发送真实用户数据，并将模型 HTTP 请求上限限定为 3：

1. 用户计划第二天完成学习，并允许之后关心进度；
2. 用户当天提前说明已经完成、问题已经弄懂且不用再问；
3. 宿主执行到期评估，然后重放第二条事件。

2026-09-04 的首次 `gpt-5.5` 运行通过，报告为
[`reports/host-ingestion-smoke/2026-09-04T15-10-00.947Z.json`](../reports/host-ingestion-smoke/2026-09-04T15-10-00.947Z.json)：

- 首轮提取出一个活跃 `ContactIntent`；
- 第二轮相关性路由以 `0.99` 置信度输出 `resolve`；
- 后续评估走 `route-closure`，语义重评调用为 0，联系决策为 0，outbox 为 0；
- 幂等重放返回 `duplicate`，模型调用为 0；
- 全路径 3 次请求、2,432 Token、0 次重试；价格未配置，因此报告中的费用为 `null`，不代表免费。

这证明当前参考实现能把“理由失效后保持沉默”贯穿到真实模型、持久化、核心决策和 HTTP 宿主边界，但仍不能证明生产环境用户体验更好，或总体成本一定低于强 heartbeat。
