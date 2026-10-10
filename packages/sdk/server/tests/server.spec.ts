import { MESSAGES_RESPONSE } from './messages-response.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { createUserMessage, MessageId, LlmAdapter, LlmAttemptId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { randomUUID } from 'node:crypto'
import AgentRegistry, { type Agent, type AgentHandle, type AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createInboxStub, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { Session, SessionId, SessionSeq, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SubagentRuntime, { SubagentRunId, type SubagentStartRequest, type SubagentRun, type SubagentResult, type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

/** Full protocol Agent fixture whose inbox and Session keep the native data types. */
function fixtureAgent(options: Partial<Agent> & Pick<Agent, 'id'>): Agent {
  const { id, ...overrides } = options
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const inbox = createInboxStub()
  return {
    ctx, id, session: Session.create(id), options: {}, status: 'idle', inbox,
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
    send: (message, target) => { inbox.append(target, message) },
    cancel: () => { inbox.clear() }, whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    ...overrides,
  }
}

/** Real Cordis context with only registry calls replaced for protocol isolation. */
async function fixtureContext(methods: Partial<Pick<AgentRegistry, 'create' | 'resume' | 'get'>> = {}): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(AgentRegistry)
  for (const [key, value] of Object.entries(methods)) Object.defineProperty(ctx.agents, key, { value, configurable: true })
  return ctx
}

class FakeTransport implements JsonRpcTransportPeer {
  notifications: { method: string; params?: Record<string, unknown> }[] = []

  async request(method: string, params: object): Promise<unknown> {
    throw new Error(`the SDK server should not call host JSON-RPC method ${method} with ${JSON.stringify(params)}`)
  }

  notify(method: string, params?: object): void {
    this.notifications.push(params === undefined ? { method } : { method, params: params as Record<string, unknown> })
  }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function mockCompletionServer(beforeReply?: () => Promise<void>): Promise<{ url: string; requests: unknown[]; headers: IncomingMessage['headers'][] }> {
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const send = (): void => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(MESSAGES_RESPONSE)
      }
      if (beforeReply === undefined) send()
      else void beforeReply().then(send, (error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      })
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

async function makeHarness(storageDir: string, workingDirectory = false) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { workingDirectory })
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  await new Promise(resolve => setTimeout(resolve, 50))
  return ctx
}

/** Feed SDK lifecycle inputs without coupling protocol projection tests to activation admission. */
async function startLifecycleFixture(
  ctx: Context, providerName: string, request: SubagentStartRequest, local = false,
): Promise<SubagentRun> {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider?.start === undefined) throw new Error('missing lifecycle fixture provider')
  const run = await provider.start({ ...request, cwd: request.cwd ?? process.cwd() })
  const identity = { runId: SubagentRunId(randomUUID()), provider: providerName, id: run.id, local }
  const carrier = scopeTarget(ctx.subagents, request.parent)
  ctx.emit(carrier, 'subagent/start', identity)
  void run.result.then(
    (result) => { ctx.emit(carrier, 'subagent/end', { ...identity, stopReason: result.stopReason, ...result.output.length > 0 ? { lastAssistantMessage: result.output } : {} }) },
    () => { ctx.emit(carrier, 'subagent/end', { ...identity, stopReason: 'error' }) },
  )
  return run
}

/** Settle a scoped lifecycle fixture after the requested registry change. */
async function settleSubagent(
  ctx: Context,
  parent: Agent,
  info: Omit<SubagentRunEndInfo, 'runId' | 'local'> & { localAgent?: Agent },
  beforeSettle?: () => Promise<void>,
): Promise<void> {
  const result = Promise.withResolvers<SubagentResult>()
  const disposeProvider = ctx.subagents.registerProvider({
    name: info.provider,
    capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
    inheritsParentContext: false,
    async start() {
      return {
        id: info.id,
        result: result.promise,
        dispose: () => Promise.resolve(),
      }
    },
  })
  try {
    const run = await startLifecycleFixture(ctx, info.provider, {
      parent,
      prompt: [],
      signal: new AbortController().signal,
    }, info.localAgent !== undefined)
    await beforeSettle?.()
    if (info.lastAssistantMessage === undefined) {
      result.reject(new Error('synthetic infrastructure failure'))
    } else {
      result.resolve({ output: info.lastAssistantMessage, stopReason: info.stopReason })
    }
    await run.result.then(() => undefined, () => undefined)
    await run.dispose()
  } finally {
    disposeProvider()
  }
}

describe('HarnessSdkJsonRpcServer', () => {
  it('waits only for an existing SDK-owned session and includes a child-triggered root turn', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-wait-'))
    const ctx = await makeHarness(storageDir)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    class Adapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({ provider, id: model, name: model })
      }
      async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'answer' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new Adapter())
    try {
      await expect(server.handleRequest('session/wait', { sessionId: 'missing' })).rejects.toThrow('not initialized')
      await server.initialize({ cwd: storageDir, provider: 'mock', model: 'mock' })
      await expect(server.handleRequest('session/wait', {})).rejects.toThrow('sessionId string')
      await expect(server.handleRequest('session/wait', { sessionId: 'missing' })).rejects.toThrow('unknown SDK session')
      expect(ctx.agents.get(SessionId('missing'))).toBeUndefined()
      await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'delegate' }] })
      const parent = ctx.agents.get(SessionId('main'))!
      const observed = Promise.withResolvers<undefined>()
      const children = Promise.withResolvers<boolean>()
      vi.spyOn(ctx.subagents, 'waitForChildren')
        .mockImplementationOnce(() => { observed.resolve(undefined); return children.promise })
        .mockResolvedValue(false)
      let settled = false
      const waiting = server.handleRequest('session/wait', { sessionId: 'main' }).then((result) => { settled = true; return result })
      await observed.promise
      expect(settled).toBe(false)
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'child result' }], source: { kind: 'user' } }))
      children.resolve(true)
      await expect(waiting).resolves.toEqual({})
      expect(transport.notifications.filter(notification => notification.method === 'session.event'
        && notification.params?.sessionId === 'main'
        && (notification.params.event as SessionEvent).type === 'turn/end')).toHaveLength(2)
      await server.shutdown()
      await expect(server.handleRequest('session/wait', { sessionId: 'main' })).rejects.toThrow('unknown SDK session')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('changes effective directories through RPC while preserving Session origins and replayable context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-directory-'))
    const child = join(root, 'child')
    await mkdir(child)
    const ctx = await makeHarness(join(root, 'sessions'), true)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('directory observed')]))
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'a' }))
        .rejects.toThrow('SDK server is not initialized')
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: child }))
        .rejects.toThrow('SDK server is not initialized')
      expect(ctx.agents.list()).toEqual([])
      await server.initialize({ cwd: root, provider: 'mock', model: 'mock' })
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'a' })).resolves.toEqual({ cwd: root })
      const selected = await realpath(child)
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: 'child' })).resolves.toEqual({ cwd: selected })
      await expect(server.handleRequest('session/working-directory/get', { sessionId: 'b' })).resolves.toEqual({ cwd: root })
      const agent = ctx.agents.get(SessionId('a'))!
      expect(agent.session.header.cwd).toBe(root)
      await server.prompt({ sessionId: 'a', contentBlocks: [{ type: 'text', text: 'where' }] })
      await agent.whenIdle()
      expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.content.some(block => block.type === 'text'
          && block.text.includes(JSON.stringify(selected))))).toBe(true)
      await expect(server.handleRequest('session/working-directory/get', {})).rejects.toThrow('sessionId')
      await expect(server.handleRequest('session/working-directory/set', { sessionId: 'a', path: 3 })).rejects.toThrow('path string')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('creates a harness agent and calls the configured OpenAI-compatible endpoint', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const init = await server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'dsagent-model',
        reasoningEffort: 'max',
        maxTokens: 321,
      }) as { serverInfo: { name: string } }
      expect(init.serverInfo.name).toBe('deepseek-harness-sdk-runtime')

      const receipt = await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'fix it' }],
      })
      expect((receipt as { messageId?: unknown }).messageId).toBeTypeOf('string')

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      const body = llmServer.requests[0] as {
        model: string
        messages: { role: string }[]
        system?: string
        output_config?: { effort: string }
        max_tokens?: number
      }
      expect(body.model).toBe('dsagent-model')
      expect(body.output_config).toEqual({ effort: 'max' })
      expect(body.max_tokens).toBe(321)
      expect(body.system).toBeTypeOf('string')
      expect(body.messages[0]?.role).toBe('user')
      expect(body.messages.at(-1)?.role).toBe('user')
      expect(llmServer.headers[0]?.['x-api-key']).toBe('test-key')
      expect(transport.notifications.some(n => n.method === 'session.event')).toBe(true)
      await vi.waitFor(() => {
        expect(transport.notifications.findLast(n => n.method === 'session.status')).toEqual({
          method: 'session.status',
          params: { sessionId: 'main', status: 'idle' },
        })
      })

      await server.handleRequest('session/prompt', {
        sessionId: 'main',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(2) })

      const orphanHandle = await ctx.agents.create({
        sessionId: SessionId('orphan-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'dsagent-model' },
      })
      orphanHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'outside the sdk session map' }], source: { kind: 'user' } }))
      await orphanHandle.agent.whenIdle()
      await orphanHandle.dispose()
      expect(llmServer.requests).toHaveLength(3)

      await server.handleRequest('shutdown', undefined)
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('round-trips a user question through an SDK interaction notification', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-question-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const handle = await ctx.agents.create({
        sessionId: SessionId('question-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'test-model' },
      })
      expect(await ctx.waterfall('user-questions/request', { questions: [] },
        () => Promise.resolve({ answers: [] }))).toEqual({ answers: [] })
      const abort = new AbortController()
      const pendingAbort = ctx.waterfall('user-questions/request', { agent: handle.agent,
        signal: abort.signal, questions: [{ id: 'abort', question: 'Continue?' }] }, () => Promise.resolve({ answers: [] }))
      const rejectedAbort = pendingAbort.catch((error: unknown) => error)
      abort.abort()
      expect(await rejectedAbort).toMatchObject({ message: 'interaction was aborted' })
      await expect(ctx.waterfall('user-questions/request', { agent: handle.agent,
        signal: abort.signal, questions: [] }, () => Promise.resolve({ answers: [] }))).rejects.toThrow('interaction was aborted')
      transport.notifications.length = 0
      const answer = ctx.userQuestions.ask({
        agent: handle.agent,
        questions: [{ id: 'task', question: 'What should I do?' }],
      })
      await vi.waitFor(() => {
        expect(transport.notifications.some(item => item.method === 'interaction.request')).toBe(true)
      })
      const notification = transport.notifications.find(item => item.method === 'interaction.request')
      const interactionId = notification?.params?.interactionId
      expect(interactionId).toBeTypeOf('string')

      for (const answers of [null, [null], ['invalid'], [{ id: 'task', selected: [3] }],
        [{ id: 'task', selected: [], custom: 42 }]]) {
        await expect(server.handleRequest('interaction/respond', { interactionId, answers })).rejects.toThrow('selected strings')
      }
      await expect(server.handleRequest('interaction/respond', {
        interactionId, answers: [{ id: 'task', selected: 'not-an-array' }],
      })).rejects.toThrow('selected strings')
      await expect(server.handleRequest('interaction/respond', {
        interactionId, answers: [{ id: 'other', selected: [] }],
      })).rejects.toThrow('exactly once')

      await expect(server.handleRequest('interaction/respond', {
        interactionId,
        answers: [{ id: 'task', selected: [], custom: 'Build the feature' }],
      })).resolves.toEqual({ accepted: true })
      await expect(answer).resolves.toEqual({
        answers: [{ id: 'task', selected: [], custom: 'Build the feature' }],
      })

      await expect(server.handleRequest('interaction/respond', { interactionId, answers: [] })).rejects.toThrow('not pending')
      const unfinished = ctx.userQuestions.ask({ agent: handle.agent, questions: [{ id: 'pending', question: 'Later?' }] })
      const unfinishedResult = unfinished.catch((error: unknown) => error)
      await server.shutdown()
      expect(await unfinishedResult).toMatchObject({ message: 'SDK server is shutting down' })
      await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('queues overlapping prompts for one session without blocking other sessions', async () => {
    const mainFollowup = vi.fn<Agent['followup']>()
    const mainAgent = ({
      id: SessionId('main'),
      followup: mainFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const otherFollowup = vi.fn<Agent['followup']>()
    const otherAgent = ({
      id: SessionId('other'),
      followup: otherFollowup,
    } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const mainHandle = { agent: mainAgent, dispose: vi.fn(() => Promise.resolve()) }
    const otherHandle = { agent: otherAgent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn(async (options: { sessionId: SessionId }) =>
      String(options.sessionId) === 'main' ? mainHandle : otherHandle)
    const liveAgents = new Map<string, Agent>([['main', mainAgent], ['other', otherAgent]])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: (id: SessionId) => liveAgents.get(String(id)) },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    server['initialized'] = true
    const prompt = (sessionId: string, text: string) => server.prompt({
      sessionId,
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('main', 'first')).messageId).toBeTypeOf('string')
    expect((await prompt('main', 'overlap')).messageId).toBeTypeOf('string')
    expect((await prompt('other', 'independent')).messageId).toBeTypeOf('string')

    expect(mainFollowup).toHaveBeenCalledTimes(2)
    expect(otherFollowup).toHaveBeenCalledOnce()
    await server.shutdown()
    expect(mainHandle.dispose).toHaveBeenCalledOnce()
    expect(otherHandle.dispose).toHaveBeenCalledOnce()
  })

  it('persists steering in next-step inbox and includes it in the next model request', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-sdk-steer-'))
    const gate = Promise.withResolvers<undefined>()
    const llmServer = await mockCompletionServer(() => gate.promise)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'dsagent-model' })
      await server.prompt({ sessionId: 'main', requestId: 'queued-first', contentBlocks: [{ type: 'text', text: 'first' }] })
      const inserted = (target: 'next-step' | 'next-turn', rpcId: string, messageId?: string): boolean =>
        transport.notifications.some((notification) => {
          const event = notification.params?.event as SessionEvent | undefined
          return notification.method === 'session.event' && event?.type === 'agent/inbox/spliced'
            && event.data.target === target && event.data.inserted.some(message =>
            message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === rpcId
              && (messageId === undefined || message.id === messageId))
        })
      expect(inserted('next-turn', 'queued-first')).toBe(true)
      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      const receipt = await server.handleRequest('session/steer', {
        sessionId: 'main', requestId: 'steer-real', contentBlocks: [{ type: 'text', text: 'steer-next-step' }],
      }) as { messageId: string }
      expect(inserted('next-step', 'steer-real', receipt.messageId)).toBe(true)
      gate.resolve(undefined)
      await vi.waitFor(() => { expect(llmServer.requests.length).toBeGreaterThan(1) })
      expect(JSON.stringify(llmServer.requests[1])).toContain('steer-next-step')
    } finally {
      gate.resolve(undefined)
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('forks a completed prefix into independent durable storage and continues after reopening', { timeout: 20_000 }, async () => {
    const storage = await mkdtemp(join(tmpdir(), 'dsh-sdk-fork-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const sourceCtx = await makeHarness(join(storage, 'source'))
    const targetCtx = await makeHarness(join(storage, 'target'))
    const sourceTransport = new FakeTransport()
    const targetTransport = new FakeTransport()
    const source = new HarnessSdkJsonRpcServer(sourceCtx, sourceTransport)
    const target = new HarnessSdkJsonRpcServer(targetCtx, targetTransport)
    const initialize = { cwd: storage, provider: 'deepseek-official', model: 'dsagent-model' }
    try {
      await source.initialize(initialize)
      await target.initialize(initialize)
      await source.prompt({ sessionId: 'source', contentBlocks: [{ type: 'text', text: 'first-turn-only' }] })
      await vi.waitFor(() => { expect(sourceTransport.notifications.filter(n => n.method === 'session.status' && n.params?.status === 'idle')).toHaveLength(1) })
      await source.prompt({ sessionId: 'source', contentBlocks: [{ type: 'text', text: 'second-turn-excluded' }] })
      await vi.waitFor(() => { expect(sourceTransport.notifications.filter(n => n.method === 'session.status' && n.params?.status === 'idle')).toHaveLength(2) })
      const sourceBefore = sourceCtx.agents.get(SessionId('source'))!.session.snapshotEvents()
      const snapshot = await source.handleRequest('session/export', { sessionId: 'source', turn: 1, maxBytes: 1000000 }) as Awaited<ReturnType<HarnessSdkJsonRpcServer['exportSession']>>
      expect(JSON.stringify(snapshot.events)).toContain('first-turn-only')
      expect(JSON.stringify(snapshot.events)).not.toContain('second-turn-excluded')
      await sourceCtx.sessionPersistence.flush()
      const readCtx = await makeHarness(join(storage, 'source'))
      const readServer = new HarnessSdkJsonRpcServer(readCtx, new FakeTransport())
      try {
        await readServer.initialize(initialize)
        const cold = await readServer.exportSession({ sessionId: 'source', turn: 1, maxBytes: 1000000 })
        expect(cold.events).toEqual(snapshot.events)
        expect(readCtx.agents.get(SessionId('source'))).toBeUndefined()
      } finally { await readServer.shutdown(); await readCtx.fiber.dispose() }
      const result = await target.handleRequest('session/fork', { sessionId: 'branch', snapshot, maxBytes: 1000000 }) as { sessionId: string }
      expect(result.sessionId).toBe('branch')
      expect(targetCtx.agents.get(SessionId('branch'))!.session.header.parentSession).toBe('source')
      expect(sourceCtx.agents.get(SessionId('source'))!.session.snapshotEvents()).toEqual(sourceBefore)
      await target.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000000 })
      await target.shutdown()
      await targetCtx.fiber.dispose()
      const reopenedCtx = await makeHarness(join(storage, 'target'))
      const reopenedTransport = new FakeTransport()
      const reopened = new HarnessSdkJsonRpcServer(reopenedCtx, reopenedTransport)
      try {
        await reopened.initialize(initialize)
        await reopened.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000000 })
        await reopened.prompt({ sessionId: 'branch', contentBlocks: [{ type: 'text', text: 'continue-branch' }] })
        await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(3) })
        const request = JSON.stringify(llmServer.requests[2])
        expect(request).toContain('first-turn-only')
        expect(request).toContain('continue-branch')
        expect(request).not.toContain('second-turn-excluded')
      } finally { await reopened.shutdown(); await reopenedCtx.fiber.dispose() }
    } finally {
      await source.shutdown()
      await target.shutdown()
      await sourceCtx.fiber.dispose()
      await targetCtx.fiber.dispose()
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('steers only an existing running agent and replays the same identified input once', async () => {
    const steer = vi.fn<Agent['steer']>()
    const agent = fixtureAgent({ id: SessionId('main'), status: 'running', followup: vi.fn(), steer })
    const handle = { agent, dispose: vi.fn(async () => {}) }
    const ctx = await fixtureContext({ create: vi.fn(async () => handle), get: () => agent })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    expect(() => server.steer(undefined)).toThrow('not active')
    server['initialized'] = true
    expect(() => server.steer(undefined)).toThrow('requires')
    await expect(server.prompt({ sessionId: 'main', requestId: '', contentBlocks: [] })).rejects.toThrow('requestId')
    const params = { sessionId: 'main', requestId: 'input-1', contentBlocks: [{ type: 'text' as const, text: 'change direction' }] }
    await expect(server.steer(params)).rejects.toThrow('existing session')
    await server.prompt({ sessionId: 'main', contentBlocks: [{ type: 'text', text: 'first' }] })
    const [first, replay] = await Promise.all([server.steer(params), server.steer(params)])
    expect(first).toEqual(replay)
    expect(steer).toHaveBeenCalledOnce()
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ id: first.messageId, content: params.contentBlocks, source: { kind: 'user', rpcId: 'input-1' } })
    expect(() => server.steer({ ...params, contentBlocks: [{ type: 'text', text: 'different' }] })).toThrow('different content')
    ;(agent as { status: string }).status = 'idle'
    await expect(server.steer({ ...params, requestId: 'input-2' })).rejects.toThrow('running session')
    expect(steer).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it('admits inline SDK images before the user message enters the session', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ref = {
      attachmentId: 'sha256:image',
      mediaType: 'image/png',
      bytes: 1,
      width: 1,
      height: 1,
    }
    const saveImages = vi.fn(async () => [ref])
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(async () => handle), get: () => agent },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    server['initialized'] = true

    await server.prompt({
      sessionId: 'image',
      contentBlocks: [
        { type: 'text', text: 'inspect' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      ],
    })

    expect(saveImages).toHaveBeenCalledWith([{ data: Uint8Array.of(1), mediaType: 'image/png' }])
    expect(followup.mock.calls[0]?.[0].content).toEqual([
      { type: 'text', text: 'inspect' },
      { type: 'image', attachment: ref },
    ])
    await server.shutdown()
  })

  it('rejects inline SDK images when the composition has no attachment store', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const ctx = await fixtureContext({ create: vi.fn(async () => handle), get: () => agent })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    server['initialized'] = true

    await expect(server.prompt({
      sessionId: 'image',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow('SDK image prompt requires an attachment store')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rechecks agent liveness after asynchronous image admission', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({ id: SessionId('image-race'), followup } satisfies Pick<Agent, 'id' | 'followup'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    const admitted = Promise.withResolvers<Array<{
      attachmentId: string
      mediaType: string
      bytes: number
    }>>()
    const saveImages = vi.fn(() => admitted.promise)
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: () => live ? agent : undefined,
      },
      get: (name: string) => name === 'attachments' ? { saveImages } : undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    server['initialized'] = true

    const prompting = server.prompt({
      sessionId: 'image-race',
      contentBlocks: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await vi.waitFor(() => { expect(saveImages).toHaveBeenCalledOnce() })
    live = false
    admitted.resolve([{ attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 1 }])

    await expect(prompting).rejects.toThrow('session agent was disposed outside the server: image-race')
    expect(followup).not.toHaveBeenCalled()
    await server.shutdown()
  })

  it('rejects a prompt for a session whose agent was disposed outside the server', async () => {
    const followup = vi.fn<Agent['followup']>()
    const agent = ({
      id: SessionId('zombie'),
      followup,
      whenIdle: vi.fn(() => Promise.resolve()),
    } satisfies Pick<Agent, 'id' | 'followup' | 'whenIdle'>) as unknown as Agent
    const handle = { agent, dispose: vi.fn(() => Promise.resolve()) }
    // The registry drops the agent after creation, modelling an agent-loop-only
    // reload that leaves the server's SessionRecord pointing at a detached agent.
    let live = true
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: {
        create: vi.fn(async () => handle),
        get: (id: SessionId) => (live && String(id) === 'zombie' ? agent : undefined),
      },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    // This isolated prompt test begins after the handshake boundary.
    server['initialized'] = true
    const prompt = (text: string) => server.prompt({
      sessionId: 'zombie',
      contentBlocks: [{ type: 'text', text }],
    })

    expect((await prompt('while live')).messageId).toBeTypeOf('string')
    live = false
    await expect(prompt('after detach')).rejects.toThrow('session agent was disposed outside the server: zombie')
    // The detached agent was never driven by the rejected prompt.
    expect(followup).toHaveBeenCalledOnce()
    await server.shutdown()
  })

  it('forwards whole-agent status without attributing a turn outcome', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const session = ctx.sessions.create(SessionId('message-outcome'))
    const agent = ({
      id: SessionId('message-outcome'),
      session,
    } satisfies Pick<Agent, 'id' | 'session'>) as Agent

    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/status', { agent, status: 'idle' })

    expect(transport.notifications.filter(notification => notification.method === 'session.status'))
      .toEqual([
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'running' } },
        { method: 'session.status', params: { sessionId: 'message-outcome', status: 'idle' } },
      ])
    await server.shutdown()
    await ctx.fiber.dispose()
  })

  it('forwards live assistant stream frames before the durable session event settles', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const session = ctx.sessions.create(SessionId('stream-session'))
    const agent = ({
      id: SessionId('stream-session'),
      session,
    } satisfies Pick<Agent, 'id' | 'session'>) as Agent
    const frame: AssistantStreamFrame = {
      type: 'chunk',
      attemptId: LlmAttemptId('attempt-1'),
      revision: 1,
      index: 0,
      time: 42,
      chunk: { type: 'text-delta', index: 0, text: 'hel' },
    }

    ctx.emit('agent/assistant-stream', { agent, frame })

    expect(transport.notifications).toContainEqual({
      method: 'session.assistant_stream',
      params: { sessionId: 'stream-session', frame },
    })
    await server.shutdown()
    const count = transport.notifications.length
    ctx.emit('agent/assistant-stream', { agent, frame })
    expect(transport.notifications).toHaveLength(count)
    await ctx.fiber.dispose()
  })

  it('notifies the host when a child session is created with parent lineage', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      ctx.sessions.create(SessionId('root-session'), {
        meta: { cwd: storageDir },
      })
      ctx.sessions.create(SessionId('child-session'), {
        meta: { cwd: storageDir, parentSession: SessionId('main') },
      })

      expect(transport.notifications).toContainEqual({
        method: 'subagent.started',
        params: {
          parentSessionId: 'main',
          childSessionId: 'child-session',
        },
      })

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each(['one-shot', 'continuable'] as const)('publishes constructor-seeded %s labels without private composition fields', async (mode) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      ctx.sessions.create(SessionId('labeled-child'), {
        meta: { parentSession: SessionId('root') },
        seed: [{ seq: SessionSeq(0), time: 1, type: 'subagent/descriptor', data: {
          version: 3, mode, provider: 'spawn', label: 'Inspect the runtime',
          ...mode === 'continuable' ? { persona: 'Private instructions', toolFilter: { allow: ['bash'] } } : {},
        } }],
      })
      expect(transport.notifications).toContainEqual({ method: 'subagent.started', params: {
        parentSessionId: 'root', childSessionId: 'labeled-child', mode, provider: 'spawn', label: 'Inspect the runtime',
      } })
      expect(JSON.stringify(transport.notifications)).not.toContain('Private instructions')
      expect(transport.notifications.some(notification => notification.method === 'session.event'
        && (notification.params?.event as { type?: string } | undefined)?.type === 'subagent/descriptor')).toBe(false)
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it.each([
    { version: 999, mode: 'continuable', provider: 'spawn', label: 'future' },
    { version: 3, mode: 'continuable', provider: 'spawn', label: 42 },
  ])('preserves lineage when persisted descriptor metadata is unsupported: $version / $label', async (descriptor) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      ctx.sessions.create(SessionId('unknown-child'), {
        meta: { parentSession: SessionId('root') },
        seed: JSON.parse(JSON.stringify([{ seq: 0, time: 1, type: 'subagent/descriptor', data: descriptor }])) as SessionEvent[],
      })
      expect(transport.notifications).toContainEqual({ method: 'subagent.started', params: {
        parentSessionId: 'root', childSessionId: 'unknown-child',
      } })
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it('does not identify a fork using an inherited ancestor descriptor', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    try {
      ctx.sessions.create(SessionId('fork-child'), {
        meta: { parentSession: SessionId('parent'), isSeeded: true },
        inheritedEventCount: SessionLogOffset(1),
        seed: [{ seq: SessionSeq(0), time: 1, type: 'subagent/descriptor', data: {
          version: 3, mode: 'continuable', provider: 'spawn', label: 'Ancestor label',
        } }],
      })
      expect(transport.notifications).toContainEqual({ method: 'subagent.started', params: {
        parentSessionId: 'parent', childSessionId: 'fork-child',
      } })
      expect(JSON.stringify(transport.notifications)).not.toContain('Ancestor label')
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it('creates an SDK session without an optional system prompt', { timeout: 15_000 }, async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-no-system-'))
    const llmServer = await mockCompletionServer()
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    vi.stubEnv('DEEPSEEK_BASE_URL', llmServer.url)
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'plain-model' })
      await server.prompt({
        sessionId: 'plain',
        contentBlocks: [{ type: 'text', text: 'hello' }],
      })

      await vi.waitFor(() => { expect(llmServer.requests).toHaveLength(1) })
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('notifies the host when a subagent run settles', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-end-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)

      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('main'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      // A custom in-process provider may own its child at the provider/root
      // scope while preserving durable parent lineage.
      const handle = await ctx.agents.create({
        sessionId: SessionId('child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('main') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      expect(ctx.agents.roots()).toContain(handle.agent)
      const parentlessHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('parentless-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('child-session'),
        localAgent: handle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'child done' }],
      }, () => handle.dispose())
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'spawn',
        id: SessionId('parentless-child-session'),
        localAgent: parentlessHandle.agent,
        stopReason: 'error',
      }, () => parentlessHandle.dispose())

      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'child-session',
          parentSessionId: 'main',
          childSessionId: 'child-session',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'child done' }],
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'spawn',
          agentId: 'parentless-child-session',
          parentSessionId: 'main',
          childSessionId: 'parentless-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('ignores a remote run id that collides with a local child of the same parent', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-remote-collision-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('collision-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const collidingChild = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('remote-run-id'),
        meta: { cwd: storageDir, parentSession: SessionId('collision-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'remote',
        id: SessionId('remote-run-id'),
        stopReason: 'completed',
        lastAssistantMessage: [],
      })

      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.agentId === 'remote-run-id',
      )).toBe(false)

      await collidingChild.dispose()
      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('retains locality across continuation runs on one live child', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-continuation-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parentHandle = await ctx.agents.create({
        sessionId: SessionId('continuation-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const childHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('continuation-child'),
        meta: { cwd: storageDir, parentSession: SessionId('continuation-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })

      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'first' }],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'continuation',
        id: SessionId('continuation-child'),
        localAgent: childHandle.agent,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'second' }],
      }, () => childHandle.dispose())

      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'continuation-child',
      )).toHaveLength(2)

      await parentHandle.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('correlates reused local ids by parent scope when runs settle out of order', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const oldParent = await ctx.agents.create({
        sessionId: SessionId('old-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const oldChild = await oldParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('old-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: oldParent.agent,
      })
      const first = Promise.withResolvers<SubagentResult>()
      const sameLifetime = Promise.withResolvers<SubagentResult>()
      const replacement = Promise.withResolvers<SubagentResult>()
      const results = [first.promise, sameLifetime.promise, replacement.promise]
      let starts = 0
      const disposeProvider = ctx.subagents.registerProvider({
        name: 'reused',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start() {
          const result = results[starts]
          starts += 1
          if (result === undefined) throw new Error('unexpected fourth reused-id run')
          return Promise.resolve({ id: SessionId('reused-child'), result, dispose: () => Promise.resolve() })
        },
      })

      const firstRun = await startLifecycleFixture(ctx, 'reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      const sameLifetimeRun = await startLifecycleFixture(ctx, 'reused', {
        parent: oldParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      sameLifetime.resolve({ output: [{ type: 'text', text: 'same lifetime' }], stopReason: 'completed' })
      await sameLifetimeRun.result
      await oldChild.dispose()
      const newParent = await ctx.agents.create({
        sessionId: SessionId('new-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const newChild = await newParent.agent.ctx.agents.create({
        sessionId: SessionId('reused-child'),
        meta: { cwd: storageDir, parentSession: SessionId('new-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: newParent.agent,
      })
      const secondRun = await startLifecycleFixture(ctx, 'reused', {
        parent: newParent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)

      replacement.resolve({ output: [{ type: 'text', text: 'new lifetime' }], stopReason: 'completed' })
      await secondRun.result
      first.resolve({ output: [{ type: 'text', text: 'old lifetime' }], stopReason: 'completed' })
      await firstRun.result
      await Promise.resolve()

      const finished = transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'reused-child',
      )
      expect(finished.map(notification => notification.params?.lastAssistantMessage)).toEqual([
        [{ type: 'text', text: 'same lifetime' }],
        [{ type: 'text', text: 'new lifetime' }],
        [{ type: 'text', text: 'old lifetime' }],
      ])
      expect(finished.map(notification => notification.params?.parentSessionId)).toEqual([
        'old-parent',
        'new-parent',
        'old-parent',
      ])

      await firstRun.dispose()
      await sameLifetimeRun.dispose()
      await secondRun.dispose()
      disposeProvider()
      await newChild.dispose()
      await oldParent.dispose()
      await newParent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps locality bound to the accepted run across provider re-registration', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-provider-reuse-'))
    const ctx = await makeHarness(storageDir)
    try {
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport)
      const parent = await ctx.agents.create({
        sessionId: SessionId('provider-reuse-parent'),
        meta: { cwd: storageDir },
        agentOptions: { model: 'deepseek-official' },
      })
      const child = await parent.agent.ctx.agents.create({
        sessionId: SessionId('provider-reuse-child'),
        meta: { cwd: storageDir, parentSession: SessionId('provider-reuse-parent') },
        agentOptions: { model: 'deepseek-official' },
        parentAgent: parent.agent,
      })
      const localResult = Promise.withResolvers<SubagentResult>()
      const remoteResult = Promise.withResolvers<SubagentResult>()
      const unregisterLocal = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          result: localResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const localRun = await startLifecycleFixture(ctx, 'reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      unregisterLocal()

      const unregisterRemote = ctx.subagents.registerProvider({
        name: 'reused-provider',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: () => Promise.resolve({
          id: SessionId('provider-reuse-child'),
          result: remoteResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      const remoteRun = await startLifecycleFixture(ctx, 'reused-provider', {
        parent: parent.agent,
        prompt: [],
        signal: new AbortController().signal,
      })

      remoteResult.resolve({ output: [{ type: 'text', text: 'remote' }], stopReason: 'completed' })
      await remoteRun.result
      await Promise.resolve()
      expect(transport.notifications.some(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.lastAssistantMessage !== undefined,
      )).toBe(false)

      await child.dispose()
      localResult.resolve({ output: [{ type: 'text', text: 'local' }], stopReason: 'completed' })
      await localRun.result
      await Promise.resolve()
      expect(transport.notifications.filter(notification =>
        notification.method === 'subagent.finished'
        && notification.params?.childSessionId === 'provider-reuse-child',
      )).toEqual([{
        method: 'subagent.finished',
        params: {
          provider: 'reused-provider',
          agentId: 'provider-reuse-child',
          parentSessionId: 'provider-reuse-parent',
          childSessionId: 'provider-reuse-child',
          status: 'ok',
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'local' }],
        },
      }])

      await localRun.dispose()
      await remoteRun.dispose()
      unregisterRemote()
      await parent.dispose()
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('uses the recorded local flag when start was missed and ignores remote runs', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-subagent-fallback-'))
    const ctx = await makeHarness(storageDir)
    let parentHandle: AgentHandle | undefined
    let handle: AgentHandle | undefined
    let failedHandle: AgentHandle | undefined
    try {
      parentHandle = await ctx.agents.create({
        sessionId: SessionId('fallback-parent'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
      })
      handle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('fallback-child-session'),
        meta: { cwd: storageDir, parentSession: SessionId('fallback-parent') },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      const fallbackChild = handle.agent
      failedHandle = await parentHandle.agent.ctx.agents.create({
        sessionId: SessionId('failed-child-session'),
        meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-official' },
        parentAgent: parentHandle.agent,
      })
      const missedStartResult = Promise.withResolvers<SubagentResult>()
      const disposeMissedStartProvider = ctx.subagents.registerProvider({
        name: 'fork',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: true,
        start: () => Promise.resolve({
          id: SessionId('fallback-child-session'),
          result: missedStartResult.promise,
          dispose: () => Promise.resolve(),
        }),
      })
      // Start before the server subscribes. The terminal payload still carries
      // this run's exact local child without reconstructing it from ids.
      const missedStartRun = await startLifecycleFixture(ctx, 'fork', {
        parent: parentHandle.agent,
        prompt: [],
        signal: new AbortController().signal,
      }, true)
      const transport = new FakeTransport()
      const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: true })

      missedStartResult.resolve({ output: [], stopReason: 'max-tokens' })
      await missedStartRun.result
      await Promise.resolve()
      await missedStartRun.dispose()
      disposeMissedStartProvider()
      // The server also missed this agent's creation but sees the exact child
      // on the run lifecycle payload.
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork-live-fallback',
        id: SessionId('fallback-child-session'),
        localAgent: fallbackChild,
        stopReason: 'completed',
        lastAssistantMessage: [],
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('failed-child-session'),
        localAgent: failedHandle.agent,
        stopReason: 'error',
      })
      await settleSubagent(ctx, parentHandle.agent, {
        provider: 'fork',
        id: SessionId('missing-child-agent'),
        stopReason: 'error',
      })

      // A result without output omits lastAssistantMessage from the wire; it
      // never sends `[]`.
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'fallback-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'fallback-child-session',
          status: 'ok',
          stopReason: 'max-tokens',
        },
      })
      expect(transport.notifications).toContainEqual({
        method: 'subagent.finished',
        params: {
          provider: 'fork',
          agentId: 'failed-child-session',
          parentSessionId: 'fallback-parent',
          childSessionId: 'failed-child-session',
          status: 'error',
          stopReason: 'error',
        },
      })
      expect(transport.notifications.some(n =>
        n.method === 'subagent.finished'
        && n.params?.agentId === 'missing-child-agent',
      )).toBe(false)

      await server.shutdown()
    } finally {
      await handle?.dispose()
      await failedHandle?.dispose()
      await parentHandle?.dispose()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('does not re-register an LLM adapter whose provider already has an owner', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-existing-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const inspect = server as unknown as { hasAdapterFor(provider: string): boolean }

      expect(inspect.hasAdapterFor('deepseek-official')).toBe(true)
      expect(inspect.hasAdapterFor('missing-provider')).toBe(false)
      await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'preinstalled-model' })

      expect(ctx.get('llm')?.listProviders().filter(provider => provider.id === 'deepseek-official')).toEqual([{ id: 'deepseek-official', name: 'DeepSeek' }])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects a missing non-DeepSeek provider when an LLM service already exists', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-new-llm-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    await ctx.plugin(LlmDeepSeek)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'new-model' }))
        .rejects.toThrow('no adapter registered for provider "private"')

      expect(ctx.get('llm')?.listProviders()).toEqual([
        { id: 'deepseek-official', name: 'DeepSeek' },
      ])
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid initialize maxTokens %s at the wire boundary',
    async (maxTokens) => {
      const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-max-tokens-'))
      const ctx = await makeHarness(storageDir)
      try {
        const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
        await expect(server.initialize({
          cwd: storageDir,
          provider: 'deepseek-official',
          model: 'model',
          maxTokens,
        })).rejects.toThrow('initialize maxTokens must be a positive safe integer')
        await server.shutdown()
      } finally {
        await ctx.fiber.dispose()
        await rm(storageDir, { recursive: true, force: true })
      }
    },
  )

  it('rejects malformed initialize reasoningEffort values at the wire boundary', async () => {
    const ctx = new Context()
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      for (const reasoningEffort of ['', 42]) {
        await expect(server.handleRequest('initialize', {
          cwd: '.',
          provider: 'deepseek-official',
          model: 'model',
          reasoningEffort,
        })).rejects.toThrow('initialize reasoningEffort must be a non-empty string')
      }
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an unavailable exact model during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-invalid-route-'))
    const ctx = await makeHarness(storageDir)
    class RejectingAdapter extends LlmAdapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.reject(new Error(`model unavailable: ${provider}/${model}`))
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new RejectingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.initialize({ cwd: storageDir, provider: 'private', model: 'missing' }))
        .rejects.toThrow('model unavailable: private/missing')
      await expect(server.prompt({
        sessionId: 'invalid-route',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect(server['sessions'].size).toBe(0)
      await server.shutdown()
    } finally {
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects prompts while exact-route initialization is pending', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-pending-route-'))
    const ctx = await makeHarness(storageDir)
    const resolution = Promise.withResolvers<LlmResolvedModelInfo>()
    const resolvedModel = { provider: 'private', id: 'selected', name: 'Selected' }
    let resolveModelCalled = false
    class PendingAdapter extends LlmAdapter {
      override resolveModel(): Promise<LlmResolvedModelInfo> {
        resolveModelCalled = true
        return resolution.promise
      }

      async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        throw new Error('unreachable')
      }
    }
    const disposeAdapter = ctx.llm.registerAdapter(['private'], new PendingAdapter())
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      const initialization = server.initialize({ cwd: storageDir, provider: 'private', model: 'selected' })
      await vi.waitFor(() => { expect(resolveModelCalled).toBe(true) })

      await expect(server.prompt({
        sessionId: 'too-early',
        contentBlocks: [{ type: 'text', text: 'must not run' }],
      })).rejects.toThrow('SDK server is not initialized')
      expect(server['sessions'].size).toBe(0)

      resolution.resolve(resolvedModel)
      await initialization
      await server.shutdown()
    } finally {
      resolution.resolve(resolvedModel)
      disposeAdapter()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported reasoning effort during initialize', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unsupported-reasoning-'))
    const ctx = await makeHarness(storageDir)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      await expect(server.handleRequest('initialize', {
        cwd: storageDir,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'impossible',
      })).rejects.toThrow('does not support reasoning effort "impossible"')
      expect(server['sessions'].size).toBe(0)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports no adapter when the LLM service is absent', async () => {
    const ctx = new Context()
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
      expect(server['hasAdapterFor']('missing-model')).toBe(false)
      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown JSON-RPC runtime methods', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-jsonrpc-unknown-'))
    const ctx = await makeHarness(storageDir)
    try {
      const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

      await expect(server.handleRequest('does/not/exist', {}))
        .rejects
        .toThrow('unknown DeepSeek Harness SDK runtime method: does/not/exist')

      await server.shutdown()
    } finally {
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent session creation and retries a failed creation', async () => {
    let resolveShared: ((handle: AgentHandle) => void) | undefined
    const sharedCreation = new Promise<AgentHandle>((resolve) => { resolveShared = resolve })
    const sharedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const retryHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockReturnValueOnce(sharedCreation)
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(retryHandle)
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create, get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    const first = server['getOrCreateSession']('shared')
    const second = server['getOrCreateSession']('shared')
    expect(create).toHaveBeenCalledTimes(1)
    resolveShared?.(sharedHandle)
    const [firstRecord, secondRecord] = await Promise.all([first, second])
    expect(firstRecord).toBe(secondRecord)

    await expect(server['getOrCreateSession']('retry')).rejects.toThrow('creation failed')
    await expect(server['getOrCreateSession']('retry')).resolves.toMatchObject({ handle: retryHandle })
    expect(create).toHaveBeenCalledTimes(3)

    await server.shutdown()
    expect(sharedHandle.dispose).toHaveBeenCalledOnce()
    expect(retryHandle.dispose).toHaveBeenCalledOnce()
    await expect(server['getOrCreateSession']('after-shutdown')).rejects.toThrow('SDK server is shutting down')
  })

  it('resumes a persisted session when a fresh SDK server sees the same id', async () => {
    const resumedHandle = { agent: {} as Agent, dispose: vi.fn(() => Promise.resolve()) }
    const create = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockRejectedValue(new Error('session "persisted" already exists'))
    const resume = vi.fn<(options: unknown) => Promise<AgentHandle>>()
      .mockResolvedValue(resumedHandle)
    const ctx = await fixtureContext({ create, resume, get: () => undefined })
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server['getOrCreateSession']('persisted'))
      .resolves.toMatchObject({ handle: resumedHandle })
    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: SessionId('persisted'),
      agentOptions: {
        provider: 'deepseek-official',
        model: 'deepseek-official',
      },
    })

    await server.shutdown()
    expect(resumedHandle.dispose).toHaveBeenCalledOnce()
  })

  it('resolves a relative cwd before creating the session', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
    }))
    const create = vi.spyOn(ctx.agents, 'create')
    const resolveCallConfig = vi.spyOn(ctx.llm, 'resolveCallConfig')
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    try {
      await server.initialize({ cwd: '.', provider: 'mock', model: 'model', reasoningEffort: ReasoningEffortId('high'), maxTokens: 123 })
      await server.prompt({ sessionId: 'relative', contentBlocks: [{ type: 'text', text: 'test relative cwd' }] })
      await server.wait({ sessionId: 'relative' })

      expect(resolveCallConfig).toHaveBeenCalledWith({
        provider: 'mock',
        model: 'model',
        reasoningEffort: ReasoningEffortId('high'),
        maxTokens: 123,
      })
      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        meta: { cwd: process.cwd() },
        agentOptions: {
          provider: 'mock',
          model: 'model',
          reasoningEffort: ReasoningEffortId('high'),
          maxTokens: 123,
        },
      }))
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
    }
  })

  it('settles every teardown and aggregates multiple failures', async () => {
    const firstDispose = vi.fn(() => { throw new Error('first teardown failed') })
    const secondDispose = vi.fn(() => Promise.reject(new Error('second teardown failed')))
    const ctx = {
      on: vi.fn(() => () => undefined),
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
    server['sessions'].set('first', { handle: { agent: {} as Agent, dispose: firstDispose }, failure: undefined })
    server['sessions'].set('second', { handle: { agent: {} as Agent, dispose: secondDispose }, failure: undefined })

    await expect(server.shutdown()).rejects.toThrow('SDK server teardown failed')
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('continues teardown after a subscription disposer fails', async () => {
    let subscription = 0
    const disposed: number[] = []
    const listenerFailure = new Error('listener teardown failed')
    const on = vi.fn(() => {
      const id = ++subscription
      return () => {
        disposed.push(id)
        if (id === subscription) throw listenerFailure
      }
    })
    const ctx = {
      on,
      agents: { create: vi.fn(), get: () => undefined },
      get: () => undefined,
    } as unknown as Context
    const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())

    await expect(server.shutdown()).rejects.toBe(listenerFailure)
    expect(disposed.toSorted()).toEqual(Array.from({ length: subscription }, (_, index) => index + 1))
  })
})


describe('SDK control ownership and routing', () => {
  it('addresses only registered SDK descendants and keeps approvals bound to their session', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-sdk-controls-'))
    const ctx = await makeHarness(storageDir)
    await ctx.plugin(ApprovalService)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    const transport = new FakeTransport()
    const server = new HarnessSdkJsonRpcServer(ctx, transport)
    const address = { rootSessionId: 'root', parentSessionId: 'root', childSessionId: 'child' }
    const prompt = { ...address, requestId: 'r1', content: [{ type: 'text' as const, text: 'Continue' }] }
    try {
      const foreign = await ctx.agents.create({ sessionId: SessionId('foreign'), meta: { cwd: storageDir },
        agentOptions: { provider: 'deepseek-official', model: 'test' } })
      const ask = (agent: Agent) => ctx.waterfall('approval/request', { agent, toolName: 'bash' },
        () => Promise.resolve('unavailable' as const))
      expect(await ask(foreign.agent)).toBe('unavailable')
      await expect(server.handleRequest('subagent/prompt', prompt)).rejects.toHaveProperty('data.code', 'subagent/delivery-unavailable')
      expect(await server.initialize({ cwd: storageDir, provider: 'deepseek-official', model: 'test' }))
        .toHaveProperty('capabilities', { sessionTreeSettled: true, approvalResponses: true, subagentControl: true })
      const list = vi.spyOn(ctx.subagents, 'listDescendants').mockResolvedValue([])
      await expect(server.handleRequest('subagent/interrupt', address)).rejects.toHaveProperty('data.code', 'subagent/unauthorized')
      const root = ctx.agents.get(SessionId('root'))!
      const child = await ctx.agents.create({ sessionId: SessionId('child'),
        meta: { cwd: storageDir, parentSession: SessionId('root') },
        agentOptions: { provider: 'deepseek-official', model: 'test' } })
      expect(await ask(foreign.agent)).toBe('unavailable')
      expect(await ask({ id: root.id, session: root.session } as Agent)).toBe('unavailable')
      for (const agent of [root, child.agent]) {
        const pending = ask(agent)
        const question = transport.notifications.filter(item => item.method === 'approval.request').at(-1)!
        expect(question.params?.sessionId).toBe(String(agent.session.id))
        await expect(server.handleRequest('approval/respond', { sessionId: String(agent.session.id),
          interactionId: question.params?.interactionId, decision: 'approved' })).resolves.toEqual({ accepted: true })
        expect(await pending).toBe('allowed-once')
      }
      for (const params of [undefined, {}, { rootSessionId: 'root' }, { rootSessionId: '', sessionId: 'child' },
        { rootSessionId: 'root', sessionId: '' }]) {
        await expect(server.handleRequest('session/is-live', params)).rejects.toThrow('requires')
      }
      expect(await server.handleRequest('session/is-live', { rootSessionId: 'root', sessionId: 'child' })).toEqual({ live: true })
      expect(await server.handleRequest('session/is-live', { rootSessionId: 'missing', sessionId: 'child' })).toEqual({ live: false })
      expect(await server.handleRequest('session/is-live', { rootSessionId: 'root', sessionId: 'foreign' })).toEqual({ live: false })
      list.mockResolvedValue([{
        kind: 'child', id: SessionId('child'), parentId: SessionId('root'), mode: 'continuable', depth: 1,
        activity: 'inactive', hasChildren: false, label: 'Child',
      }])
      const deliver = vi.spyOn(ctx.subagents, 'prompt').mockResolvedValue({ messageId: MessageId('child-message') })
      const interrupt = vi.spyOn(ctx.subagents, 'interruptByParent').mockReturnValue({ accepted: true })
      try {
        expect(await server.handleRequest('subagent/prompt', prompt)).toEqual({ messageId: 'child-message', replayed: false })
        expect(await server.handleRequest('subagent/interrupt', address)).toEqual({ accepted: true })
      } finally { list.mockRestore(); deliver.mockRestore(); interrupt.mockRestore() }
      await child.dispose()
      expect(await ask(child.agent)).toBe('unavailable')
      expect(await server.handleRequest('session/is-live', { rootSessionId: 'root', sessionId: 'child' })).toEqual({ live: false })
      await foreign.dispose()
    } finally {
      await server.shutdown()
      await ctx.fiber.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})

it('rejects inactive exports, invalid fork destinations, and conflicting resumed history', async () => {
  const dispose = vi.fn(async () => {})
  const session = Session.create(SessionId('branch'), undefined, { id: SessionId('branch'), createdAt: 0, version: 4, isSeeded: false, parentSession: SessionId('different-source') })
  const handle = { agent: fixtureAgent({ id: session.id, session }), dispose }
  const create = vi.fn<AgentRegistry['create']>()
  const ctx = await fixtureContext({ create, get: () => undefined, resume: vi.fn(async () => handle) })
  await ctx.plugin(SessionStore)
  ctx.effect(() => ctx.sessions.enter(session), 'fixtureSession()')
  const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
  const snapshot = { sourceSessionId: 'source', events: [], resources: [] }
  try {
    await expect(server.exportSession({ sessionId: 'source', turn: 1, maxBytes: 1000 })).rejects.toThrow('not active')
    await expect(server.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000 })).rejects.toThrow('not active')
    server['initialized'] = true
    await expect(server.exportSession({ sessionId: 'source', turn: 1, maxBytes: 1000 })).rejects.toThrow('requires persistence')
    await expect(server.forkSession({ sessionId: '', snapshot, maxBytes: 1000 })).rejects.toThrow('sessionId')
    create.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(server.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000 })).rejects.toThrow('storage unavailable')
    create.mockRejectedValueOnce('non-error failure')
    await expect(server.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000 })).rejects.toBe('non-error failure')
    create.mockRejectedValueOnce(new Error('session "branch" already exists'))
    await expect(server.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000 })).rejects.toThrow('different history')
    expect(dispose).toHaveBeenCalledOnce()
    create.mockRejectedValueOnce(new Error('session \"branch\" already exists'))
    dispose.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(server.forkSession({ sessionId: 'branch', snapshot, maxBytes: 1000 }))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'fork target already contains different history' }),
        expect.objectContaining({ message: 'cleanup failed' })] })
    const racing = server.forkSession({ sessionId: 'late', snapshot, maxBytes: 1000 })
    server['shuttingDown'] = true
    await expect(racing).rejects.toThrow('shutting down')
  } finally { await server.shutdown() }
})

it('continues independent cleanup after child-control and listener disposal errors', async () => {
  const ctx = await fixtureContext()
  const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
  const approvalFailure = new Error('approval disposal failed')
  const approvals = vi.spyOn(server['approvals'], 'close').mockImplementationOnce(() => { throw approvalFailure })
  const childFailure = new Error('child disposal failed')
  const listenerFailure = new Error('listener disposal failed')
  const close = vi.spyOn(server['subagentControl'], 'close').mockRejectedValueOnce(childFailure)
  const finalDispose = vi.fn()
  server['disposers'].push(finalDispose, () => { throw listenerFailure })
  try {
    await expect(server.shutdown()).rejects.toMatchObject({ errors: [approvalFailure, childFailure, listenerFailure] })
    expect(finalDispose).toHaveBeenCalledOnce()
  } finally { close.mockRestore(); approvals.mockRestore() }
})

it('publishes a supported child descriptor without requiring an optional label', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const transport = new FakeTransport()
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  try {
    ctx.sessions.create(SessionId('unlabelled'), { meta: { parentSession: SessionId('root') },
      seed: [{ seq: SessionSeq(0), time: 1, type: 'subagent/descriptor', data: {
        version: 3, mode: 'one-shot', provider: 'fork',
      } }],
    })
    expect(transport.notifications).toContainEqual({ method: 'subagent.started', params: {
      parentSessionId: 'root', childSessionId: 'unlabelled', mode: 'one-shot', provider: 'fork',
    } })
  } finally { await server.shutdown(); await ctx.fiber.dispose() }
})

it('requires the declared projection service before publishing child metadata', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
  try {
    expect(() => ctx.sessions.create(SessionId('child'), { meta: { parentSession: SessionId('root') } }))
      .toThrow('SDK child metadata requires its Session projection')
  } finally {
    await server.shutdown()
    await ctx.fiber.dispose()
  }
})

it('reports a native completion failure without waiting forever for a terminal event', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-sdk-failed-completion-'))
  const ctx = await makeHarness(storageDir)
  const transport = new FakeTransport()
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')]))
  try {
    await server.initialize({ cwd: storageDir, provider: 'mock', model: 'mock' })
    const { handle } = await server['getOrCreateSession']('root')
    ctx.emit('agent/error', { agent: handle.agent, turn: 1, step: 1, error: new Error('terminal unavailable') })
    server['settlement'].begin('root')
    ctx.emit('agent/status', { agent: handle.agent, status: 'idle' })
    await server['settlement'].drain()
    expect(transport.notifications).toContainEqual({ method: 'session.settled', params: { sessionId: 'root', error: 'terminal unavailable' } })
  } finally {
    await server.shutdown()
    await ctx.fiber.dispose()
    await rm(storageDir, { recursive: true, force: true })
  }
})


it('joins in-flight fork creation and releases its handle before shutdown completes', async () => {
  const created = Promise.withResolvers<AgentHandle>()
  const create = vi.fn<AgentRegistry['create']>(() => created.promise)
  const ctx = await fixtureContext({ create })
  const server = new HarnessSdkJsonRpcServer(ctx, new FakeTransport())
  const dispose = vi.fn(async () => {})
  server['initialized'] = true
  const fork = server.forkSession({ sessionId: 'branch', snapshot: { sourceSessionId: 'source', events: [], resources: [] }, maxBytes: 1000 })
  const failedFork = expect(fork).rejects.toThrow('shutting down')
  await vi.waitFor(() => { expect(create).toHaveBeenCalledOnce() })
  let closed = false
  const shutdown = server.shutdown().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  created.resolve({ agent: fixtureAgent({ id: SessionId('branch') }), dispose })
  await failedFork
  await shutdown
  expect(dispose).toHaveBeenCalledOnce()
  expect(closed).toBe(true)
})
