# Agent Note: SDK human interactions

Status: implemented

English | [中文](2026-09-05-sdk-human-interactions.zh.md)

## Problem

An SDK host cannot answer a runtime-owned user question through prompt submission. Sending another prompt leaves the original tool waiting and adds unrelated model input.

## Decision

The server publishes a session-addressed question notification and owns its pending answer promise until a valid response, abort or shutdown. Python and TypeScript clients expose response methods over the same JSON-RPC operation. Malformed or incomplete responses do not consume the pending question. Permission approval remains a separate capability.

## Alternatives considered

**Submit the answer as another prompt.** This does not settle the waiting tool and changes conversation semantics.

**Mount the Web UI answerer.** An out-of-process SDK host owns presentation and must not depend on browser transport.

## Consequences

Hosts can retain the original agent turn while awaiting user input. Server, both client, and shipped-profile tests cover identity-preserving answers and malformed replies. Shutdown owns listener removal and pending-promise rejection; no interaction survives its runtime.
