# WakeIntent 有效性与联系资格两阶段判断

> 状态：Implemented  
> 日期：2026-09-03  
> 范围：有效性门控、联系资格门控、上下文变化重验证和提前联系保护。

## 1. 两个不同的问题

一次唤醒需要依次回答：

1. 这个 ContactIntent 是否仍然成立？
2. 即使仍然成立，此刻是否允许联系用户？

前者由 `evaluateValidityGates()` 处理显式取消、过期、策略关闭和授权撤回等生命周期问题；后者由 `evaluateContactEligibilityGates()` 处理 not-before、免打扰、未知授权和联系预算。

原有 `evaluateHardGates()` 保留为兼容入口，内部按上述顺序组合两个阶段。

## 2. 上下文变化可以提前思考

`SemanticReevaluationInput` 现在携带 `trigger: scheduled | context-change`。当持久化的 `evaluation-requested` 到期时，引擎把触发来源标记为 context-change。

即使当前被 not-before 或免打扰挡住，只要存在新的相关事件，语义重验证仍可判断：

- 已取消、完成或自然失效：立即关闭；
- 时间发生变化：更新下一次评估时间；
- 仍然值得跟进：保留意图，但由联系资格门控决定何时再评估；
- 模型提出立即 contact：确定性门控覆盖该提案，绝不提前联系。

当语义模型和联系资格都提出 defer 时，核心选择两个时间中的较晚者，避免新的时间信息被 not-before 的较早边界覆盖。

## 3. 真实 API timing 冒烟结果

第二组真实 API 合成测试使用 `gpt-5.5`，发送：

- 初始对话：“周五准备参加双选会，结束后可能想聊聊结果”；
- 更新对话：“仍会参加，但改到周五晚上才结束，结束前不用联系”。

结果：

- 路由模型返回 `reevaluate`，confidence 0.99；
- 重启后加载一次最新上下文并执行一次语义重验证；
- 最终由 contact eligibility 输出 `defer`；
- final status 保持 active；
- `contactDecisions = 0`；
- 3 次 HTTP 请求，无重试，共 2803 Token；
- 未配置价格，因此费用为 null。

报告：`reports/core-api-smoke/2026-09-03T03-38-11.894Z-timing.json`。

## 4. 当前结论

两组真实冒烟已经分别覆盖：

- 原理由失效：提前 cancel，重启后无需第二次决策模型；
- 原理由仍成立但时机变化：提前重新思考，最终 defer 而不是 contact。

这直接验证了 WakeIntent 的核心差异：唤醒由有来源证据的联系意图和上下文变化驱动，而发送仍由独立、确定性的打扰治理约束。
