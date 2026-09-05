# Reference Host HTTP API

> 状态：Alpha 集成示例。它是本地开发者宿主，不是托管服务或面向普通用户的应用。

`apps/reference-host` 把 WakeIntent 的进程内接口变成一个小型、可持久化的 HTTP 边界。它用于证明另一个应用可以注册结构化 `ContactIntent`、结合最新上下文执行决策、查询生命周期状态、从 outbox 消费 `contact` 决策并回传投递进度，同时不会把“决定联系”误当成“已经送达”。

## 1. 这一切片验证什么

宿主管理三个 JSON 文件：

- `intents.json`：核心意图状态、决策、失败和审计事件；
- `outbox.json`：只由已提交的 `contact` 决策产生的消息任务，以及投递回执；
- `events.json`：自然语言对话事件、幂等批次和已保存的处理计划。

每次打开存储时，宿主都会把所有已提交的 `contact` 决策与 outbox 对账。outbox 使用 `decisionId` 作为幂等身份。如果进程恰好在核心决策提交后、outbox 写入前停止，重新打开宿主会补回缺失项；重复对账不会再创建一份。

这不是分布式事务，而是“至少一次交接 + 本地幂等投影”的可恢复实现，适用于当前单进程 Alpha 边界。

## 2. 本地启动

环境要求与仓库一致：Node.js 22.14 或更高版本，以及 pnpm 11.19。

```bash
pnpm install --frozen-lockfile
pnpm host:start
```

默认配置：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `WAKEINTENT_HOST_BIND` | `127.0.0.1` | 本地监听地址 |
| `WAKEINTENT_HOST_PORT` | `8787` | HTTP 端口 |
| `WAKEINTENT_HOST_DIR` | `.wakeintent/reference-host-api` | 持久化 JSON 目录 |

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

## 3. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 进程健康状态与 API 版本 |
| `GET` | `/v1/state` | 同时读取意图和 outbox 快照 |
| `GET` | `/v1/intents` | 列出已保存意图 |
| `GET` | `/v1/intents/:id` | 读取单个意图 |
| `POST` | `/v1/intents` | 注册一个已经结构化的意图 |
| `POST` | `/v1/evaluations` | 使用传入的最新上下文评估 `now` 时刻已到期的意图 |
| `POST` | `/v1/model-evaluations` | 使用已持久化对话与已配置模型重评到期意图 |
| `GET` | `/v1/conversations/:id/events` | 列出一个对话的已持久化事件 |
| `POST` | `/v1/conversations/:id/events` | 持久化自然语言事件并执行提取与相关性路由 |
| `GET` | `/v1/outbox` | 列出消息任务及其回执 |
| `POST` | `/v1/outbox/:id/receipts` | 推进一个消息任务的投递状态 |
| `GET` | `/v1/messages` | 读取参考 host 已生成的本地主动消息 |

超过 1 MiB 的请求会被拒绝。注册与回执都支持幂等重放：相同 key 或回执再次提交时返回已有结果；复用同一身份却传入不同数据时返回冲突。

## 4. 最小流程

先注册一个活跃意图。`nextEvaluationAt` 是引擎的唤醒时间，不是承诺发送消息的时间：

```json
{
  "intent": {
    "schemaVersion": "0.1.0",
    "id": "intent:interview-result",
    "status": "active",
    "subject": "Interview result follow-up",
    "reason": "The user expects an interview result this week.",
    "target": { "kind": "user", "id": "user:1" },
    "evidence": [{ "eventId": "event:interview", "quote": "I should hear back Friday." }],
    "notBefore": "2026-09-04T09:00:00.000Z",
    "expiresAt": "2026-09-11T09:00:00.000Z",
    "cancellationHints": ["The user already received the result"],
    "priority": 0.8,
    "interruptionCost": 0.3,
    "confidence": 0.94,
    "createdAt": "2026-09-01T09:00:00.000Z",
    "updatedAt": "2026-09-01T09:00:00.000Z"
  },
  "nextEvaluationAt": "2026-09-04T09:00:00.000Z",
  "idempotencyKey": "create:interview-result:1"
}
```

到达唤醒时间后，可以调用 `/v1/evaluations`，传入最新上下文与结构化语义建议。这条接口属于不调用模型的结构化宿主模式。启用模型模式后，也可以通过 `/v1/conversations/:id/events` 保存自然语言对话，再调用 `/v1/model-evaluations` 让宿主从持久化上下文完成重评。

```json
{
  "now": "2026-09-04T10:00:00.000Z",
  "policyVersion": "reference-host-api-0.1",
  "contexts": {
    "intent:interview-result": {
      "latestEvents": [],
      "userState": { "authorization": "granted", "remainingContactBudget": 1 },
      "semanticProposal": {
        "action": "contact",
        "reason": "The result window is open and the reason remains current.",
        "evidenceRefs": ["event:interview"],
        "counterEvidenceRefs": [],
        "confidence": 0.9,
        "nextEvaluationAt": null
      }
    }
  }
}
```

如果确定性门控或最新上下文产生 `defer`、`silent`、`cancel`、`resolve` 或 `expire`，系统不会创建 outbox 项。只有已提交的 `contact` 会进入 `awaiting-generation`。

投递所有者随后按顺序写入回执：

```json
{ "id": "receipt:1", "recordedAt": "2026-09-04T10:00:01.000Z", "status": "generated" }
```

```json
{ "id": "receipt:2", "recordedAt": "2026-09-04T10:00:02.000Z", "status": "attempted", "providerMessageId": "message:42" }
```

```json
{ "id": "receipt:3", "recordedAt": "2026-09-04T10:00:03.000Z", "status": "delivered", "providerMessageId": "message:42" }
```

允许的状态流转为：

```text
awaiting-generation -> generated -> attempted -> delivered
        |                 |            |
        +---------------> failed <-----+
                              |
                              +-------> attempted
```

`delivered` 是终态，回执时间必须单调递增。宿主可以在失败后记录一个更晚的 `attempted` 进行重试。

## 5. 可选自然语言模式

将 `.env.example` 复制为 `.env`，填写模型配置，然后运行：

```bash
pnpm host:start:model
```

该模式的事件批次使用幂等键持久化。模型提取结果和相关性选择会先保存为处理计划，再注册意图和请求提前重评；因此完成后的重放不会再次花费 Token，中断后的重试也会优先复用计划。请求和恢复契约详见 [`23-conversation-ingestion.md`](23-conversation-ingestion.md)。

## 6. 刻意保留的边界

- 没有完整聊天回复接口；当前自然语言入口只处理联系意图生命周期；
- 默认 HTTP 模式不调用模型；模型模式必须显式启用并自行承担费用；
- 模型模式下参考 host 已提供最小后台唤醒循环和本地消息生成；默认 HTTP 模式仍不启动模型循环；
- 尚无通知服务商或真实投递；本地消息写入不等于用户收到消息；
- 尚无身份认证、TLS、公网加固或多租户隔离；
- JSON 存储只支持单进程、单实例写入。

不要把这个 Alpha 服务暴露到公网。当前参考 host 的模型模式已经加入最小唤醒循环和本地消息生成；没有真实策略提供器时默认使用 `authorization: unknown` 并保持静默。后续能力仍必须保持现有的“决策、outbox、本地消息、回执”分离。
