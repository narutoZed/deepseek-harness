---
kind: upgrade-guide
description: "自定义 SDK 服务端组合必须提供 Session 投影以读取子会话元数据。"
---

# SDK Session 投影

[English](guide.md) | 中文

## 变更

本 fork 的 SDK 服务端除 `agents` 和 `workingDirectory` 外，还需要 `sessions` 和 `sessionProjections`。服务端通过注册的投影读取子会话元数据，不再调用已弃用的同步 Session 历史读取方法。内置 `sdk` 和 `sdk-minimal` profile 已提供这些服务；只有未挂载投影服务的自定义组合需要调整。

## 迁移

1. 在自定义 profile 的 Cordis 组合中，将 `@deepseek-ai/dsh-session-projection` 与 Session 服务一同挂载，再挂载 SDK 服务端。
2. 重建运行时，并安装配套的 Python 或 TypeScript 客户端。原生 `session/wait` 实现支持 `session.settled`；停驻的空闲子会话不会阻塞运行完成。
3. 初始化 SDK 并确认 `capabilities.sessionTreeSettled`。运行原生子会话任务，确认 `subagent.started` 元数据和最后的根会话 `session.settled` 通知。通知包含 `error` 时应视为完成失败；配套客户端会自动处理。
