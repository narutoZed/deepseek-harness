# Agent Note: SDK assistant stream 通知

Status: implemented

[English](2026-09-05-sdk-assistant-stream-notification.md) | 中文

## 问题

SDK JSON-RPC 服务器会转发持久化的 `session.event` 记录和整个 agent 的 `session.status` 变化，但不会转发实时的 `agent/assistant-stream` 事件。进程外 SDK 客户端可以从已提交的会话事件重建最终 assistant 消息，却没有线路通知来接收进程内 Web adapter 能收到的 token-time stream。

## 决策

SDK 线路协议包含 `session.assistant_stream`，其载荷携带 `sessionId` 与原始 `AssistantStreamFrame`。`HarnessSdkJsonRpcServer` 以全局作用域订阅 `agent/assistant-stream`，并用所属 agent 的 session id 转发每个 frame。现有持久 `session.event` 通知仍是回放来源；新通知是实时展示流，会在后续持久化结算之前到达。

协议包从 `dsh-agent` 导入 frame 类型，并在 package metadata 与 tsconfig 中显式引用该包。

## 考虑过的替代方案

**把部分 chunk 嵌入 `session.event`。** 拒绝：实时 assistant frame 是进程本地展示数据，而当前会话格式的持久日志只记录已提交的结算。

**让客户端等待 `assistant/message.data.stream`。** 拒绝：嵌入式 stream 可以在结算后重建历史，但不能在模型仍在输出时渲染进行中的回复。

**发明更小的 SDK 专用 chunk 载荷。** 拒绝：`AssistantStreamFrame` 已经是核心循环的类型化实时词汇，只复制文本 delta 会丢失 reasoning、block 边界、tool-call delta 与结算 frame。

## 后果

SDK 客户端可以渲染实时 assistant 输出，同时继续从持久化会话事件派生最终历史。协议现在以 type-only 载荷依赖 `dsh-agent`，后续 package dependency 检查应把 `dsh-agent` 视为 SDK 线路词汇的一部分。
