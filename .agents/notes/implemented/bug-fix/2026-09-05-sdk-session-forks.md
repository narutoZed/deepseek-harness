# Agent Note: Portable SDK session forks

Status: implemented

English | [中文](2026-09-05-sdk-session-forks.zh.md)

## Problem

Mesh uses isolated runtime homes, so a completed conversation prefix must cross a process boundary without replaying prompts.

## Decision

Add bounded native export/import with attachment rewriting, cold persistence reads, and repeat-import checks. Preserve the existing native settlement and child metadata paths while integrating forks. Asynchronous observation leases hold a consistent source prefix. Failed admission releases newly acquired destination handles, and shutdown joins pending fork creation before disposing owned sessions. Retrying an already owned destination preserves its live failure diagnostics.

## Alternatives considered

Reconstructing prompts loses native event and attachment identity.

## Consequences

Real-process tests verify fork continuation after restart, alongside native child settlement. The caller retains tenant and workspace authorization.
