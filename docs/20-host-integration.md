# 宿主集成与投递边界

> 状态：Alpha 0.1 参考指南
> 范围：说明现阶段如何嵌入核心引擎，以及哪些职责必须由宿主应用承担。

## 1. 当前可以怎样集成

WakeIntent 的包尚未发布到 npm，也不承诺稳定的跨版本 API。当前受支持的开发方式是在本仓库的 pnpm workspace 内增加一个宿主包，并使用 workspace 依赖：

```json
{
  "dependencies": {
    "@wakeintent/core": "workspace:*",
    "@wakeintent/store-json": "workspace:*",
    "@wakeintent/model-openai-compatible": "workspace:*"
  }
}
```

独立仓库暂时不应把 `dist` 目录复制出去，也不应把 GitHub 源码地址当成稳定的 npm 依赖。等公共 API 冻结后，项目会单独设计可发布包、版本兼容规则和迁移说明。

## 2. 最小调用流程

可运行参考见 [`examples/minimal.mjs`](../examples/minimal.mjs)。它展示了三个步骤：

1. 调用 `extractContactIntents()`，从正常对话中生成候选或活跃意图；
2. 保存意图；到期或相关事件出现时，为它加载最新对话和用户策略；
3. 调用 `reevaluateContactIntent()` 或批量编排接口 `evaluateDueContactIntents()`，再根据决策分支处理。

宿主处理决策时应显式区分：

```js
switch (result.decision.action) {
  case "contact":
    // WakeIntent 只批准联系。宿主在这里生成消息、再次执行渠道策略、
    // 使用幂等投递键发送，并保存 delivery receipt。
    break;
  case "defer":
    // 保存 nextEvaluationAt，等待下一次最小时间唤醒。
    break;
  case "silent":
    // 本次不联系。nextEvaluationAt=null 时不创建新的定时唤醒。
    break;
  case "cancel":
  case "resolve":
  case "expire":
    // 终止状态已经由领域生命周期更新，不再安排未来评估。
    break;
}
```

上面的投递代码是边界说明，不是当前已经实现的投递模块。

## 3. `silent` 为什么仍可能是 `active`

决策、意图状态和排期投影是三层不同信息：

- `silent` 表示本次评估不应联系；
- `active` 表示联系理由没有被正式解决、取消或判定过期；
- `nextEvaluationAt=null` 表示当前没有待执行的时间唤醒。

因此 `silent + active + null` 表示“休眠但非终止”。旧排期不会再次触发它；后续相关对话可以通过 relevance routing 创建新的评估请求，宿主也可以显式请求重新评估。如果产品希望“静默即永久结束”，应使用明确的 `cancel`、`resolve` 或 `expire` 语义，不能在宿主层私自把 `silent` 当作终态。

## 4. 宿主必须提供什么

- 对话事件入口和稳定的事件 ID；
- 最新上下文与用户授权、免打扰和预算状态；
- 调用 `planNextWakeup()` 后实际安排唤醒的基础设施；
- 消息生成、渠道选择、投递、失败处理和回执；
- 对外日志脱敏与用户可见的控制入口；
- 多进程场景下的事务型存储适配器。Alpha JSON store 只保证单进程、单实例写入。

## 5. `contact` 不等于送达

当前引擎只记录“是否应该联系”的决策。以下状态不能混为一谈：

1. 已评估并得到 `contact`；
2. 已生成消息；
3. 已尝试投递；
4. 渠道接受消息；
5. 用户实际收到消息。

生产接入前仍需独立的幂等投递和 receipt 契约。在该契约实现前，WakeIntent 应被描述为 contact-decision engine，而不是完整的 proactive messaging service。
