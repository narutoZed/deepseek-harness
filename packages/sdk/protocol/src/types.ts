/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: its
 * request/result pairs and server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequest } from '@deepseek-ai/dsh-subagent'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional adapter-owned reasoning effort for the selected provider/model route. */
  reasoningEffort?: ReasoningEffortId
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
  /** Optional runtime features; absence preserves compatibility with older runtimes. */
  capabilities?: { sessionTreeSettled?: boolean; approvalResponses?: boolean; subagentControl?: boolean }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: SdkPromptContentBlock[]
  /** Optional caller identity retained on the logged user source. */
  requestId?: string
}

/** Runtime input admitted at the nearest step of an already-running session. */
export interface SessionSteerParams extends SessionPromptParams {
  /** Stable retry identity, persisted as the user message source rpcId. */
  requestId: string
}

/** A portable attachment in a bounded internal fork snapshot. */
export interface SdkForkResource {
  kind: 'image' | 'file'
  ref: Record<string, unknown>
  data: string
}

/** Complete seed data transported between trusted SDK runtimes. */
export interface SessionForkSnapshot {
  sourceSessionId: string
  cwd?: string
  events: SessionEvent[]
  resources: SdkForkResource[]
}

/** Select a completed turn prefix with a bounded export size. */
export interface SessionExportParams {
  sessionId: string
  turn: number
  endedAt?: number
  maxBytes: number
}

/** Import a portable seed into a caller-authorized destination session. */
export interface SessionForkParams {
  sessionId: string
  snapshot: SessionForkSnapshot
  maxBytes: number
}

/** Destination identity and constructor events returned after a fork. */
export interface SessionForkResult {
  sessionId: string
  events: SessionEvent[]
}

/** Inline raster input admitted into the runtime's durable attachment store. */
export interface SdkEncodedImageBlock {
  type: 'image'
  /** Canonical base64-encoded raster bytes. */
  data: string
  /** Declared raster MIME type, verified during admission. */
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/** SDK prompt input: ordinary durable blocks plus inline images awaiting admission. */
export type SdkPromptContentBlock = ContentBlock | SdkEncodedImageBlock

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Wait for an existing SDK session and its managed descendants to finish. */
export interface SessionWaitParams {
  /** An SDK-owned session id; waiting never creates a session. */
  sessionId: string
}

/** Session whose effective working directory is requested; an unknown id creates the Session. */
export interface SessionWorkingDirectoryParams {
  /** SDK-side Session identity. */
  sessionId: string
}

/** Change one Session's effective directory without changing its origin or permissions. */
export interface SessionWorkingDirectorySetParams extends SessionWorkingDirectoryParams {
  /** Directory to enter; relative paths resolve against the Session's current directory. */
  path: string
}

/** Validated effective directory after a read, change, or missing-directory recovery. */
export interface SessionWorkingDirectoryResult {
  /** Absolute directory used by future independent operations and new processes. */
  cwd: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** An SDK-owned root activity is idle with no pending wakeup or native descendant run. */
export interface SessionSettledNotification {
  /** Root session whose current activity interval has settled. */
  sessionId: string
  /** Native completion failure without a durable terminal; clients must reject this run. */
  error?: string
}

/** `session.assistant_stream` payload: one live assistant stream frame for a session. */
export interface SessionAssistantStreamNotification {
  /** Session whose live assistant attempt emitted the frame. */
  sessionId: string
  /** Process-local assistant stream frame emitted before durable settlement. */
  frame: AssistantStreamFrame
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
  /** Creation label from the child's durable descriptor; never parsed from tool output. */
  label?: string
  /** Supported descriptor mode, omitted when no compatible descriptor is available. */
  mode?: 'one-shot' | 'continuable'
  /** Subagent provider such as spawn or fork, not the child's LLM route. */
  provider?: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** One question presented by an SDK host to its user. */
export interface SdkUserQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

/** A pending user question owned by the identified session. */
export interface InteractionRequestNotification {
  sessionId: string
  interactionId: string
  questions: SdkUserQuestion[]
}

/** Answers keyed by the question ids in an interaction request. */
export interface InteractionRespondParams {
  interactionId: string
  answers: { id: string; selected: string[]; custom?: string }[]
}

/** Acceptance of a response to a pending interaction. */
export interface InteractionRespondResult {
  accepted: true
}

/** One pending native permission decision, independent of user questions. */
export interface ApprovalRequestNotification {
  sessionId: string
  interactionId: string
  toolName: string
  callId?: string
  reason?: string
}

/** A permission question that was answered or withdrawn by its owner. */
export interface ApprovalResolvedNotification {
  sessionId: string
  interactionId: string
  outcome: 'allowed-once' | 'rejected' | 'cancelled'
}

/** Answer one exact session's pending permission request. */
export interface ApprovalRespondParams {
  sessionId: string
  interactionId: string
  decision: 'approved' | 'cancelled'
}

/** Human input for a continuable descendant under an SDK-owned root. */
export interface SdkSubagentPromptParams {
  rootSessionId: string
  parentSessionId: string
  childSessionId: string
  requestId: string
  content: SubagentPromptRequest['content']
  clientTimeZone?: string
}

/** A subagent inbox receipt and in-process retry result. */
export interface SdkSubagentPromptResult extends SessionPromptResult {
  replayed: boolean
}

/** Cancel only one continuable descendant under an SDK-owned root. */
export interface SdkSubagentInterruptParams {
  rootSessionId: string
  parentSessionId: string
  childSessionId: string
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'session.settled': SessionSettledNotification
  'session.assistant_stream': SessionAssistantStreamNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
  'interaction.request': InteractionRequestNotification
  'approval.request': ApprovalRequestNotification
  'approval.resolved': ApprovalResolvedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/wait': { params: SessionWaitParams; result: Record<string, never> }
  'session/working-directory/get': { params: SessionWorkingDirectoryParams; result: SessionWorkingDirectoryResult }
  'session/working-directory/set': { params: SessionWorkingDirectorySetParams; result: SessionWorkingDirectoryResult }
  'session/steer': { params: SessionSteerParams; result: SessionPromptResult }
  'session/export': { params: SessionExportParams; result: SessionForkSnapshot }
  'session/fork': { params: SessionForkParams; result: SessionForkResult }
  'interaction/respond': { params: InteractionRespondParams; result: InteractionRespondResult }
  'session/is-live': { params: { rootSessionId: string; sessionId: string }; result: { live: boolean } }
  'approval/respond': { params: ApprovalRespondParams; result: InteractionRespondResult }
  'subagent/prompt': { params: SdkSubagentPromptParams; result: SdkSubagentPromptResult }
  'subagent/interrupt': { params: SdkSubagentInterruptParams; result: InteractionRespondResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
