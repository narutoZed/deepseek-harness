# Trusted metadata on MCP tool calls

Mesh needs authorized tenant/session identity and selected request option values
forwarded to a trusted MCP server. The MCP client now accepts optional requestMeta
and places it in tools/call.params._meta without merging it into model arguments.
Connection generations retain the metadata through re-sync and reconnect.
The service owns the allowlist and immutable per-runtime snapshot, so a caller's
metadata cannot override authenticated identity. Default calls remain unchanged.

The MCP client test verifies raw tool name, unchanged arguments and the exact
_meta envelope. Mesh tests cover field selection, identity precedence and keeping
transport secrets out of generated patch files.
