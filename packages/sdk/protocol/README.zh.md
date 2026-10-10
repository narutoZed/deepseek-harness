---
description: "面向客户端与服务端实现者的 SDK 协议格式（wire format）说明：Harness 运行时与其 SDK 客户端之间使用的按换行分帧 JSON-RPC 传输，以及具名的请求、结果与通知类型。"
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-protocol

[English](README.md) | 中文

`interaction.request` 用 `sessionId`、`interactionId` 和 `questions` 标识一批等待回答的问题。`interaction/respond` 发送该交互 id，以及包含问题 `id`、`selected` 字符串数组和可选 `custom` 文本的回答；成功返回 `{ accepted: true }`。

## 概述

`dsh-sdk-protocol` 让 DeepSeek Harness 运行时与其 SDK 客户端通过按换行分帧的字节流交换 JSON-RPC 2.0 消息：一个传输类，加上协议两端共同使用的具名请求、结果与通知类型。服务端是 [`dsh-sdk-jsonrpc-server`](../server/README.zh.md) 插件；客户端是 TypeScript 的 [`dsh-sdk-client`](../client/README.zh.md) 与 [Python SDK](../../../python/README.zh.md)（后者复现这些结构但不导入它们）。当你实现或调试协议某一端时使用本包：分帧规则、方法名、载荷类型与错误语义都在这里。它是纯库——无插件、无配置、无注册。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当你构建或调试 SDK 协议端——服务插件、客户端库或使用该协议的自定义工具——时使用本包。它为你提供一个在调用方持有的字节流上承载 JSON-RPC 2.0 的传输，以及每个 SDK 方法与通知的类型化结构。

`InitializeResult.capabilities.sessionTreeSettled` 可选声明对新增 `session.settled` 通知的支持，载荷为 `{ sessionId }`。根 agent 空闲、next-turn inbox 为空且原生后代的准备和运行结束后，该通知结束已接受的根活动区间。客户端必须协商此能力后再等待该标记；原始 `session.status` 保留既有含义。

`session/export` 和 `session/fork` 在可信 SDK 运行时之间传递有大小限制的已完成轮次种子。快照包含源身份、持久事件和附件字节。Fork 结果包含目标身份和构造历史，供公开投影使用。

`subagent.started` 从子会话自身非继承事件的首个兼容持久描述符中提供可选的 `label`、`mode` 和子代理 `provider`。构造期播种的描述符不一定产生实时 `session.event` 通知。描述符缺失、不受支持或损坏时，这些展示字段会省略，但父子身份仍会保留。此通知不复制人格提示、工具过滤器或任务提示词。 创建后才追加的前台描述符仍可通过结构化的 `session.event` 获取；创建元数据不会预测未来事件。

<a id="running-session-steering"></a>
### 运行中会话的引导

`session/steer` 为已经运行的会话接受 `{ sessionId, requestId, contentBlocks }`，并立即返回持久收件箱的 `messageId`，不等待完成。同一进程内，内容相同且已成功或正在处理的重试复用该回执；相同 id 配合不同内容会被拒绝。准入失败可以重试。会话不存在或空闲时会拒绝，而不是启动新轮次。

`session/prompt` 接受用于关联的可选 `requestId`。两个操作均将其保留为 `source.rpcId`。这些身份不提供跨进程重试恢复。

### 审批与后代控制

`initialize` 声明可选布尔值 `approvalResponses` 和 `subagentControl`。`approval.request` 包含 `sessionId`、`interactionId`、`toolName`，以及可选的 `callId` 和 `reason`。`approval/respond` 要求相同的会话与交互 id，并附带 `decision: "approved" | "cancelled"`；批准仅允许一次操作，取消则拒绝操作。`approval.resolved` 报告 `allowed-once`、`rejected` 或 `cancelled`。过期或已消费的问题以 `data.code: "interaction_expired"` 拒绝。

`subagent/prompt` 接收 `rootSessionId`、直接 `parentSessionId`、`childSessionId`、`requestId`、持久化 `content` 和可选的 `clientTimeZone`，返回 `{ messageId, replayed }`。同一进程内的相同重试复用接收回执；相同请求 id 携带不同内容会被拒绝。`subagent/interrupt` 接收这三个会话 id，请求取消该子会话当前轮次后返回 `{ accepted: true }`。两者都要求子会话在该根会话下有持久记录且可续聊。直接父会话必须存活；SDK 根会话可以从持久化记录重新打开，原生服务会恢复其未加载的可续聊子会话。其他后代与父会话继续运行。`session/is-live` 检查 `{ rootSessionId, sessionId }`，不会打开 agent。

可信宿主负责外部用户授权并保留完整会话地址。服务器验证原生祖先关系，但不认证 JSON-RPC 对端。持久化的跨进程请求去重由宿主负责；新运行时不会保留之前的请求回执。

### 分帧与传输

在你拥有的字节流上，每个 `\n` 结尾的行承载一条 JSON-RPC 2.0 消息。同时带 `id` 与 `method` 的帧是请求，仅 `id` 是响应，仅 `method` 是通知；格式错误的行会被忽略。没有注册处理器的请求应答 `-32601`，普通处理器失败应答 `-32603`，显式的 `JsonRpcResponseError` 失败保留其 code 和 data，错误响应会以 `JsonRpcResponseError` 拒绝挂起的请求，并保留协议中的 `code` 与可选 `data`。`start()` 挂接流监听器，`close()` 移除监听器并拒绝挂起请求，但不销毁流。

### SDK 方法

两个协议端共享以下方法。

| 方向 | 方法 | 载荷类型 |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult`（持久入队回执） |
| client→server | `session/wait` | `SessionWaitParams` → `{}` |
| 客户端→服务端 | `session/working-directory/get` | `SessionWorkingDirectoryParams` → `SessionWorkingDirectoryResult` |
| 客户端→服务端 | `session/working-directory/set` | `SessionWorkingDirectorySetParams` → `SessionWorkingDirectoryResult` |
| client→server | `interaction/respond` | `InteractionRespondParams` → `InteractionRespondResult` |
| client→server | `session/steer` | `SessionSteerParams` → `SessionPromptResult` |
| client→server | `session/export` | `SessionExportParams` → `SessionForkSnapshot` |
| client→server | `session/fork` | `SessionForkParams` → `SessionForkResult` |
| client→server | `session/is-live` | `{ rootSessionId, sessionId }` → `{ live }` |
| client→server | `approval/respond` | `ApprovalRespondParams` → `InteractionRespondResult` |
| client→server | `subagent/prompt` | `SdkSubagentPromptParams` → `SdkSubagentPromptResult` |
| client→server | `subagent/interrupt` | `SdkSubagentInterruptParams` → `InteractionRespondResult` |
| client→server | `shutdown` | 无参数 → `{}` |
| server→client | `session.event` | `SessionEventNotification`（运行时内每个会话，不过滤） |
| server→client | `interaction.request` | `InteractionRequestNotification` |
| server→client | `approval.request` | `ApprovalRequestNotification` |
| server→client | `approval.resolved` | `ApprovalResolvedNotification` |
| server→client | `session.status` | `SessionStatusNotification`（整个 agent 的 `running`/`idle` 转换） |
| server→client | `session.settled` | `SessionSettledNotification`（协商确定的根活动结束） |
| server→client | `session.assistant_stream` | `SessionAssistantStreamNotification`（实时 assistant stream frame） |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification`（仅进程内运行） |

`HarnessSdkRequestMap` 与 `HarnessSdkNotificationMap` 按方法名索引这些结构；包根与传输一起导出它们。

`session/wait` 接受已有 SDK 会话的 `{ sessionId }`，在根 Agent 持续空闲且活跃的受管理后代工作结束后返回 `{}`。带有停放输入的空闲后代保持驻留，不阻塞这次等待。未知 id，以及没有后续终止事件记录的 Agent 运行时错误，都会使请求失败。等待期间提交的通知在同一传输上先于响应到达；原始 `session.status` 转换仍表示整个 Agent 的状态。

### 载荷语义

`SessionPromptResult.messageId` 标识已排队的用户消息；它不标识后续的助手消息、轮次结束或提示词结果。`SdkPromptContentBlock` 接受普通持久内容以及 `SdkEncodedImageBlock { type: "image", data, mimeType }`；服务器在入队前把编码图像转换为持久引用。`InitializeParams.reasoningEffort` 是所选提供方／模型路由可选的非空适配器自有标识符；省略时保留该模型的默认值。`InitializeParams.maxTokens` 是可选的正安全整数，用于限制 SDK 创建的 agent 及其进程内后代的每次对话模型输出；省略时应用所选适配器的确切模型默认值。服务器会在初始化期间解析确切路由，并在握手成功前拒绝 `session/prompt`，因此缺少适配器、模型不可用或推理强度不受支持时，不会回退到构造期默认值。`SessionAssistantStreamNotification.frame` 携带持久结算前一个进程本地 assistant attempt frame；消费者通过 frame 的 attempt、turn、step 与 outcome 字段把它同后续 `session.event` 结算配对。`SubagentFinishedNotification.lastAssistantMessage` 携带子 agent 最后一条非空 assistant 消息；若不存在这类消息，则携带其累积的 assistant 文本；子 agent 两种输出均未产生时，该字段缺省。`serverInfo.name` 的协议值固定为 `deepseek-harness-sdk-runtime`。通知载荷依赖 `AssistantStreamFrame`（`dsh-agent`）、`SessionEvent`（`dsh-session`）、`ContentBlock`（`dsh-llm`）与 `SubagentStopReason`（`dsh-subagent`），因此实时与持久会话词汇都是协议格式约定的一部分。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释协议库背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包采用一种职责分离设计：两个协议端共用一个按换行分帧的传输类，并以具名类型索引协议方法。包根是唯一的导入面——源模块不支持深层导入。它是没有插件、配置或注册的纯库；服务插件与客户端负责其周围的一切行为。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/transport.ts`](src/transport.ts) | `JsonRpcLineTransport`：行分帧、请求/响应/通知分发、错误映射、挂起请求记账 |
| [`src/types.ts`](src/types.ts) | 具名请求/结果与通知载荷类型，按方法索引 |
| [`src/index.ts`](src/index.ts) | 消费方接口：传输与具名协议类型 |

### 帧分发

入站行逐条解析：带 `id` 与 `method` 的帧通过请求处理器应答（或应答 `-32601`），仅 `id` 的帧结算匹配的挂起请求（错误帧以 `JsonRpcResponseError` 拒绝它），仅 `method` 的帧交给通知处理器。`start()` 挂接输入监听器；`close()` 移除它们并在不销毁流的情况下失败所有挂起请求。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当协议约定不够用时阅读以下页面。它们从服务插件进入客户端与可运行应用。

- [JSON-RPC 服务插件](../server/README.zh.md) — 通过 stdio 服务该协议的运行时插件。
- [TypeScript SDK 客户端](../client/README.zh.md) — 驱动该协议的客户端。
- [Python SDK](../../../python/README.zh.md) — 复现这些结构的 Python 对应实现。
- [SDK 应用组合包](../../bundle/sdk-app/README.zh.md) — 启动服务器的 `dsh --profile sdk` 应用。

-----

<a id="model-experience"></a>
## 模型体验

无，因为这是面向客户端的协议库；模型可见行为归对外服务入口后方的运行时插件所有。

#### KV Cache 影响

无；此包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明协议未覆盖或未承诺的内容。它们是当前包约束，不是与其他协议格式的对比或任务积压。

- **无协议版本协商**——握手只携带 `serverInfo.version`（`0.0.1`，客户端不校验）；处于预发布阶段，无兼容承诺。
- **无根会话取消与会话关闭方法**——客户端通过关闭运行时进程放弃根会话执行；见 [JSON-RPC 服务插件](../server/README.zh.md)。
- **server→client 请求是未使用的功能**——传输层支持，但服务器从不发送；审批使用通知和客户端到服务端的回复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性——已交付的行为与限制见上文各节与代码。本协议的各个结构由 Python SDK 复现（而非导入），因此在这里更改方法、载荷或协议稳定值 `serverInfo.name` 时，必须在同一次变更中更新 Python 对侧与 TypeScript 客户端。没有记录其他未解决的开放设计问题。

</details>
