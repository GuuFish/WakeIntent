# WakeIntent 技术选型

> 文档状态：Draft 0.1  
> 更新日期：2026-09-01  
> 原则：只为 v0.1 已确认需求选型，客户端与生产投递暂缓决定

## 1. 选型标准

按以下顺序权衡：

1. 能否保持 Core 与 Agent、模型、数据库和 UI 解耦；
2. 能否发布为开发者容易接入的开源组件；
3. 是否利于结构化输出、JSON 契约和测试；
4. 是否降低首个独立项目的开发与维护成本；
5. 是否支持未来 Web/桌面客户端复用；
6. 性能是否足以支持评测和本地运行。

## 2. 已决定的 v0.1 技术栈

| 类别 | 选择 | 决策 |
|---|---|---|
| 语言 | TypeScript（strict mode） | Adopt |
| 运行时 | Node.js >= 22.14；推荐 Node.js 24 LTS | Adopt |
| 模块系统 | ESM | Adopt |
| 包管理 | pnpm workspace | Adopt |
| 公共契约 | JSON Schema Draft 2020-12 | Adopt |
| 运行时校验 | Ajv | Adopt |
| 测试 | Vitest | Adopt |
| 时间测试 | 注入式 `Clock` + Vitest fake timers | Adopt |
| 构建 | TypeScript compiler；需要发布打包时再评估 tsdown/tsup | Adopt/Defer |
| 代码质量 | ESLint + Prettier | Adopt |
| 场景格式 | JSON 文件 + JSON Schema 校验 | Adopt |
| 评测输出 | JSON 原始结果 + Markdown 摘要 | Adopt |
| CI | GitHub Actions | Adopt |
| 版本管理 | SemVer；多包发布阶段引入 Changesets | Defer |

Node.js 官方当前将 v22 与 v24 标记为 LTS，并建议生产应用使用 Active LTS 或 Maintenance LTS。本项目最低兼容当前开发机已有的 Node.js 22.14，推荐使用 Node.js 24 LTS，并计划在 CI 中同时验证 22 与 24；不选仍处于 Current 阶段的 Node.js 26。pnpm 原生支持 workspace，能够在一个仓库中维护 Core、Schema、适配器和评测包。Vitest 原生支持模拟系统时间，符合生命周期评测要求。

## 3. 为什么选择 TypeScript

### 优点

- 对聊天应用、Node 服务、Web 客户端和 npm SDK 都有较低接入成本；
- 适合表达 discriminated unions，例如 Decision 和 DomainEvent；
- 与 JSON、JSON Schema 和结构化模型输出自然衔接；
- 未来参考客户端可以复用领域类型；
- 相比同时维护 Python 与 TypeScript，首期维护面更小。

### 风险

- 如果 Schema 只存在于 TypeScript 类型中，会破坏跨语言目标；
- Node 生态的数据库原生模块可能增加跨平台安装问题；
- 类型安全不能替代运行时校验。

### 约束措施

- JSON Schema 是公开交换契约；
- 所有外部输入通过 Ajv 校验；
- Core 不暴露 Node 专属类型，例如 `Buffer`、文件句柄或框架 Request；
- Python 等语言后续可基于同一 Schema 实现适配器。

## 4. Schema 方案

### 选择：JSON Schema 2020-12 + Ajv

原因：

- Schema 能被非 TypeScript 项目使用；
- 场景、模型输出、决策日志和 API 都能共享同一契约；
- Ajv 可预编译校验器，运行时成本可控；
- Schema 版本可独立演进并生成文档或其他语言类型。

v0.1 不采用“Zod 作为唯一真相来源”，因为这会让公开协议首先依赖 TypeScript 库。Zod 可以在未来作为开发者友好封装，但不能取代规范文件。

## 5. 模型接入方案

### 选择：自定义 `StructuredModel` 端口

Core 只依赖如下能力概念：

- 接受 messages、JSON Schema、模型选项和关联 ID；
- 返回通过 Schema 验证的对象；
- 返回 token、延迟、模型名称和供应商元数据；
- 支持取消和超时。

v0.1 提供一个 OpenAI-compatible 参考适配器，但不让 Core 直接依赖 OpenAI、LangChain、Vercel AI SDK 或具体 Agent 框架。

### 暂不选择 LangChain/LangGraph 作为核心依赖

它们适合复杂 Agent 工作流，但 WakeIntent v0.1 只有提取和重验证两个明确用例。引入通用编排框架会扩大依赖面，也会削弱“框架无关”的可信度。后续可以提供适配包。

## 6. 存储方案

### Alpha 0.1 选择

- 单元测试：In-memory repository；
- 场景评测：版本化 fixture + 追加式 JSON/JSONL 运行日志；
- 本地恢复演示：独立适配包中的原子 JSON file store；core 只保留聚合存储端口和内存参考实现。

### 为什么暂不直接引入 SQLite 或 ORM

Alpha 0.1 的第一持久化切片先验证存储契约、幂等、乐观版本和重启恢复。直接加入 SQLite、Drizzle 或 Prisma 会把数据库选择与尚未稳定的端口绑定。先通过 `ContactIntentStore` 固定原子提交语义；当 JSON store 暴露真实查询、并发或客户端持久化限制时，再加入独立 SQLite 适配器。SQLite 适配器不得改变 core 端口。

### v0.2 候选

- SQLite 适配器；
- Kysely 或 Drizzle 作为可选查询层；
- 不把数据库实体直接暴露为 Core 的领域类型。

## 7. 测试方案

### 选择：Vitest

- 单元测试：状态转移、门控、Schema、幂等候选；
- 契约测试：每个模型和存储适配器运行同一套 contract suite；
- 场景测试：fake clock 推进时间并注入对话事件；
- 属性测试：后续评估 fast-check，用于时间窗口和非法状态组合；
- 真实模型评测：与确定性测试分开，不进入默认快速测试。

业务代码只使用注入的 `Clock`。Vitest fake timers 用于适配器和集成测试，不允许散落的 `Date.now()` 破坏可重复性。

## 8. Monorepo 方案

### 选择：pnpm workspace，不引入 Turborepo

v0.1 包数量较少，pnpm 已能提供 workspace 链接和递归脚本。Turborepo 的缓存与任务图在项目扩大后再评估，当前没有必要增加配置层。

初始包边界建议：

- `@wakeintent/core`
- `@wakeintent/schemas`
- `@wakeintent/model-openai-compatible`
- `@wakeintent/evaluation`
- `@wakeintent/cli`

实际创建包时可以先合并 `evaluation` 与 `cli`，避免形式化拆包。

## 9. 客户端技术：暂不决定

参考客户端属于核心假设验证后的阶段。候选方案：

| 方案 | 优点 | 风险 |
|---|---|---|
| React + Vite PWA | 开发快、可部署、移动端可访问 | 后台能力和系统推送受平台限制 |
| Tauri 2 + React | 安装包小、桌面能力强、可探索移动端 | 引入 Rust 与跨平台后台复杂度 |
| Electron + React | 全 TypeScript、Node 集成成熟 | 安装包和资源占用较大 |

决策时点：Core 与评测证明独立价值，并明确客户端是否需要本地常驻、系统通知和移动后台能力之后。

## 10. 明确拒绝或延后的选项

- Python 作为首个 Core：AI 库丰富，但与未来交互客户端共享类型较弱；保留后续 SDK 可能。
- Java/Spring：工程稳健，但对 npm/前端生态接入和快速开源试验偏重。
- Rust Core：性能和安全好，但当前瓶颈不在性能，学习与贡献门槛更高。
- 微服务：v0.1 没有独立部署和扩缩容需求。
- 向量数据库：当前没有证明语义搜索是必要条件。
- Kafka/Redis/BullMQ：v0.1 不实现生产调度和投递。
- MCP 作为唯一接口：MCP 可作为后续适配器，但核心 API 应能在普通库调用中使用。

## 11. 技术决策复审条件

出现以下情况时重新评估：

- 真实用户要求 Python-first；
- JSON file store 无法支持评测查询或恢复；
- 模型适配接口无法覆盖两个以上供应商；
- 包数量和 CI 时间使 pnpm 原生脚本明显不足；
- 客户端需要可靠的桌面后台或移动推送；
- ContactIntent Schema 出现跨语言实现需求。

## 12. 参考依据

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- [pnpm workspaces](https://pnpm.io/workspaces)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [Ajv getting started](https://ajv.js.org/guide/getting-started.html)
- [Vitest date mocking](https://vitest.dev/guide/mocking/dates)
