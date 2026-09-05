/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentPrepareInfo, SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { SdkSessionSettlement } from './session-settlement.ts'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  InteractionRequestNotification,
  InteractionRespondParams,
  InteractionRespondResult,
  JsonRpcTransportPeer,
  SessionAssistantStreamNotification,
  SessionEventNotification,
  SessionPromptParams,
  SessionSteerParams,
  SessionSettledNotification,
  SessionPromptResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

interface PendingInteraction {
  sessionId: string
  request: AskUserQuestionRequest
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: Error) => void
  removeAbortListener: () => void
}

function encodedImage(block: SessionPromptParams['contentBlocks'][number]): block is SdkEncodedImageBlock {
  return block.type === 'image' && 'data' in block
}

async function durablePromptContent(ctx: Context, blocks: SessionPromptParams['contentBlocks']): Promise<ContentBlock[]> {
  const images = blocks.filter(encodedImage)
  if (images.length === 0) return blocks as ContentBlock[]
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('SDK image prompt requires an attachment store')
  const refs = await admitEncodedImages(attachments, images.map((image): EncodedImageAttachment => ({
    data: image.data,
    mediaType: image.mimeType,
  })))
  let next = 0
  return blocks.map(block => encodedImage(block)
    ? { type: 'image', attachment: refs[next++] as ImageAttachmentRef }
    : block)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private readonly settlement: SdkSessionSettlement
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly steers = new Map<string, { content: string; result: Promise<SessionPromptResult> }>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly pendingInteractions = new Map<string, PendingInteraction>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private initialized = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    this.settlement = new SdkSessionSettlement((sessionId) => {
      const payload: SessionSettledNotification = { sessionId }
      this.transport.notify('session.settled', payload)
    })
    const settlement = this.settlement
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
      if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') {
        settlement.inbox(String(session.id), event.data.inserted.length, event.data.removedCount ?? 0)
      }
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
      settlement.status(String(agent.session.id), status)
    }))
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      const payload: SessionAssistantStreamNotification = { sessionId: String(agent.session.id), frame }
      this.transport.notify('session.assistant_stream', payload)
    }, { global: true }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      settlement.linkChild(String(session.id), String(parentSession))
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
        ...this.childMetadata(session),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/start', function (this: Scoped<SubagentRuntime>, info: SubagentRunInfo) {
      const parentId = String(subagentParentOf(this).session.id)
      if (info.local) settlement.linkChild(String(info.id), parentId)
      settlement.startSubagent(String(info.runId), parentId)
    }))
    this.disposers.push(ctx.on('subagent/prepare', function (this: Scoped<SubagentRuntime>, info: SubagentPrepareInfo) {
      if (info.phase === 'started') {
        settlement.startSubagent(info.token, String(subagentParentOf(this).session.id))
      } else settlement.endSubagent(info.token)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) {
        settlement.endSubagent(String(info.runId))
        return
      }
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
      settlement.endSubagent(String(info.runId))
    }))
    this.disposers.push(ctx.on('user-questions/request', (request, next) => {
      const agent = request.agent
      if (agent === undefined) return next()
      if (request.signal?.aborted) return Promise.reject(new Error('interaction was aborted'))
      const interactionId = randomUUID()
      const sessionId = String(agent.session.id)
      return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
        const onAbort = (): void => {
          this.pendingInteractions.delete(interactionId)
          reject(new Error('interaction was aborted'))
        }
        request.signal?.addEventListener('abort', onAbort, { once: true })
        this.pendingInteractions.set(interactionId, {
          sessionId,
          request,
          resolve,
          reject,
          removeAbortListener: () => request.signal?.removeEventListener('abort', onAbort),
        })
        const payload: InteractionRequestNotification = {
          sessionId,
          interactionId,
          questions: request.questions.map(question => ({ ...question })),
        }
        transport.notify('interaction.request', payload)
      })
    }))
  }

  /**
   * Validate and configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.reasoningEffort !== undefined
      && (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.length === 0)) {
      throw new TypeError('initialize reasoningEffort must be a non-empty string')
    }
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    const cwd = resolve(params.cwd)
    const provider = params.provider
    const model = params.model
    const reasoningEffort = params.reasoningEffort === undefined
      ? undefined
      : ReasoningEffortId(params.reasoningEffort)
    if (!this.hasAdapterFor(provider)) {
      if (provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    // Adapter presence was read from this service above; a successful fallback mount also requires it.
    const llm = this.ctx.get('llm') as LlmRuntime
    await llm.resolveCallConfig({
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...params.maxTokens === undefined ? {} : { maxTokens: params.maxTokens },
    })
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.maxTokens = params.maxTokens
    this.initialized = true
    return {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      capabilities: { sessionTreeSettled: true },
    }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    if (params.requestId !== undefined && (typeof params.requestId !== 'string' || params.requestId.length === 0)) throw new TypeError('requestId must be a non-empty string')
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery.
    this.assertLiveAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    // Attachment admission crosses an async boundary where shutdown or an
    // agent-loop reload may detach the retained handle.
    this.assertLiveAgent(rec, params.sessionId)
    const message = createUserMessage({
      content,
      source: { kind: 'user', ...(params.requestId === undefined ? {} : { rpcId: params.requestId }) },
    })
    this.settlement.begin(params.sessionId)
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Inject identified user input into a running session at its next step boundary.
   * @param params - Existing session, content and retry identity.
   * @returns The persisted inbox message identity, reused for identical retries.
   */
  steer(params: SessionSteerParams | undefined): Promise<SessionPromptResult> {
    if (!this.initialized || this.shuttingDown) throw new Error('SDK server is not active')
    if (typeof params?.sessionId !== 'string' || typeof params.requestId !== 'string' || params.requestId.length === 0
      || !Array.isArray(params.contentBlocks) || params.contentBlocks.length === 0) {
      throw new TypeError('session/steer requires sessionId, requestId and non-empty contentBlocks')
    }
    const key = JSON.stringify([params.sessionId, params.requestId])
    const content = JSON.stringify(params.contentBlocks)
    const previous = this.steers.get(key)
    if (previous !== undefined) {
      if (previous.content !== content) throw new Error('session/steer requestId was reused with different content')
      return previous.result
    }
    const result = this.deliverSteer(params).catch((error: unknown) => {
      this.steers.delete(key)
      throw error
    })
    this.steers.set(key, { content, result })
    return result
  }

  private async deliverSteer(params: SessionSteerParams): Promise<SessionPromptResult> {
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error('session/steer requires an existing session')
    this.assertRunningAgent(rec, params.sessionId)
    const content = await durablePromptContent(this.ctx, params.contentBlocks)
    this.assertRunningAgent(rec, params.sessionId)
    const message = createUserMessage({ content, source: { kind: 'user', rpcId: params.requestId } })
    rec.handle.agent.steer(message)
    return { messageId: message.id }
  }

  private assertRunningAgent(rec: SessionRecord, sessionId: string): void {
    this.assertLiveAgent(rec, sessionId)
    if (this.shuttingDown || rec.handle.agent.status !== 'running') {
      throw new Error('session/steer requires a running session')
    }
  }

  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    this.settlement.close()
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    this.steers.clear()
    const failures: unknown[] = []
    for (const pending of this.pendingInteractions.values()) {
      pending.removeAbortListener()
      pending.reject(new Error('SDK server is shutting down'))
    }
    this.pendingInteractions.clear()
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/steer':
        return this.steer(params as unknown as SessionSteerParams)
      case 'interaction/respond':
        return this.respondInteraction(params as unknown as InteractionRespondParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private respondInteraction(params: InteractionRespondParams): InteractionRespondResult {
    const pending = this.pendingInteractions.get(params.interactionId)
    if (pending === undefined) throw new Error('interaction is not pending')
    if (!Array.isArray(params.answers) || params.answers.some((answer: unknown) => {
      if (answer === null || typeof answer !== 'object') return true
      const value = answer as Record<string, unknown>
      return typeof value.id !== 'string' || !Array.isArray(value.selected)
        || value.selected.some(item => typeof item !== 'string')
        || (value.custom !== undefined && typeof value.custom !== 'string')
    })) {
      throw new TypeError('interaction answers require an id, selected strings and optional custom text')
    }
    const expected = new Set(pending.request.questions.map(question => question.id))
    if (params.answers.length !== expected.size
      || params.answers.some(answer => !expected.delete(answer.id))) {
      throw new Error('interaction response must answer every question exactly once')
    }
    this.pendingInteractions.delete(params.interactionId)
    pending.removeAbortListener()
    pending.resolve({ answers: params.answers })
    return { accepted: true }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private childMetadata(session: Session): Pick<SubagentStartedNotification, 'label' | 'mode' | 'provider'> {
    try {
      const descriptor = foldSubagentDescriptor(session.ownEvents())
      if (descriptor === undefined) return {}
      return {
        mode: descriptor.mode,
        provider: descriptor.provider,
        ...descriptor.label === undefined ? {} : { label: descriptor.label },
      }
    } catch (error: unknown) {
      // Optional display metadata must not prevent publication of the child identity.
      this.ctx.logger.warn('SDK child descriptor could not be read: %s', error)
      return {}
    }
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const id = brandString<SessionId>(sessionId)
    const agentOptions = {
      provider: this.provider,
      model: this.model,
      ...this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort },
      ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
    }
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId: id,
        meta: { cwd: this.cwd },
        agentOptions,
      })
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message === `session "${sessionId}" already exists`)) {
        throw error
      }
      handle = await this.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions,
      })
    }
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
