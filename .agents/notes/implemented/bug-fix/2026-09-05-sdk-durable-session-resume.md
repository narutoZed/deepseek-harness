# Agent Note: Resume durable SDK sessions

Status: implemented

English | [中文](2026-09-05-sdk-durable-session-resume.zh.md)

## Problem

Replacing an SDK process loses its in-memory session map. Prompting a retained session id then fails with an already-exists error instead of continuing the persisted conversation.

## Decision

The SDK server creates a session on first use and resumes that exact id when the session service reports its exact already-exists error. Other creation failures propagate unchanged. Concurrent prompts retain the existing per-id creation promise.

## Alternatives considered

**Allocate another id.** This abandons the user's conversation history.

**Catch every creation failure.** This hides permission, storage and malformed-session failures behind an unrelated resume attempt.

## Consequences

A host can replace the runtime process without copying or replaying conversation text. The SDK still has no independent history-query API. The server regression and the shipped SDK profile restart test verify retained identity and prior messages. The exact error match remains necessary until the session service exposes typed create-or-resume failure information.
