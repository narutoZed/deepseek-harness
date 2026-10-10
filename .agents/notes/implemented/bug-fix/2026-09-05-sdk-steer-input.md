# Agent Note: SDK next-step input

Status: implemented

English | [中文](2026-09-05-sdk-steer-input.zh.md)

## Problem

SDK hosts cannot steer a running agent through a next-turn prompt. Missing caller identity also prevents a host from reconciling its pending input with durable user messages.

## Decision

`session/steer` admits identified input through the core agent's next-step operation. It rejects missing or inactive sessions and reuses successful or in-flight identical requests within the process. An id reused with different content rejects; failed admissions leave no retry receipt. Both SDK clients expose this operation. Prompt submission optionally retains caller identity as `source.rpcId`.

## Alternatives considered

**Queue every update.** This delays steering until another turn and misrepresents the host's requested operation.

**Promise durable retry recovery.** The process-local receipt map cannot make that guarantee; persisted request identity supports correlation only.

## Consequences

Hosts can steer without reimplementing the core inbox. Unit and real-profile tests hold a model request open, admit a steer, and verify the next request consumes it once. Runtime binaries and clients require coordinated upgrades; process-restart receipt recovery remains separate work.
