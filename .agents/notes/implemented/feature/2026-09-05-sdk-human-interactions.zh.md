# Agent Note: SDK 用户交互

Status: implemented

[English](2026-09-05-sdk-human-interactions.md) | 中文

## Problem

SDK 宿主无法通过提交提示词回答运行时持有的用户问题。另发提示词会让原工具继续等待，并添加无关的模型输入。

## Decision

服务端发布带会话地址的问题通知，并持有回答 promise，直到收到有效响应、中止或关闭。Python 和 TypeScript 客户端通过同一 JSON-RPC 操作提供回答方法。格式错误或不完整的回答不会消耗等待中的问题。权限审批仍是独立能力。

## Alternatives considered

**把回答作为新提示词提交。** 这无法结束工具的等待，并会改变对话语义。

**挂载 Web UI 的回答器。** 进程外 SDK 宿主负责展示，不应依赖浏览器传输。

## Consequences

宿主可在等待用户输入时保留原来的 agent 轮次。服务端、两个客户端和正式 profile 测试覆盖身份保持的回答及格式错误响应。关闭负责移除监听器并拒绝等待中的 promise；交互不会超过其运行时的生命周期。
