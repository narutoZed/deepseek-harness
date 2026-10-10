/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { admitEncodedImages, type EncodedImageAttachment, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionLogOffset, SessionSeq, snapshotSessionEvent, type Session, type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionObservationReader, SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-projection'
import { sdkChildMetadataProjection } from './child-metadata.ts'
import { assertForkBudget, exportFork, importFork } from './fork.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import { SdkSessionSettlement } from './session-settlement.ts'
import { SdkApprovals } from './approvals.ts'
import { SdkSubagentControl } from './subagent-control.ts'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {
  ApprovalRespondParams,
  SdkSubagentPromptParams,
  SdkSubagentInterruptParams,
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
  SessionExportParams,
  SessionForkParams,
  SessionForkResult,
  SessionForkSnapshot,
  SdkForkResource,
  SessionPromptResult,
  SessionWaitParams,
  SessionWorkingDirectoryParams,
  SessionWorkingDirectorySetParams,
  SessionWorkingDirectoryResult,
  SdkEncodedImageBlock,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
  /** Latest live failure not superseded by a subsequently committed terminal. */
  failure: { readonly error: unknown; readonly atOffset: SessionLogOffset } | undefined
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
  private readonly observations: SessionObservationReader
  private readonly settlement: SdkSessionSettlement
  private readonly approvals: SdkApprovals
  private readonly subagentControl: SdkSubagentControl
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly steers = new Map<string, { content: string; result: Promise<SessionPromptResult> }>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly forkCreations = new Set<Promise<SessionForkResult>>()
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
    this.observations = new SessionObservationReader(ctx, SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE)
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined) this.disposers.push(projections.register(sdkChildMetadataProjection))
    this.settlement = new SdkSessionSettlement(async (sessionId) => {
      await this.wait({ sessionId })
    }, (sessionId, error) => {
      const payload: SessionSettledNotification = { sessionId, ...(error === undefined ? {} : { error: error.message }) }
      this.transport.notify('session.settled', payload)
    })
    this.approvals = new SdkApprovals(ctx, transport, agent => this.ownsAgent(agent))
    this.subagentControl = new SdkSubagentControl(ctx, async (id) => {
      if (!this.initialized || this.shuttingDown) throw new Error('SDK server is not active')
      const rec = await this.getOrCreateSession(id)
      this.assertLiveAgent(rec, id)
      return rec.handle.agent
    }, this.settlement)
    const settlement = this.settlement
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const record = this.sessions.get(session.id)
      if (event.type === 'turn/end' && record?.handle.agent.session === session
        && record.failure !== undefined && event.seq >= record.failure.atOffset) {
        record.failure = undefined
      }
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
      if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-turn') {
        settlement.inbox(String(session.id), event.data.inserted.length, event.data.removedCount ?? 0)
      }
    }))
    this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
      const record = this.sessions.get(agent.session.id)
      if (record?.handle.agent !== agent) return
      record.failure = { error, atOffset: agent.session.seq }
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
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined
          ? {}
          : { lastAssistantMessage: [...info.lastAssistantMessage] }),
      }
      transport.notify('subagent.finished', payload)
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
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek)
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
      capabilities: { sessionTreeSettled: true, approvalResponses: this.ctx.get('approval') !== undefined,
        subagentControl: this.ctx.get('subagents') !== undefined },
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
   * Wait for an existing owned Agent and its managed descendants to finish.
   * The response follows all Session notifications emitted during the wait.
   * Rejects a live Agent failure that has no subsequent durable terminal.
   * @param params - the SDK-owned session to observe without creating one.
   * @returns an empty result after the root stays idle across the descendant check.
   */
  async wait(params: SessionWaitParams): Promise<Record<string, never>> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = this.sessions.get(params.sessionId)
    if (rec === undefined) throw new Error(`unknown SDK session: ${params.sessionId}`)
    const agent = rec.handle.agent
    const subagents = this.ctx.get('subagents')
    while (true) {
      this.assertLiveAgent(rec, params.sessionId)
      await agent.whenIdle()
      const idleSeq = agent.session.seq
      const children = await subagents?.waitForChildren(agent)
      this.assertLiveAgent(rec, params.sessionId)
      if (!children && agent.status === 'idle' && agent.session.seq === idleSeq) {
        if (rec.failure !== undefined) throw rec.failure.error
        return {}
      }
    }
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

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
  }

  private assertRunningAgent(rec: SessionRecord, sessionId: string): void {
    this.assertLiveAgent(rec, sessionId)
    if (this.shuttingDown || rec.handle.agent.status !== 'running') {
      throw new Error('session/steer requires a running session')
    }
  }

  /**
   * Export an existing completed turn without starting a model request.
   * @param params - Source identity, completed turn, optional timestamp and byte budget.
   * @returns A portable seed with all referenced attachment bytes.
   */
  async exportSession(params: SessionExportParams): Promise<SessionForkSnapshot> {
    if (!this.initialized || this.shuttingDown) throw new Error('SDK server is not active')
    const rec = this.sessions.get(params.sessionId)
    if (rec !== undefined) this.assertLiveAgent(rec, params.sessionId)
    else if (this.ctx.get('sessionPersistence') === undefined) throw new Error('session export requires persistence')
    const id = brandString<SessionId>(params.sessionId)
    using observed = await this.observations.read(id, { projectionMode: 'none' })
    return await exportFork(this.ctx, { id, header: observed.header, events: observed.events },
      params.turn, params.maxBytes, params.endedAt)
  }

  /**
   * Create an ordinary seeded conversation; the core validates balanced history.
   * @param params - New session identity, exported seed and byte budget.
   * @returns The created session identity and full constructor history for replay.
   */
  async forkSession(params: SessionForkParams): Promise<SessionForkResult> {
    if (!this.initialized || this.shuttingDown) throw new Error('SDK server is not active')
    const creation = this.createFork(params)
    this.forkCreations.add(creation)
    try { return await creation }
    finally { this.forkCreations.delete(creation) }
  }

  private async createFork(params: SessionForkParams): Promise<SessionForkResult> {
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) throw new TypeError('sessionId is required')
    const seed = await importFork(this.ctx, params.snapshot, params.maxBytes)
    this.assertNotShuttingDown()
    const existing = this.sessions.get(params.sessionId)
    let handle = existing?.handle
    let acquired = false
    try {
      if (handle === undefined) {
        try {
          handle = await this.ctx.agents.create({
            sessionId: brandString<SessionId>(params.sessionId), seed,
            inheritedEventCount: SessionLogOffset(seed.length),
            meta: { cwd: this.cwd, parentSession: brandString<SessionId>(params.snapshot.sourceSessionId), isSeeded: true },
            agentOptions: this.agentOptions(),
          })
        } catch (error) {
          if (!(error instanceof Error && error.message === `session "${params.sessionId}" already exists`)) throw error
          handle = await this.ctx.agents.resume({
            resumeSessionId: brandString<SessionId>(params.sessionId), agentOptions: this.agentOptions(),
          })
        }
        acquired = true
      }
      this.assertNotShuttingDown()
      const session = handle.agent.session
      using observed = await this.observations.read(session.id, { projectionMode: 'none' })
      this.assertNotShuttingDown()
      if (session.header.parentSession !== params.snapshot.sourceSessionId
        || session.inheritedEventCount !== seed.length
        || !isDeepStrictEqual(observed.events.slice(0, seed.length), seed)) {
        throw new Error('fork target already contains different history')
      }
      this.sessions.set(params.sessionId, existing ?? { handle, failure: undefined })
      return { sessionId: params.sessionId, events: [...observed.events] }
    } catch (error: unknown) {
      if (acquired && handle !== undefined) {
        try { await handle.dispose() }
        catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], 'SDK fork admission and cleanup failed') }
      }
      throw error
    }
  }

  private agentOptions() {
    return {
      provider: this.provider, model: this.model,
      ...(this.reasoningEffort === undefined ? {} : { reasoningEffort: this.reasoningEffort }),
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    }
  }

  private ownsAgent(agent: Agent): boolean {
    if (!this.initialized || this.shuttingDown || this.ctx.agents.get(agent.id) !== agent) return false
    return [...this.sessions.keys()].some(root => this.settlement.belongsTo(String(agent.session.id), root))
  }


  private assertLiveAgent(rec: SessionRecord, sessionId: string): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /**
   * Read a Session's effective directory, recovering a missing directory to its origin.
   * @param params - target Session; an unknown id creates it.
   * @returns the absolute effective directory.
   */
  async getWorkingDirectory(params: SessionWorkingDirectoryParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.ensure(agent) }
  }

  /**
   * Change a Session's directory and queue its model-visible transition.
   * @param params - target Session and absolute or current-directory-relative path.
   * @returns the validated absolute directory; origin and permissions are unchanged.
   */
  async setWorkingDirectory(params: SessionWorkingDirectorySetParams): Promise<SessionWorkingDirectoryResult> {
    const agent = await this.workingDirectoryAgent(params.sessionId)
    return { cwd: await this.ctx.workingDirectory.set(agent, params.path) }
  }

  private async workingDirectoryAgent(sessionId: string): Promise<Agent> {
    if (!this.initialized) throw new Error('SDK server is not initialized')
    const rec = await this.getOrCreateSession(sessionId)
    this.assertLiveAgent(rec, sessionId)
    return rec.handle.agent
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * Managed descendants drain before the root Agent handles and adapter are released.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const failures: unknown[] = []
    this.settlement.close()
    try { this.approvals.close() } catch (error) { failures.push(error) }
    try { await this.subagentControl.close() } catch (error) { failures.push(error) }
    const pendingCreations = [...this.sessionCreations.values(), ...this.forkCreations]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    this.steers.clear()
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
    try {
      await this.ctx.get('subagents')?.drainDescendants(records.map(rec => rec.handle.agent))
    } catch (error: unknown) {
      failures.push(error)
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    await this.settlement.drain()
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
      case 'session/wait': {
        const sessionId = params?.sessionId
        if (typeof sessionId !== 'string') throw new TypeError('session/wait requires a sessionId string')
        return this.wait({ sessionId })
      }
      case 'session/working-directory/get':
      case 'session/working-directory/set': {
        if (typeof params?.sessionId !== 'string' || params.sessionId.length === 0) {
          throw new TypeError('working-directory requests require a non-empty sessionId')
        }
        if (method === 'session/working-directory/get') {
          return this.getWorkingDirectory({ sessionId: params.sessionId })
        }
        if (typeof params.path !== 'string') throw new TypeError('working-directory set requires a path string')
        return this.setWorkingDirectory({ sessionId: params.sessionId, path: params.path })
      }
      case 'session/steer':
        return this.steer(parseSteer(params))
      case 'session/export':
        return this.exportSession(parseExport(params))
      case 'session/fork':
        return this.forkSession(parseFork(params))
      case 'session/is-live': {
        const root = params?.rootSessionId
        const id = params?.sessionId
        if (typeof root !== 'string' || typeof id !== 'string' || !root || !id) throw new TypeError('session/is-live requires rootSessionId and sessionId')
        return { live: this.sessions.has(root) && this.settlement.belongsTo(id, root)
          && this.ctx.agents.get(brandString<SessionId>(id)) !== undefined }
      }
      case 'approval/respond':
        return this.approvals.respond(parseApproval(params))
      case 'subagent/prompt':
        return this.subagentControl.prompt(parseSubagentPrompt(params))
      case 'subagent/interrupt':
        return this.subagentControl.interrupt(parseChildAddress(params))
      case 'interaction/respond':
        return this.respondInteraction(parseInteraction(params))
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private respondInteraction(params: InteractionRespondParams): InteractionRespondResult {
    const pending = this.pendingInteractions.get(params.interactionId)
    if (pending === undefined) throw new Error('interaction is not pending')
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
    const registry = this.ctx.get('sessionProjections')
    const descriptor = registry?.stateOf(session, 'sdkChildMetadata')
    if (descriptor === undefined) throw new Error('SDK child metadata requires its Session projection')
    if (descriptor === null || !session.isOwnSeq(descriptor.seq)) return {}
    return {
      mode: descriptor.mode, provider: descriptor.provider,
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    }
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-preset-registry README, "Composing a child agent").
    const id = brandString<SessionId>(sessionId)
    const agentOptions = this.agentOptions()
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
    const rec: SessionRecord = { handle, failure: undefined }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}

/** Read one required nonempty string at the SDK wire boundary. */
function requestString(params: Record<string, unknown> | undefined, name: string): string {
  const value = params?.[name]
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`SDK request requires ${name}`)
  return value
}

/** Admit a content array; the native inbox validates each durable message before publication. */
function requestContent(params: Record<string, unknown> | undefined, name: string): ContentBlock[] {
  const value = params?.[name]
  if (!Array.isArray(value) || value.length === 0
    || value.some((block: unknown) => block === null || typeof block !== 'object' || !('type' in block) || typeof block.type !== 'string')) {
    throw new TypeError(`SDK request requires non-empty ${name}`)
  }
  return value as ContentBlock[]
}

function parseSteer(params: Record<string, unknown> | undefined): SessionSteerParams {
  return { sessionId: requestString(params, 'sessionId'), requestId: requestString(params, 'requestId'),
    contentBlocks: requestContent(params, 'contentBlocks') }
}

function parseExport(params: Record<string, unknown> | undefined): SessionExportParams {
  if (typeof params?.turn !== 'number' || typeof params.maxBytes !== 'number'
    || (params.endedAt !== undefined && typeof params.endedAt !== 'number')) {
    throw new TypeError('session/export requires turn, maxBytes and an optional numeric endedAt')
  }
  return { sessionId: requestString(params, 'sessionId'), turn: params.turn, maxBytes: params.maxBytes,
    ...(params.endedAt === undefined ? {} : { endedAt: params.endedAt }) }
}

function parseFork(params: Record<string, unknown> | undefined): SessionForkParams {
  const snapshot = params?.snapshot
  if (typeof params?.maxBytes !== 'number' || snapshot === null || typeof snapshot !== 'object'
    || !('sourceSessionId' in snapshot) || typeof snapshot.sourceSessionId !== 'string'
    || !('events' in snapshot) || !Array.isArray(snapshot.events)
    || !('resources' in snapshot) || !Array.isArray(snapshot.resources)
    || ('cwd' in snapshot && typeof snapshot.cwd !== 'string')) {
    throw new TypeError('session/fork requires a bounded snapshot')
  }
  assertForkBudget(snapshot, params.maxBytes)
  return { sessionId: requestString(params, 'sessionId'), maxBytes: params.maxBytes,
    snapshot: { sourceSessionId: snapshot.sourceSessionId,
      events: parseForkEvents(snapshot.events), resources: parseForkResources(snapshot.resources),
      ...('cwd' in snapshot && typeof snapshot.cwd === 'string' ? { cwd: snapshot.cwd } : {}) } }
}

function parseApproval(params: Record<string, unknown> | undefined): ApprovalRespondParams {
  if (params?.decision !== 'approved' && params?.decision !== 'cancelled') {
    throw new TypeError('approval/respond requires approved/cancelled decision')
  }
  return { sessionId: requestString(params, 'sessionId'), interactionId: requestString(params, 'interactionId'), decision: params.decision }
}

function parseChildAddress(params: Record<string, unknown> | undefined): SdkSubagentInterruptParams {
  return { rootSessionId: requestString(params, 'rootSessionId'), parentSessionId: requestString(params, 'parentSessionId'),
    childSessionId: requestString(params, 'childSessionId') }
}

function parseSubagentPrompt(params: Record<string, unknown> | undefined): SdkSubagentPromptParams {
  if (params?.clientTimeZone !== undefined && typeof params.clientTimeZone !== 'string') {
    throw new TypeError('subagent/prompt clientTimeZone must be a string')
  }
  return { ...parseChildAddress(params), requestId: requestString(params, 'requestId'), content: parseChildContent(params?.content),
    ...(params?.clientTimeZone === undefined ? {} : { clientTimeZone: params.clientTimeZone }) }
}

function parseInteraction(params: Record<string, unknown> | undefined): InteractionRespondParams {
  if (!Array.isArray(params?.answers)) throw new TypeError('interaction answers require an id, selected strings and optional custom text')
  const answers = params.answers.map((answer: unknown) => {
    if (answer === null || typeof answer !== 'object' || !('id' in answer) || typeof answer.id !== 'string'
      || !('selected' in answer) || !Array.isArray(answer.selected) || answer.selected.some(value => typeof value !== 'string')
      || ('custom' in answer && typeof answer.custom !== 'string')) throw new TypeError('interaction answers require an id, selected strings and optional custom text')
    return { id: answer.id, selected: answer.selected, ...('custom' in answer && typeof answer.custom === 'string' ? { custom: answer.custom } : {}) }
  })
  return { interactionId: requestString(params, 'interactionId'), answers }
}

/** Child admission uses the native host-prompt vocabulary, including inline image bytes. */
function parseChildContent(value: unknown): SdkSubagentPromptParams['content'] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('subagent/prompt requires non-empty content')
  return value.map((part: unknown) => {
    if (part === null || typeof part !== 'object' || !('type' in part)) throw new TypeError('invalid child content')
    if (part.type === 'text' && 'text' in part && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part.type === 'image' && 'data' in part && typeof part.data === 'string' && 'mediaType' in part
      && (part.mediaType === 'image/png' || part.mediaType === 'image/jpeg' || part.mediaType === 'image/webp' || part.mediaType === 'image/gif')
      && (!('name' in part) || typeof part.name === 'string')) {
      return { type: 'image', mediaType: part.mediaType, data: part.data,
        ...('name' in part && typeof part.name === 'string' ? { name: part.name } : {}) }
    }
    throw new TypeError('invalid child content')
  })
}

function requestRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('SDK request requires an object')
  return value as Record<string, unknown>
}

/** Native event validation precedes attachment writes; Session creation validates the complete history. */
function parseForkEvents(values: readonly unknown[]): SessionEvent[] {
  return values.map((value) => {
    const event = requestRecord(value)
    if (typeof event.type !== 'string' || typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)
      || event.seq < 0 || typeof event.time !== 'number' || !Number.isSafeInteger(event.time)
      || event.data === undefined || (event.ignorable !== undefined && event.ignorable !== true)) {
      throw new TypeError('invalid fork event envelope')
    }
    return snapshotSessionEvent({
      ...event, type: event.type, seq: SessionSeq(event.seq), time: event.time, data: event.data,
    } as SessionEvent)
  })
}

function parseForkResources(values: readonly unknown[]): SdkForkResource[] {
  return values.map((value) => {
    const resource = requestRecord(value)
    if ((resource.kind !== 'image' && resource.kind !== 'file') || typeof resource.data !== 'string') {
      throw new TypeError('invalid fork attachment')
    }
    return { kind: resource.kind, data: resource.data, ref: requestRecord(resource.ref) }
  })
}
