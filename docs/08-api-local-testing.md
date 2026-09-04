# API 本地测试指南

## 1. 目的

这一轮只做一次真实模型冒烟测试：确认模型可以从对话中抽取 `ContactIntent`，并能在看到“用户已经拿到结果且不必再问”的最新上下文后选择 `resolve` 或 `cancel`，而不是继续 `contact`。

这不是项目价值评测。正式结论仍需冻结场景集、基线、模型和指标后批量运行。

## 2. 安全配置

不要把密钥发到聊天里，也不要直接写进源代码。项目根目录的 `.env` 已被 Git 忽略。

在 PowerShell 中进入项目并复制模板：

```powershell
Set-Location D:\agentss\WakeIntent
Copy-Item .env.example .env
notepad .env
```

OpenAI 官方接口可这样配置：

```dotenv
WAKEINTENT_API_KEY=你的真实密钥
WAKEINTENT_BASE_URL=https://api.openai.com/v1
WAKEINTENT_MODEL=gpt-5-mini
WAKEINTENT_API_MODE=responses
WAKEINTENT_TIMEOUT_MS=60000
```

如果使用第三方 OpenAI-compatible 服务，请以服务商文档给出的值替换密钥、基础地址和模型名。若服务商支持 `/v1/responses`，保留 `responses`；若只支持 `/v1/chat/completions`，改为：

```dotenv
WAKEINTENT_API_MODE=chat-completions
```

兼容接口还必须支持 JSON Schema Structured Outputs；仅仅“请求格式类似 OpenAI”不代表支持这一能力。

## 3. 执行

```powershell
pnpm demo:api
```

这条命令会发出两次模型请求：第一次抽取候选意图，第二次根据最新上下文重验证。输出中重点看：

- `extracted.status` 是否为 `active`；
- `reevaluation.decision.action` 是否为 `resolve` 或 `cancel`；
- 证据引用是否只包含输入中真实存在的事件 ID；
- 时间是否是合理的 ISO 8601 时间，而非模型编造的模糊文本。

## 4. 常见错误

- `401/403`：密钥无效、余额或权限不足。
- `404`：基础地址或 API 模式不匹配，常见于兼容服务只实现了 Chat Completions。
- `400` 且提到 `json_schema`：当前模型或兼容服务不支持 Structured Outputs，请更换模型或服务。
- 超时：适当调大 `WAKEINTENT_TIMEOUT_MS`，并检查服务连通性。

任何报错都不应把密钥打印出来。若需要贴错误排查，只贴状态码和错误正文，先确认其中没有敏感信息。

## 5. 开发期对照评测

单场景冒烟通过后，可运行：

```powershell
pnpm eval:api
```

默认只选 3 个开发场景，两套系统最多调用模型 12 次。结果写入 `reports/runs/`。这些场景用于验证评测管线，不足以证明项目价值；协议和剩余限制见 `docs/09-development-evaluation.md`。
