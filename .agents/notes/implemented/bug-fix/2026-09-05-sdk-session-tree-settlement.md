# Agent Note: SDK session-tree settlement

Status: implemented

English | [中文](2026-09-05-sdk-session-tree-settlement.zh.md)

## Problem

High-level SDK runs returned at the first root idle while background children or parent follow-up work remained active. Consumers duplicated runtime lifecycle bookkeeping and could miss asynchronous provider preparation.

## Decision

The server advertises a session-tree settlement capability and publishes an additive completion notification after the native root and descendant waiter finishes. The native manager owns preparation and execution lifetimes, including idle parked children that must not block completion. SDK activity revisions prevent an earlier waiter from completing a newly admitted interval. Both clients wait for the negotiated marker by default and expose an explicit first-idle option; old runtimes keep legacy behavior. Native failures without a durable terminal are reported through `session.settled.error` and reject the client run.

## Alternatives considered

**Client-side child counters.** Creation is not accepted work, and transport consumers cannot reliably reconstruct provider preparation or native run epochs.

**Delay after idle.** A grace period cannot establish that work has completed.

## Consequences

Consumers can remove their session-tree run wrapper after upgrading the paired runtime and client. Raw driver status and per-prompt admission remain unchanged. Native settlement does not promise resource disposal or synthesize parent output. Deterministic tests cover concurrent admission, independent roots, failure reporting, inbox wakeups, and quiescent observer shutdown; a gated real SDK process covers a background child followed by parent synthesis.
