# SDK running-session steering

Mesh needs next-step input while a Python SDK run is active. The core already owns this behavior through agent.steer, but the SDK only exposed followup prompts.

Expose session/steer with an identified request and real inbox receipt, reject inactive sessions, and reuse successful or in-flight identical requests within the process. Preserve request identity in source.rpcId so UI pending input can be reconciled against durable user messages. Optional prompt request identity also covers queued followups. No model input is synthesized beyond the supplied content.

Verification: SDK server tests exercise a real agent loop with a gated model endpoint, observe next-step inbox insertion, and assert the next model request receives the text. Stub tests cover idempotent concurrent retries, identity conflicts and idle-session rejection. Python client tests cover the wire request. Existing session format is unchanged.

Runtime binaries must be rebuilt; process-restart recovery of retry receipts remains outside this change.
