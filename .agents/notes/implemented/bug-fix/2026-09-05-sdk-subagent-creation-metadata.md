# Agent Note: SDK subagent creation metadata

Status: implemented

English | [中文](2026-09-05-sdk-subagent-creation-metadata.zh.md)

## Problem

A child descriptor can be established during setup or restored history before live session-event forwarding starts. An SDK host therefore receives a child id without the label and mode that the Web catalog can read, forcing it to correlate tool calls or parse rendered tool text.

## Decision

The SDK creation notification carries optional label, mode and provider fields projected from the native descriptor reader. The first compatible child-owned descriptor remains authoritative; inherited ancestor descriptors are excluded. Unsupported or malformed metadata does not prevent the lineage notification; private composition fields are excluded.

## Alternatives considered

**Parse tool receipt text.** Presentation text is not a stable metadata API and parallel tool completion makes positional correlation incorrect.

**Replay all constructor events.** This changes event-stream semantics and exposes more state than a creation label needs.

## Consequences

Hosts can remove label reconstruction for new SDK sessions while retaining their own old-log migration. Fields remain optional for plain children and incompatible stored descriptors. Seeded-session tests and real foreground/background subagents verify creation labels, modes and private-field exclusion.
