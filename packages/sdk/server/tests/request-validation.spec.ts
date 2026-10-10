import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '../src/server.ts'

const owners: { ctx: Context; server: HarnessSdkJsonRpcServer }[] = []
afterEach(async () => {
  for (const { ctx, server } of owners.splice(0)) {
    await server.shutdown()
    await ctx.fiber.dispose()
  }
})

function server() {
  const ctx = new Context()
  const transport: JsonRpcTransportPeer = { request: async () => ({}), notify: () => {} }
  const server = new HarnessSdkJsonRpcServer(ctx, transport)
  owners.push({ ctx, server })
  return server
}

const address = { rootSessionId: 'root', parentSessionId: 'root', childSessionId: 'child' }
const prompt = { ...address, requestId: 'request', content: [{ type: 'text', text: 'continue' }] }
const fork = { sessionId: 'branch', maxBytes: 10000, snapshot: { sourceSessionId: 'source', events: [], resources: [] } }
const steer = { sessionId: 'root', requestId: 'request', contentBlocks: [{ type: 'text', text: 'steer' }] }

describe('SDK request decoding', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['session/steer', undefined], ['session/steer', { ...steer, sessionId: '' }],
    ['session/steer', { ...steer, requestId: 3 }], ['session/steer', { ...steer, contentBlocks: [] }],
    ['session/steer', { ...steer, contentBlocks: null }], ['session/steer', { ...steer, contentBlocks: [null] }],
    ['session/steer', { ...steer, contentBlocks: [{}] }], ['session/steer', { ...steer, contentBlocks: [{ type: 3 }] }],
    ['session/export', undefined], ['session/export', { sessionId: 'root', turn: 1, maxBytes: 'large' }],
    ['session/export', { sessionId: 'root', turn: 1, maxBytes: 10000, endedAt: 'yesterday' }],
    ['session/fork', undefined], ['session/fork', { ...fork, snapshot: null }],
    ['session/fork', { ...fork, snapshot: { ...fork.snapshot, cwd: 3 } }],
    ['session/fork', { ...fork, snapshot: { ...fork.snapshot, events: null } }],
    ['session/fork', { ...fork, snapshot: { ...fork.snapshot, resources: null } }],
    ['approval/respond', undefined], ['approval/respond', { sessionId: 'root', interactionId: 'q', decision: 'forever' }],
    ['subagent/interrupt', {}], ['subagent/prompt', { ...prompt, clientTimeZone: 3 }],
    ['subagent/prompt', { ...prompt, content: [] }], ['subagent/prompt', { ...prompt, content: null }],
    ['subagent/prompt', { ...prompt, content: [null] }], ['subagent/prompt', { ...prompt, content: [3] }],
    ['subagent/prompt', { ...prompt, content: [{}] }], ['subagent/prompt', { ...prompt, content: [{ type: 'file' }] }],
    ['subagent/prompt', { ...prompt, content: [{ type: 'text', text: 3 }] }],
    ['subagent/prompt', { ...prompt, content: [{ type: 'image', data: 'AQID', mediaType: 'invalid' }] }],
    ['subagent/prompt', { ...prompt, content: [{ type: 'image', data: 'AQID', mediaType: 'image/png', name: 3 }] }],
  ])('rejects malformed %s input without dispatching an operation: %j', async (method, params) => {
    const runtime = server()
    const methods = [
      vi.spyOn(runtime, 'steer').mockResolvedValue({ messageId: 'unexpected' }),
      vi.spyOn(runtime, 'exportSession').mockResolvedValue(fork.snapshot),
      vi.spyOn(runtime, 'forkSession').mockResolvedValue({ sessionId: 'unexpected', events: [] }),
      vi.spyOn(runtime['approvals'], 'respond').mockReturnValue({ accepted: true }),
      vi.spyOn(runtime['subagentControl'], 'prompt').mockResolvedValue({ messageId: 'unexpected', replayed: false }),
      vi.spyOn(runtime['subagentControl'], 'interrupt').mockResolvedValue({ accepted: true }),
    ]
    await expect(runtime.handleRequest(method, params)).rejects.toThrow()
    for (const method of methods) expect(method).not.toHaveBeenCalled()
  })

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('retains typed child %s input and timezone', async (mediaType) => {
    const runtime = server()
    const admitted = vi.spyOn(runtime['subagentControl'], 'prompt').mockResolvedValue({ messageId: 'accepted', replayed: false })
    const content = [{ type: 'image', data: 'AQID', mediaType, name: 'image' }, { type: 'image', data: 'AQID', mediaType }]
    expect(await runtime.handleRequest('subagent/prompt', { ...prompt, clientTimeZone: 'Asia/Shanghai', content }))
      .toEqual({ messageId: 'accepted', replayed: false })
    expect(admitted).toHaveBeenCalledWith({ ...prompt, content, clientTimeZone: 'Asia/Shanghai' })
  })

  it('retains the optional export cut and fork working directory with both resource kinds', async () => {
    const runtime = server()
    const exported = vi.spyOn(runtime, 'exportSession').mockResolvedValue(fork.snapshot)
    await runtime.handleRequest('session/export', { sessionId: 'root', turn: 1, maxBytes: 10000, endedAt: 123 })
    expect(exported).toHaveBeenCalledWith({ sessionId: 'root', turn: 1, maxBytes: 10000, endedAt: 123 })
    await runtime.handleRequest('session/export', { sessionId: 'root', turn: 1, maxBytes: 10000 })
    expect(exported).toHaveBeenLastCalledWith({ sessionId: 'root', turn: 1, maxBytes: 10000 })
    const imported = vi.spyOn(runtime, 'forkSession').mockResolvedValue({ sessionId: 'branch', events: [] })
    const snapshot = { ...fork.snapshot, cwd: '/source',
      events: [{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }],
      resources: ['image', 'file'].map(kind => ({ kind, data: 'AQID', ref: { attachmentId: 'source' } })),
    }
    await runtime.handleRequest('session/fork', { ...fork, snapshot })
    expect(imported).toHaveBeenCalledWith({ ...fork, snapshot })
    await runtime.handleRequest('session/fork', fork)
    expect(imported).toHaveBeenLastCalledWith(fork)
  })

  it.each([
    null, [], { type: 'turn/start', seq: -1, time: 1, data: {} },
    { type: 'turn/start', seq: 0, time: 1, data: {}, ignorable: false },
    { type: 'turn/start', seq: 0, time: 'now', data: {} },
  ])('refuses invalid event envelopes before fork attachment writes: %j', async (event) => {
    const runtime = server()
    const imported = vi.spyOn(runtime, 'forkSession').mockResolvedValue({ sessionId: 'branch', events: [] })
    await expect(runtime.handleRequest('session/fork', { ...fork, snapshot: { ...fork.snapshot, events: [event] } })).rejects.toThrow()
    expect(imported).not.toHaveBeenCalled()
  })

  it.each([null, { kind: 'other', data: 'AQID', ref: {} }, { kind: 'image', data: 3, ref: {} }, { kind: 'file', data: 'AQID', ref: null }])
  ('refuses invalid attachment envelopes: %j', async (resource) => {
    const runtime = server()
    await expect(runtime.handleRequest('session/fork', { ...fork, snapshot: { ...fork.snapshot, resources: [resource] } })).rejects.toThrow()
  })
})
