# Agent Note: Mesh SDK upstream integration

Status: implemented

English | [中文](2026-09-08-mesh-sdk-upstream-integration.zh.md)

## Problem

Mesh depends on native session forks, durable resume, steering, human responses, streamed assistant events, subagent metadata, and session-tree settlement that are maintained in this fork. Upstream releases change the persistence API independently of these SDK extensions.

## Decision

The fork integrates upstream source while retaining the SDK extensions and their public capability negotiation. Session export selects a completed-turn prefix from an asynchronous, live-preferred observation; cold reads use the native version migration and storage reader. It preserves the source session and imports the selected prefix into independent storage.

The runtime context heading is `权限：`. File-policy descriptions use `Current file policy`; the workspace-write description states the resolved session workspace. These text changes preserve the policy resolver, approval enforcement, snapshot attribution, and suppression behavior. Historical messages retain their original text; a different current snapshot is appended through the existing projection.

Python SDK source and deployed runtimes are built from the same integrated revision. A package version alone does not identify the fork's extensions.

## Alternatives considered

Replacing the fork with the upstream release removes SDK operations that Mesh uses. Keeping the previous runtime with the new Python package leaves runtime behavior outside the version guarantee. Retaining the previous cold-export implementation misinterprets the persistence read result and fails before a fork can be created.

## Consequences

Upstream fixes and the fork's SDK behavior share one build. SDK tests cover cold export, independent fork continuation, capability negotiation, native settlement, one-use approvals, descendant controls, and deployment-scoped writable directories. Model-visible prompt expectations track the customized wording without rewriting historical session generations.
