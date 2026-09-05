# Agent Note: SDK 可移植会话 fork

Status: implemented

[English](2026-09-05-sdk-session-forks.md) | 中文

## Problem

Mesh 使用隔离的运行时 home，因此需要跨进程传递已完成的会话前缀，且不重放提示词。

## Decision

增加有大小限制的原生导出和导入，涵盖附件重写、冷持久读取及重复导入检查。整合 fork 时保留既有的原生活动结束和子 agent 元数据路径。

## Alternatives considered

从提示词重建会丢失原生事件和附件身份。

## Consequences

真实进程测试验证重启后的 fork 继续运行及原生子 agent 活动结束。调用方仍负责租户和工作区授权。
