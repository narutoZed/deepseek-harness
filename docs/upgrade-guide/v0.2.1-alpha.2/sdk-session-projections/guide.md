---
kind: upgrade-guide
description: "Custom SDK server compositions must provide Session projections for child metadata."
---

# SDK Session projections

English | [中文](guide.zh.md)

## Change

The fork’s SDK server requires `sessions` and `sessionProjections` alongside `agents` and `workingDirectory`. It reads child metadata through a registered projection instead of deprecated synchronous Session history methods. The shipped `sdk` and `sdk-minimal` profiles already provide these services; only custom compositions that omit the projection service need adjustment.

## Migration

1. In the custom profile’s Cordis composition, mount `@deepseek-ai/dsh-session-projection` together with the Session service before the SDK server.
2. Rebuild the runtime and install the matching Python or TypeScript client. The native `session/wait` implementation backs `session.settled`; an idle parked child does not keep a run open.
3. Initialize the SDK and verify `capabilities.sessionTreeSettled`. Run a native child task and confirm its `subagent.started` metadata and the final root `session.settled` notification. Treat a notification containing `error` as a failed completion; the paired clients do this automatically.
