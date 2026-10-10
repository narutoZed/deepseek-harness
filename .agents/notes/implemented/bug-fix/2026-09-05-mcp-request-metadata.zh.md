# Agent Note: 可信 MCP 请求元数据

Status: implemented

[English](2026-09-05-mcp-request-metadata.md) | 中文

## Problem

可信 MCP 服务需要独立于模型工具参数的授权请求元数据。

## Decision

在 tools/call.params._meta 中携带宿主持有的不可变 requestMeta 快照，并保留到重连后的连接代次。

## Alternatives considered

将身份合并进工具参数会使模型 schema 暴露传输层职责。

## Consequences

默认调用不变。MCP 测试分别验证参数和元数据；宿主负责身份优先级和传输凭证。
