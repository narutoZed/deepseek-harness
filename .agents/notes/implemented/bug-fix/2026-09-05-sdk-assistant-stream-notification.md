# Agent Note: SDK assistant stream notifications

Status: implemented

English | [中文](2026-09-05-sdk-assistant-stream-notification.zh.md)

## Problem

The SDK JSON-RPC server forwarded durable `session.event` records and whole-agent `session.status` changes, but it did not forward the live `agent/assistant-stream` event. Out-of-process SDK clients could reconstruct the final assistant message from the committed session event, yet they had no wire notification for the token-time stream that the in-process Web adapter receives.

## Decision

The SDK wire protocol includes `session.assistant_stream`, whose payload carries the `sessionId` and the original `AssistantStreamFrame`. `HarnessSdkJsonRpcServer` subscribes to `agent/assistant-stream` with global scope and forwards each frame under the owning agent's session id. The existing durable `session.event` notification remains the replay source; the new notification is a live presentation stream that arrives before the later durable settlement.

The protocol package imports the frame type from `dsh-agent`, and its package metadata and tsconfig reference that package explicitly.

## Alternatives considered

**Embed partial chunks into `session.event`.** Rejected: live assistant frames are process-local presentation data, while the durable log records only committed settlements in the current session format.

**Ask clients to wait for `assistant/message.data.stream`.** Rejected: the embedded stream reconstructs history after settlement, but it cannot render the in-flight response while the model is still producing it.

**Invent a smaller SDK-only chunk payload.** Rejected: `AssistantStreamFrame` is already the core loop's typed live vocabulary, and copying only text deltas would lose reasoning, block boundaries, tool-call deltas, and settlement frames.

## Consequences

SDK clients can render live assistant output while continuing to derive final history from durable session events. The protocol now depends on `dsh-agent` for a type-only payload, so future package dependency checks should treat `dsh-agent` as part of the SDK wire vocabulary.
