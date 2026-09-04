# WakeIntent Alpha 0.1 范围与存储决策

> 状态：前四个开发切片已实现  
> 日期：2026-09-02  
> 目标：把已验证的领域原型推进为可恢复、可嵌入的本地引擎，不扩大为完整 Agent 或聊天客户端。

## 1. Alpha 0.1 的用户价值

调用方可以把一个或多个 `ContactIntent` 保存到本地，关闭进程后重新打开，并继续依据 `nextEvaluationAt`、新对话和用户策略进行重验证。每次决策都与更新后的意图状态原子提交，避免出现“状态已变化但审计决策丢失”或相反情况。

Alpha 0.1 不实现真实消息投递、后台常驻服务、分布式调度、多节点并发或角色 UI。

## 2. 第一开发切片

本切片只实现：

1. core 中框架无关的 `ContactIntentStore` 端口；
2. 可复用的内存实现，用于契约和领域测试；
3. 独立 `@wakeintent/store-json` 适配包；
4. 原子文件替换、单进程写入串行化和重启恢复；
5. 意图创建与决策提交的幂等键；
6. 乐观版本检查，拒绝用旧快照覆盖新状态；
7. 按状态、目标和到期时间查询；
8. 从磁盘加载时使用公开 JSON Schema 验证意图和决策。

SQLite 不在本切片直接实现。只有当 JSON store 暴露出真实查询、并发或客户端集成限制后，才新增独立 SQLite 适配包；core 端口不得因此改变。

## 3. 关键架构决定

### 3.1 Core 不依赖文件系统或数据库

`@wakeintent/core` 只定义领域类型、存储端口、内存参考实现和存储不变量。它不得导入 `node:fs`、SQLite、ORM 或 Web 框架。

### 3.2 使用聚合存储端口，而不是两个可独立失败的 repository

早期架构草案分别列出 `IntentRepository` 与 `EventRepository`。如果调用方先保存新状态、再追加决策，任一步失败都会造成审计与状态不一致。

Alpha 0.1 将它们收敛为一个 `ContactIntentStore` 聚合端口，并提供原子的 `commitDecision()`：

- 校验当前 revision；
- 在事务内部用领域状态机计算新意图状态，不接受调用方自报的更新状态；
- 同时更新意图、排期投影和追加决策；
- 整个操作共享一个幂等键。

未来数据库适配器可以在一个事务中实现同一语义。

### 3.3 排期是投影，不污染 ContactIntent Schema

`nextEvaluationAt` 属于最近一次决策或宿主调度投影，不直接加入 `ContactIntent`。存储返回 `StoredContactIntent`：

- `intent`：领域对象；
- `revision`：乐观并发版本；
- `nextEvaluationAt`：下一次候选评估时间。

创建 active intent 时，调用方通常把 `intent.notBefore` 作为初始 `nextEvaluationAt`；candidate 默认不进入到期查询。

### 3.4 幂等不等于覆盖

同一个幂等键重放同一操作返回 `duplicate`，不得产生第二条决策或增加 revision。同一个键若携带不同负载必须抛出冲突错误，不能静默接受。

### 3.5 文件内容视为不可信输入

JSON store 必须验证：

- 文件格式版本；
- 每个 `ContactIntent` 与 `ContactDecision` 的公开 Schema；
- revision、排期和幂等索引的结构；
- 决策引用的意图存在；
- 决策数量与 revision 投影一致。

损坏文件应明确失败，不得用空库覆盖。

## 4. 非目标

- 不在 core 中提供全局单例；
- 不直接把数据库行类型暴露成领域类型；
- 不使用 ORM；
- 不承诺跨进程锁和网络文件系统原子性；
- 不把 `contact` 当成已送达；
- 不在存储层调用模型；
- 不让角色策略覆盖授权、免打扰和安全门控。

## 5. 完成标准

- 内存与 JSON store 对创建、重复创建、原子决策提交、重复提交、版本冲突、到期查询表现一致；
- JSON store 通过“写入—关闭—重新实例化—读取”的重启测试；
- 写入失败不会破坏上一个完整文件；
- 损坏文件返回明确错误；
- core 仍然不依赖 Node 专属 API；
- 全仓库 build、typecheck 和 tests 通过。

## 6. 实现结果（2026-09-02）

第一开发切片已经达到完成标准：

- `@wakeintent/core` 提供聚合端口、内存参考实现、乐观 revision、幂等冲突和语义快照校验；
- `@wakeintent/store-json` 使用同目录临时文件、文件同步和原子替换持久化快照；
- 每次写入先在内存副本中完成，写盘成功后才替换当前状态，写盘失败不会造成半提交；
- 重启恢复时同时验证公开 Schema 与状态/审计/idempotency 之间的语义一致性；
- 全仓库 5 个包 build、typecheck 均通过，共 150 项测试通过。

当前并发边界是“一个进程内、同一路径使用一个 store 实例”。同一文件被多个实例或多个进程同时写入不在 Alpha 0.1 的保证范围内；出现这一真实需求时应采用 SQLite 或其他事务型适配器，而不是给 JSON 文件叠加脆弱的自制分布式锁。

## 7. 已知后续切片

1. 连接模型 adapter usage 与应用服务工作量统计；
2. 根据 JSON store 的真实限制决定 SQLite 适配器；
3. 在硬安全策略之上增加 Persona Policy。
