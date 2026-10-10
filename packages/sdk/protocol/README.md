---
description: "The SDK wire protocol for client and server implementers: the newline-delimited JSON-RPC transport and the named request, result, and notification types spoken between a Harness runtime and its SDK clients."
kind: "package-library"
---

# @deepseek-ai/dsh-sdk-protocol

English | [中文](README.zh.md)

`interaction.request` identifies a pending question batch with `sessionId`, `interactionId` and `questions`. `interaction/respond` sends that interaction id and answers with question `id`, `selected` strings and optional `custom` text; success returns `{ accepted: true }`.

## Summary

`dsh-sdk-protocol` lets a DeepSeek Harness runtime and its SDK clients exchange JSON-RPC 2.0 messages over newline-delimited byte streams: one transport class plus the named request, result, and notification types both wire ends speak. The serving side is the [`dsh-sdk-jsonrpc-server`](../server/README.md) plugin; the clients are the TypeScript [`dsh-sdk-client`](../client/README.md) and the [Python SDK](../../../python/README.md), which mirrors these shapes without importing them. Use this package when you implement or debug a wire end: framing rules, method names, payload types, and error semantics all live here. It is a pure library — no plugin, no configuration, no registrations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when you build or debug an SDK wire end — the serving plugin, a client library, or custom tooling that speaks the SDK protocol. It gives you one transport for JSON-RPC 2.0 over caller-owned byte streams and the typed shapes for every SDK method and notification.

`InitializeResult.capabilities.sessionTreeSettled` optionally advertises support for the additive `session.settled` notification with `{ sessionId }`. It ends an accepted root activity interval after root idle, an empty next-turn inbox, and native descendant preparation/run settlement. Clients must negotiate this capability before waiting for the marker; raw `session.status` retains its existing meaning.

`session/export` and `session/fork` transfer a bounded completed-turn seed between trusted SDK runtimes. The snapshot contains source identity, durable events and attachment bytes. Fork results contain the destination identity and constructor history for a public projection.

`subagent.started` includes optional `label`, `mode` and subagent `provider` from the first compatible durable descriptor in the child’s own, non-inherited events. Constructor-seeded descriptors need not produce live `session.event` notifications. Missing, unsupported or malformed descriptors leave those display fields absent while preserving parent/child identity. Persona, tool filters and task prompts are not copied into this notification. A foreground descriptor appended after creation remains available through its structured `session.event`; creation metadata does not predict future events.

<a id="running-session-steering"></a>
### Running-session steering

`session/steer` accepts `{ sessionId, requestId, contentBlocks }` for an existing running session and returns its durable inbox `messageId` without waiting for completion. Identical successful or in-flight retries reuse that receipt within the process; reusing an id with different content is rejected. Failed admissions are retryable. Missing or idle sessions reject rather than starting a turn.

`session/prompt` accepts optional `requestId` for correlation. Both operations retain it as `source.rpcId`. These identities do not provide cross-process retry recovery.

### Approval and descendant control

`initialize` advertises optional `approvalResponses` and `subagentControl` booleans. `approval.request` carries `sessionId`, `interactionId`, `toolName`, optional `callId` and `reason`. `approval/respond` requires the same session and interaction plus `decision: "approved" | "cancelled"`; approval grants one operation, cancellation rejects it. `approval.resolved` reports `allowed-once`, `rejected` or `cancelled`. An expired or already consumed question rejects with `data.code: "interaction_expired"`.

`subagent/prompt` takes `rootSessionId`, direct `parentSessionId`, `childSessionId`, `requestId`, durable `content` and optional `clientTimeZone`; it returns `{ messageId, replayed }`. Identical retries reuse admission in the same process; different content under that request id rejects. `subagent/interrupt` takes the three session ids and returns `{ accepted: true }` after requesting cancellation of that child’s current turn. Both require a continuable child recorded beneath that root. The direct parent must be live; an SDK root can be reopened from persistence, and the native service resumes its cold continuable child. Other descendants and the parent keep running. `session/is-live` checks `{ rootSessionId, sessionId }` without opening an agent.

The trusted host authorizes external users and retains complete session addresses. The server validates native ancestry but does not authenticate JSON-RPC peers. Durable cross-process request deduplication belongs to the host; a new runtime does not retain earlier request receipts.

### Framing and transport

Wire one JSON-RPC 2.0 message per `\n`-terminated line over byte streams you own. A frame with both `id` and `method` is a request, `id` alone is a response, and `method` alone is a notification; malformed lines are ignored. Requests with no registered handler answer `-32601`, ordinary handler failures answer `-32603`, explicit `JsonRpcResponseError` failures preserve their code and data, and error responses reject the pending request with `JsonRpcResponseError`, which preserves the wire `code` and optional `data`. `start()` attaches stream listeners and `close()` detaches them and rejects pending requests without destroying the streams.

### The SDK methods

Both wire ends share the following methods.

| Direction | Method | Payload types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `session/wait` | `SessionWaitParams` → `{}` |
| client→server | `session/working-directory/get` | `SessionWorkingDirectoryParams` → `SessionWorkingDirectoryResult` |
| client→server | `session/working-directory/set` | `SessionWorkingDirectorySetParams` → `SessionWorkingDirectoryResult` |
| client→server | `interaction/respond` | `InteractionRespondParams` → `InteractionRespondResult` |
| client→server | `session/steer` | `SessionSteerParams` → `SessionPromptResult` |
| client→server | `session/export` | `SessionExportParams` → `SessionForkSnapshot` |
| client→server | `session/fork` | `SessionForkParams` → `SessionForkResult` |
| client→server | `session/is-live` | `{ rootSessionId, sessionId }` → `{ live }` |
| client→server | `approval/respond` | `ApprovalRespondParams` → `InteractionRespondResult` |
| client→server | `subagent/prompt` | `SdkSubagentPromptParams` → `SdkSubagentPromptResult` |
| client→server | `subagent/interrupt` | `SdkSubagentInterruptParams` → `InteractionRespondResult` |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `interaction.request` | `InteractionRequestNotification` |
| server→client | `approval.request` | `ApprovalRequestNotification` |
| server→client | `approval.resolved` | `ApprovalResolvedNotification` |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `session.settled` | `SessionSettledNotification` (negotiated root activity completion) |
| server→client | `session.assistant_stream` | `SessionAssistantStreamNotification` (live assistant stream frame) |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |

`HarnessSdkRequestMap` and `HarnessSdkNotificationMap` index these shapes by method name; the package root exports them together with the transport.

`session/wait` accepts `{ sessionId }` for an existing SDK-owned session and returns `{}` after the root stays idle and progressing managed descendant work finishes. Idle descendants with parked input remain resident without blocking this wait. Unknown ids and live Agent failures without a newer committed terminal are rejected. Notifications committed during the wait precede its response on the same transport; raw `session.status` transitions retain their whole-agent meaning.

### Payload semantics

`SessionPromptResult.messageId` identifies the queued user message; it does not identify a later assistant message, turn ending, or prompt result. `SdkPromptContentBlock` accepts ordinary durable content plus `SdkEncodedImageBlock { type: "image", data, mimeType }`; the server converts encoded images to durable references before enqueue. `InitializeParams.reasoningEffort` is an optional non-empty adapter-owned identifier for the selected provider/model route; omission preserves that model's default. `InitializeParams.maxTokens` is an optional positive safe integer that caps each conversation-model output for SDK-created agents and their in-process descendants; omission lets the selected adapter's exact-model default apply. The server resolves the exact route during initialization and rejects `session/prompt` until that handshake succeeds, so a missing adapter, unavailable model, or unsupported effort cannot fall back to constructor defaults. `SessionAssistantStreamNotification.frame` carries one process-local assistant attempt frame before durable settlement; consumers pair it with later `session.event` settlements through the frame's attempt, turn, step, and outcome fields. `SubagentFinishedNotification.lastAssistantMessage` carries the child's last non-empty assistant message, or its accumulated assistant text when no such message exists; the field is absent when the child produced neither. `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`. Notification payloads depend on `AssistantStreamFrame` (`dsh-agent`), `SessionEvent` (`dsh-session`), `ContentBlock` (`dsh-llm`), and `SubagentStopReason` (`dsh-subagent`), so the live and durable session vocabulary is part of the wire contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design behind the wire library; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The package is built on one separation: a single newline-delimited transport class shared by both wire ends, and named types that index the protocol methods. The package root is the only import surface — source modules are not exported as deep imports. It is a pure library with no plugin, config, or registration; the serving plugin and the clients own all behavior around it.

### Source map

| File | Role |
|---|---|
| [`src/transport.ts`](src/transport.ts) | `JsonRpcLineTransport`: line framing, request/response/notification dispatch, error mapping, pending-request bookkeeping |
| [`src/types.ts`](src/types.ts) | Named request/result and notification payload types, indexed by method |
| [`src/index.ts`](src/index.ts) | Consumer interface: the transport and the named wire types |

### Frame dispatch

Incoming lines are parsed one at a time: a frame with `id` and `method` is answered through the request handler (or `-32601`), a frame with `id` alone resolves the matching pending request (an error frame rejects it with `JsonRpcResponseError`), and a frame with `method` alone is handed to the notification handler. `start()` attaches the input listeners; `close()` detaches them and fails every pending request without destroying the streams.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the wire contract is not enough. They move from the serving plugin to the clients and the runnable application.

- [JSON-RPC serving plugin](../server/README.md) — the runtime plugin that serves this protocol over stdio.
- [TypeScript SDK client](../client/README.md) — the client that drives this protocol.
- [Python SDK](../../../python/README.md) — the Python counterpart that mirrors these shapes.
- [SDK application bundle](../../bundle/sdk-app/README.md) — the `dsh --profile sdk` application that boots the server.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a client-facing wire library; the runtime plugins behind the serving entry own all model-facing behavior.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the protocol does not cover or promise. They are current package constraints, not a comparison with other wire formats or a task backlog.

- **No protocol-version negotiation** — the handshake carries only `serverInfo.version` (`0.0.1`, unvalidated by clients); pre-release stance, no compatibility promise.
- **No root-cancel or session-close methods** — a client abandons root execution by closing the runtime process; see the [JSON-RPC serving plugin](../server/README.md).
- **Server→client requests are a dead capability** — the transport supports them, but the server never sends one; approval uses notifications and client-to-server replies.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative — shipped behavior and limits live in the sections above and in the code. This protocol's shapes are mirrored (not imported) by the Python SDK, so changing a method, payload, or the wire-stable `serverInfo.name` here requires updating the Python counterpart and the TypeScript client in the same change. No other unresolved design questions are recorded.

</details>
