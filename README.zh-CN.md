# WakeIntent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/GuuFish/WakeIntent/actions/workflows/ci.yml/badge.svg)](https://github.com/GuuFish/WakeIntent/actions/workflows/ci.yml)

> **这是研究仓库，不是开箱即用的应用。** 本仓库保留 WakeIntent 已完成实验的可运行实现、冻结数据集、审计结果和失败案例；它不会直接启动聊天界面、常驻 AI 助手或自动发送通知。

WakeIntent 是一个面向对话式 AI、与具体框架无关的联系意图引擎。它把对话中“未来值得再次联系用户的理由”转化为可持久化的 `ContactIntent`，并在真正联系前结合最新上下文重新验证，最终决定联系、推迟、取消、过期、标记为已解决或保持沉默。

> **当前状态：实验已经收口，暂停作为独立产品继续开发。**
> WakeIntent 仍保留为可运行的研究记录和实验性实现。与强 Memory +
> Proactive Agent 的冻结对照没有显示出足以抵消额外复杂度与 Token 成本的行为收益。

## 研究状态

WakeIntent 当前作为实验研究仓库保留。已经完成的两次对照实验都在检验：与强 Memory + Proactive Agent Baseline 相比，显式连续性机制能否带来稳定、用户可见的额外价值。

| 实验 | 审计结果 | 当前决定 |
| --- | --- | --- |
| 显式 ContactIntent 连续性 | 没有降低误触达，漏跟进更多，Token 多 42.2% | 暂停作为独立产品开发 |
| 用户离开期间的自主经历 | 20/60 出现行为差异，但只有 1/60 通过完整因果与反事实链 | 不作为产品方向继续 |

WakeIntent 验证的是一个很窄的问题：把未来联系理由保存成显式、可持久化、具有生命周期的对象，是否会比保存一条未来跟进 memory、再由同一个模型在未来重新判断产生更好的行为？

冻结实验包含 20 个合成连续时间场景，两套系统在相同模型、对话事实、时间和用户状态下各运行三轮。双方无理由误触达都是 0；WakeIntent 在 21 次应联系机会中漏掉 3 次，强 Baseline 漏掉 1 次；WakeIntent 多消耗 42.2% Token，多进行 17.8% 模型调用，累计延迟高 31.7%。关键“忙碌后恢复”Demo 三轮中双方都得到相同的 `defer -> contact`。

这个结果不能证明显式意图状态在所有系统中都没有用。它证明的是：当前实现没有把生命周期结构、更早的状态清理和审计能力转化成更好的用户可见行为。因此项目现在停止作为独立产品扩张，保留代码、数据集、失败案例和报告，作为一次诚实的工程实验，或供其他主动 Agent 作为内部组件参考。

详见[正式实验报告](reports/intent-continuity-value/2026-09-05T11-50-41.477Z/experiment-report.md)和[冻结实验协议](docs/25-intent-continuity-value-experiment.md)。
后续“自主经历”实验进一步检验：用户离开期间实际执行一次有限活动，能否产生强 Baseline 在回来时无法重建的有价值行为。另一个 20 场景 × 3 轮实验中，20/60 的行为不同，但只有 1/60 通过完整因果与反事实链，没有任何正向场景稳定复现，Autonomous 产品路径还多用了 91.9% Token。最终为 **B_DIFFERENT_NOT_VALUABLE**，因此项目不把自主经历作为产品发展方向。详见[最终结果](docs/28-autonomous-experience-result.md)和[审计后的机器可读报告](reports/autonomous-experience/2026-09-05T17-43-19.137Z/results.audited.json)。

## 为什么要做 WakeIntent

固定 heartbeat 可以定期询问模型是否需要联系用户，但即使没有具体理由，它仍然会不断唤醒。普通提醒知道何时触发，却通常不知道提醒的理由是否已经失效。

WakeIntent 把这些职责拆开：

1. 正常对话可以产生一个未来联系理由；
2. 系统保存理由、来源证据、时间窗口、取消线索、优先级、打扰成本和生命周期状态；
3. 新对话到来时，只唤醒与其相关的联系意图；
4. 真正评估时，先经过确定性安全门控，再结合最新上下文决定是否联系。

调度器在这里故意保持简单：它只负责在最近的 `nextEvaluationAt` 唤醒引擎，不负责判断一条主动消息是否值得存在。

## 示例场景

```text
1. 结果提前出现

第 1 天  用户：“公司说周五前会通知面试结果。”
         -> 创建一个在结果窗口后关心用户的联系意图

第 3 天  用户：“我拿到 offer 了，之后不用再问这件事啦。”
         -> 立即将该意图标记为已解决，并清除未来唤醒

周五     -> 不再重复询问
```

```text
2. 理由仍然存在，但时间发生变化

第 1 天  用户：“我周六上午考驾照。”
         -> 创建一个考试结束后可能值得关心的意图

第 2 天  用户：“改到下周二了，在那之前先别问我。”
         -> 保留联系理由，但推迟评估时间

周六     -> 保持沉默
下周二   -> 联系前仍需结合最新上下文重新验证
```

```text
3. 原来的联系理由已经失效

第 1 天  用户：“我下个月可能要搬去上海。”
         -> 创建一个稍后了解决定的低优先级意图

第 8 天  用户：“搬家的计划取消了，我会继续留在这里。”
         -> 取消意图并删除排期

下个月   -> 不再机械询问搬家的事
```

```text
4. 对话中根本没有未来联系理由

用户：“今天午饭挺好吃的。”
      -> 不创建 ContactIntent、不安排唤醒，也不产生未来 Token 消耗
```

关键能力并不只是“主动发送消息”，而是让一个明确的联系理由跨时间存在，在情况变化时修正它，并在联系已经没有意义时什么也不做。

## 目前已经实现

- 与框架无关的 TypeScript 领域模型和生命周期；
- 候选意图提取与基于最新上下文的语义重验证；
- 分离的有效性门控与联系资格门控；
- 由新对话事件触发的相关性路由；
- 授权、免打扰、过期、迟到唤醒和联系预算策略；
- 幂等决策、乐观版本控制、失败退避和审计事件；
- 支持快照迁移和重启恢复的本地 JSON 存储；
- 支持持久化对话接入、可选模型处理、outbox 和投递回执的本地 HTTP 参考宿主；
- 兼容 OpenAI Responses API 和 Chat Completions API 的模型适配器；
- 确定性测试时钟、评测数据集、对照基线和 Token 遥测。

## 快速开始

环境要求：Node.js 22.14 或更高版本，以及 pnpm 11.19。

首先检查工具版本：

```bash
node --version
pnpm --version
```

如果系统找不到 `pnpm`，请安装仓库固定的版本并再次确认。下面的命令可用于 PowerShell、命令提示符和常见 Unix Shell：

```bash
npm install --global pnpm@11.19.0
pnpm --version
```

然后安装依赖并检查整个仓库：

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 会构建并类型检查所有工作区包和应用，然后运行全部测试。最终实验分支通过 209 项自动测试。

接着使用同一个状态文件连续运行两次本地 Alpha 演示：

```bash
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
```

Alpha 演示完全在本地运行。它使用确定性的模拟语义模型，保存状态、模拟进程重启，并展示理由失效后的取消决策和迟到低价值联系的沉默决策。它不需要 API Key，也不会消耗模型 Token。

第一次运行应看到两个 `created`、`dueCount: 2`、一个 `cancel`、一个 `silent`，以及 `contactDecisions: 0`。第二次运行应看到两个 `duplicate`、`dueCount: 0`、`semanticModelCalls: 0`、没有新决策，并且审计数量保持不变。

### 决策、生命周期和排期不是一回事

演示中的迟到低价值意图会故意以 `action: "silent"`、`status: "active"`、`nextEvaluationAt: null` 结束：

- `silent` 是本次评估的结果，表示现在不联系；
- `active` 表示该理由尚未被标记为已解决、取消或过期；
- `nextEvaluationAt: null` 表示当前没有等待执行的定时唤醒。

这是一个休眠但尚未终止的意图。它不会因为旧排期再次唤醒，但后续相关对话事件或宿主的显式请求仍可重新安排评估。会终止生命周期的动作是 `cancel`、`resolve` 和 `expire`。

`contact` 同样只是一项决策。在这个流程中，WakeIntent 不会生成或发送消息；消息生成、实际投递、投递回执和面向用户的错误处理都由宿主应用负责。

## 可运行的参考宿主

离线参考宿主演示了产品如何消费 WakeIntent 的决策：

```bash
pnpm demo:host
```

它会运行三个合成招聘跟进场景：理由仍然有效、结果已在联系前解决、用户授权状态未知。只有理由有效且已经授权的联系决策会进入宿主 outbox；另外两项不会产生消息工作。outbox 项会明确显示 `delivered: false`，因为消息生成和投递仍是宿主职责。该演示不调用 API，也不包含真实用户数据。

如果要使用可持久化的本地 HTTP 集成边界，可以启动 Alpha 参考宿主：

```bash
pnpm host:start
```

它默认监听 `127.0.0.1:8787`，提供结构化意图、重评、状态、outbox 和投递回执接口。默认模式不调用模型；这一层的目的，是让核心与宿主之间的契约真正可运行，并能恢复“`contact` 决策已经提交、outbox 尚未写入”这一崩溃窗口。

如需主动启用自然语言事件接入和已配置模型：

```bash
Copy-Item .env.example .env
pnpm host:start:model
```

该模式可以持久化对话事件、提取新意图、把相关更新路由到已有意图，并利用已保存的上下文重评到期任务。已经完成的幂等事件重放不会再次调用模型；中途退出的批次会复用已经保存的处理计划。宿主依然不会生成或真实发送消息。详见[参考宿主 HTTP API 指南](docs/22-reference-host-api.md)和[对话接入设计](docs/23-conversation-ingestion.md)。

## 使用真实模型

本节需要主动选择执行，并会消耗 Token。`pnpm demo:api` 最多发出两次模型请求：第一次提取候选意图；如果得到活跃意图，第二次结合最新上下文重验证。没有提取到活跃意图时可能只请求一次。实际 Token 与费用取决于配置的模型和服务商。

复制安全的配置模板，并编辑本地 `.env` 文件：

```bash
cp .env.example .env
pnpm demo:api
```

PowerShell 写法：

```powershell
Copy-Item .env.example .env
pnpm demo:api
```

真实 `.env` 已被 Git 忽略。请勿提交任何 API Key。

运行包含持久化和重启恢复的端到端冒烟测试：

```bash
pnpm smoke:core-api -- --mode=cancellation
pnpm smoke:core-api -- --mode=timing
```

这两项测试使用合成对话，但会调用你配置的真实模型，并把完整、可审计的报告写入 `reports/core-api-smoke/`。`cancellation` 模式最多请求两次，`timing` 模式最多请求三次。

验证完整的 HTTP 对话接入、理由失效和幂等重放路径：

```bash
pnpm smoke:host-ingestion-api
```

该合成冒烟通过时恰好执行三次模型请求：首次对话进行一次意图提取，失效对话进行一次相关性路由和一次候选提取。脚本会断言关闭意图时不再进行后续语义模型调用、不产生联系和 outbox 项，并断言重复上报同一事件不会执行任何模型工作。报告写入 `reports/host-ingestion-smoke/`。

## 包结构

| 包 | 职责 |
| --- | --- |
| `@wakeintent/core` | 领域类型、生命周期、门控、路由、编排、唤醒计划和遥测 |
| `@wakeintent/schemas` | 公共 JSON Schema 与运行时验证 |
| `@wakeintent/store-json` | 单进程本地持久化和重启恢复 |
| `@wakeintent/model-openai-compatible` | 结构化意图提取、路由和重验证模型适配器 |
| `@wakeintent/eval` | 基线、数据集、评分和连续时间线评测工具 |
| `@wakeintent/reference-host` | 本地结构化 HTTP API、持久化 outbox、投递回执与崩溃恢复 |

这些包目前仍是私有工作区包，尚未发布到 npm。当前支持的集成方式是在这个 pnpm workspace 中增加宿主包，并通过 `workspace:*` 依赖所需组件；独立应用暂时无法安装稳定的 npm 版本。参见[宿主集成指南](docs/20-host-integration.md)和可运行的 [`examples/minimal.mjs`](examples/minimal.mjs)。

## 最终证据

冻结对照完成 60/60 组配对运行，运行错误为 0，共发生 327 次 HTTP 尝试：

| 指标 | WakeIntent | 强 Baseline |
| --- | ---: | ---: |
| 无理由误触达 | 0 / 48 | 0 / 48 |
| 漏掉应联系 | 3 / 21 | 1 / 21 |
| 模型调用 | 172 | 146 |
| 总 Token | 155,455 | 109,353 |
| 累计延迟 | 1,663,909 ms | 1,263,853 ms |

完整内部动作序列在 61/69 个比较中一致（88.4%）。其中一些差异只发生在内部，双方最终都没有发消息。稳定的用户可见失败是 `s16-two-intents-one-cancelled`：用户取消一个话题、明确保留另一个话题时，WakeIntent 三轮都错误取消两个意图，而 Baseline 三轮都正确处理。WakeIntent 在 `s17-similar-learning-update` 中有一轮优于 Baseline，但 Baseline 的错误没有在后两轮复现。

仓库保留了真人盲评材料，但尚无至少 5 名真实测试者的结果，因此项目不宣称 WakeIntent 更自然或更有连续性。由于没有配置服务商单价，无法报告美元费用。

机器可读数据、CSV、生成消息、失败轨迹和盲评包保存在
[`reports/intent-continuity-value/2026-09-05T11-50-41.477Z`](reports/intent-continuity-value/2026-09-05T11-50-41.477Z)。
当前仓库通过 209 项自动测试。

## 当前边界

WakeIntent 目前不提供：

- 托管后台调度、云端 API、通知渠道或真实消息投递；
- 对同一个 JSON 存储的多进程并发写入；
- 稳定的 npm 版本或向后兼容承诺；
- 角色人格策略或面向普通用户的聊天界面；
- 比所有 heartbeat 实现成本更低的证明。

`contact` 只表示引擎认为此时适合联系，不代表消息已经生成、尝试投递或被用户收到。参考宿主已经让这套投递契约可以运行和持久化，但消息生成与真实投递仍由实际宿主应用负责。

### 术语表

| API 术语 | 含义 |
| --- | --- |
| `contact` | 联系决策，并不表示消息已经送达 |
| `silent` | 本次评估保持静默，不一定终止生命周期 |
| `defer` | 保持意图活跃，稍后再次评估 |
| `cancel` | 联系理由失效，状态变为 `cancelled` |
| `resolve` | 联系理由已经得到处理，状态变为 `resolved` |
| `expire` | 联系理由超出有效窗口，状态变为 `expired` |
| `nextEvaluationAt` | 存储中的下一次评估时间投影；`null` 表示当前没有定时排期 |

## 常见问题

- 系统提示找不到 `pnpm`：运行 `npm install --global pnpm@11.19.0`，必要时重新打开终端。
- Node.js 版本过低：安装 Node.js 22.14 或更高版本，再运行 `node --version` 确认。
- 依赖下载失败或速度过慢：在稳定网络下重试；软件源超时不等于 WakeIntent 测试失败。
- 真实模型运行出现 401/403、404、`json_schema` 错误或超时：参见 [API 排错指南](docs/08-api-local-testing.md)。请勿把密钥粘贴到 Issue 中。

## 文档

建议从以下文档开始：

- [需求分析](docs/01-requirements-analysis.md)
- [领域模型](docs/02-domain-model.md)
- [系统架构](docs/03-system-architecture.md)
- [技术选型](docs/04-technology-selection.md)
- [评测与验收](docs/05-evaluation-and-acceptance.md)
- [Alpha 0.1 范围](docs/12-alpha-0.1-scope.md)
- [引擎编排](docs/13-alpha-engine-orchestration.md)
- [统一执行追踪](docs/19-unified-execution-trace.md)
- [宿主集成与投递边界](docs/20-host-integration.md)
- [招聘跟进试点计划](docs/21-recruitment-pilot.md)
- [参考宿主 HTTP API](docs/22-reference-host-api.md)
- [对话接入与模型模式](docs/23-conversation-ingestion.md)

## 参与贡献

WakeIntent 仍处于非常早期的阶段。可复现的失败场景、对抗性对话时间线、存储适配器、框架集成和严谨评测都很有价值。详情参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
