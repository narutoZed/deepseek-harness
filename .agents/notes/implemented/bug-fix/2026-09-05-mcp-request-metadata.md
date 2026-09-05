# Agent Note: Trusted MCP request metadata

Status: implemented

English | [中文](2026-09-05-mcp-request-metadata.zh.md)

## Problem

Trusted MCP servers need authorized request metadata separately from model-authored tool arguments.

## Decision

Carry the host-owned immutable requestMeta snapshot in tools/call.params._meta, including reconnect generations.

## Alternatives considered

Merging identity into tool arguments would expose transport concerns in the model schema.

## Consequences

Default calls are unchanged. MCP tests verify arguments and metadata separately; the host owns identity precedence and transport secrets.
