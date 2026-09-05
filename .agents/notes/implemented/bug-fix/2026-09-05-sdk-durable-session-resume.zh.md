# Agent Note: 恢复 SDK 持久会话

Status: implemented

[English](2026-09-05-sdk-durable-session-resume.md) | 中文

## Problem

SDK 进程被替换后会丢失内存中的会话映射。再次向保留的会话 id 发送提示词会报已存在错误，而不是继续持久化的对话。

## Decision

SDK 服务端首次使用时创建会话；只有会话服务返回精确的已存在错误时，才恢复同一个 id。其他创建失败原样传播。并发提示词继续共享同一 id 的创建 promise。

## Alternatives considered

**分配新 id。** 这会丢弃用户的对话历史。

**捕获所有创建错误。** 这会把权限、存储和损坏会话错误隐藏在无关的恢复尝试之后。

## Consequences

宿主可以替换运行时进程，无需复制或重放对话文本。SDK 仍没有独立的历史查询接口。服务端回归和 SDK profile 重启测试验证了保留的身份和之前的消息。在会话服务提供带类型的创建或恢复失败信息前，需要保留精确的错误匹配。
