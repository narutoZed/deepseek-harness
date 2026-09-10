# Agent Note: SDK approval and descendant controls

Status: implemented

English | [中文](2026-09-10-sdk-approval-and-descendant-controls.zh.md)

## Problem

An SDK host needs to answer a pending permission question and control a specific child without cancelling the entire runtime. Replacing a child with a new root loses its native history and parent ownership.

## Decision

The SDK server forwards native approval requests only for SDK-owned roots and descendants. Each response consumes one session-bound pending question and grants once or rejects. Abort and shutdown settle pending questions without granting access.

Addressed child prompt and interruption use the native subagent service. The server checks persisted root ancestry, direct parent identity and continuable mode. Native cold continuation restores the same child; its direct parent must be live, and an SDK root can reopen from persistence. Capability flags let hosts disable controls when the composition lacks the required services.

## Alternatives considered

**Host-generated replacement sessions.** A new session would sever child identity, history and native parent ownership, so continuation retains the recorded native child.

**Runtime-wide cancellation for child interruption.** Closing the process would also stop the parent and siblings. The addressed operation delegates cancellation to the native child runtime.

**Permanent permission updates as approval.** Updating policy would authorize later operations that the user did not review. Approval settles only the original request with a one-operation grant.

## Consequences

The trusted host still authenticates users, authorizes external sessions and owns durable request receipts. The SDK keeps successful or in-flight child prompt receipts only within one process. One-shot children remain readable through their host projection but are not continuable through these controls. Tests cover exact ownership, consumed questions, duplicate prompts and teardown; the composed SDK runtime supports host-level approval and active/cold continuation tests without changing the agent loop.
