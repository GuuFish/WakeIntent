# WakeIntent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/GuuFish/wakeintent/actions/workflows/ci.yml/badge.svg)](https://github.com/GuuFish/wakeintent/actions/workflows/ci.yml)

> **这是开发者组件，不是开箱即用的应用。** 本仓库面向希望把主动联系决策嵌入 AI 产品的开发者。克隆后得到的是核心引擎、适配器、示例和评测工具；它不会直接启动聊天界面、常驻 AI 助手或自动发送通知。

WakeIntent 是一个面向对话式 AI、与具体框架无关的联系意图引擎。它把对话中“未来值得再次联系用户的理由”转化为可持久化的 `ContactIntent`，并在真正联系前结合最新上下文重新验证，最终决定联系、推迟、取消、过期、标记为已解决或保持沉默。

> **当前状态：研究型 Alpha 0.1。** 核心引擎、本地持久化、模型适配器、审计记录和评测工具现在都可以运行。WakeIntent 还不是生产级通知服务，也不是完整的聊天应用。

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

`pnpm check` 会构建并类型检查五个包，然后运行全部测试。在经过独立验证的提交 `53d5e49` 上，预期结果为 22 个测试文件、178 项测试全部通过。随着项目继续开发，准确数量可能增加。

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

## 包结构

| 包 | 职责 |
| --- | --- |
| `@wakeintent/core` | 领域类型、生命周期、门控、路由、编排、唤醒计划和遥测 |
| `@wakeintent/schemas` | 公共 JSON Schema 与运行时验证 |
| `@wakeintent/store-json` | 单进程本地持久化和重启恢复 |
| `@wakeintent/model-openai-compatible` | 结构化意图提取、路由和重验证模型适配器 |
| `@wakeintent/eval` | 基线、数据集、评分和连续时间线评测工具 |

这些包目前仍是私有工作区包，尚未发布到 npm。当前支持的集成方式是在这个 pnpm workspace 中增加宿主包，并通过 `workspace:*` 依赖所需组件；独立应用暂时无法安装稳定的 npm 版本。参见[宿主集成指南](docs/20-host-integration.md)和可运行的 [`examples/minimal.mjs`](examples/minimal.mjs)。

## 当前证据

一次全新目录的独立安装验证在提交 `53d5e49` 上复现了完整仓库检查：五个包共 178 项测试全部通过。开发期间两次使用 `gpt-5.5` 的真实模型冒烟测试也已通过：

- 联系理由失效后取消：2 次模型调用、1,452 Token、0 次联系决策；
- 联系时间变化后推迟：3 次模型调用、2,627 Token，推迟到新的事件窗口后，0 次联系决策。

原始报告保存在 [`reports/core-api-smoke`](reports/core-api-smoke)；早期可行性结果及其局限记录在 [`docs/10-feasibility-conclusion.md`](docs/10-feasibility-conclusion.md)。

独立安装结果及其发现的问题保存在 [`reports/external-verification/2026-09-04-clean-clone.md`](reports/external-verification/2026-09-04-clean-clone.md)。

这些证据说明核心机制可以端到端运行，但尚未证明 WakeIntent 一定比强 due-gated heartbeat 更省钱，也没有证明它已经改善了生产环境中的真实用户体验。当前实验显示它能更早清理失效状态、提供更细致的治理和审计，但 Token 消耗往往更高。

## 当前边界

WakeIntent 目前不提供：

- 后台常驻服务、托管 API、通知渠道或真实消息投递；
- 对同一个 JSON 存储的多进程并发写入；
- 稳定的 npm 版本或向后兼容承诺；
- 角色人格策略或面向普通用户的聊天界面；
- 比所有 heartbeat 实现成本更低的证明。

`contact` 只表示引擎认为此时适合联系，不代表消息已经生成、尝试投递或被用户收到。真实投递需要由宿主应用负责，并在未来通过投递契约回传结果。

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

## 参与贡献

WakeIntent 仍处于非常早期的阶段。可复现的失败场景、对抗性对话时间线、存储适配器、框架集成和严谨评测都很有价值。详情参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
