# Agent Note: SDK session-tree settlement

Status: implemented

English | [中文](2026-09-05-sdk-session-tree-settlement.zh.md)

## Problem

High-level SDK runs returned at the first root idle while background children or parent follow-up work remained active. Consumers duplicated runtime lifecycle bookkeeping and could miss asynchronous provider preparation.

## Decision

The server advertises a session-tree settlement capability and publishes an additive completion notification from native preparation, run, inbox and status events. Preparation uses a process-local symbol token, preserving published run identities. Both clients wait for the negotiated marker by default and expose an explicit first-idle option; old runtimes keep legacy behavior.

## Alternatives considered

**Client-side child counters.** Creation is not accepted work, and transport consumers cannot reliably reconstruct provider preparation or native run epochs.

**Delay after idle.** A grace period cannot establish that work has completed.

## Consequences

Consumers can remove their session-tree run wrapper after upgrading the paired runtime and client. Raw driver status and per-prompt admission remain unchanged. Native settlement does not promise resource disposal or synthesize parent output. Deterministic lifecycle tests cover preparation failure, handoff, nested epochs and inbox wakeups; a gated real SDK process covers a background child followed by parent synthesis.
