import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import { SdkApprovals } from '../src/approvals.ts'

const scopes: Context[] = []
afterEach(async () => { await Promise.all(scopes.splice(0).map(ctx => ctx.fiber.dispose())) })
function setup(owns = true) {
  const ctx = new Context(); scopes.push(ctx)
  const messages: { method: string; payload: Record<string, unknown> }[] = []
  const notify = vi.fn((method: string, payload: object | undefined) => {
    messages.push({ method, payload: payload as Record<string, unknown> })
  })
  const transport: JsonRpcTransportPeer = { notify, request: vi.fn() }
  const approvals = new SdkApprovals(ctx, transport, () => owns)
  const request = (signal?: AbortSignal): ApprovalRequest => ({
    agent: { session: { id: SessionId('session') } } as Agent, toolName: 'bash', reason: 'One operation',
    ...(signal === undefined ? {} : { signal }),
  })
  const ask = (input = request()) => ctx.waterfall('approval/request', input, () => Promise.resolve<ApprovalOutcome>('unavailable'))
  return { approvals, messages, notify, request, ask }
}

describe('SDK native approvals', () => {
  it.each(['approved', 'cancelled'] as const)('consumes %s once and retains other-session questions', async (decision) => {
    const { approvals, messages, ask } = setup()
    const result = ask(); const interactionId = String(messages[0]!.payload.interactionId)
    expect(() => approvals.respond({ sessionId: 'other', interactionId, decision })).toThrow('no longer available')
    expect(approvals.respond({ sessionId: 'session', interactionId, decision })).toEqual({ accepted: true })
    expect(await result).toBe(decision === 'approved' ? 'allowed-once' : 'rejected')
    expect(messages[1]!.method).toBe('approval.resolved')
    expect(() => approvals.respond({ sessionId: 'session', interactionId, decision })).toThrow('no longer available')
    approvals.close()
  })

  it('forwards optional call identity and ignores repeated settlement during notification delivery', async () => {
    const { approvals, ask, messages, notify, request } = setup()
    const result = ask({ agent: request().agent, toolName: 'bash', callId: ToolCallId('call-1') })
    const interactionId = String(messages[0]!.payload.interactionId)
    expect(messages[0]!.payload).toMatchObject({ callId: 'call-1' })
    expect(messages[0]!.payload).not.toHaveProperty('reason')
    approvals.respond({ sessionId: 'session', interactionId, decision: 'approved' })
    expect(await result).toBe('allowed-once')
    notify.mockImplementation(() => { throw new Error('transport gone') })
    expect(await ask()).toBe('cancelled')
    approvals.close()
  })

  it('withdraws on cancellation and teardown without granting access', async () => {
    const { approvals, messages, ask, request } = setup()
    const abort = new AbortController(); const first = ask(request(abort.signal))
    abort.abort(); expect(await first).toBe('cancelled')
    const firstId = String(messages[0]!.payload.interactionId)
    expect(() => approvals.respond({ sessionId: 'session', interactionId: firstId, decision: 'approved' })).toThrow()
    const second = ask(); approvals.close(); expect(await second).toBe('cancelled')
    expect(await ask()).toBe('unavailable')
  })

  it('delegates foreign agents and cancels already-aborted requests', async () => {
    const foreign = setup(false); expect(await foreign.ask()).toBe('unavailable'); foreign.approvals.close()
    const local = setup(); const abort = new AbortController(); abort.abort()
    expect(await local.ask(local.request(abort.signal))).toBe('cancelled')
    expect(local.messages).toEqual([]); local.approvals.close()
  })

  it('fails closed on transport loss and rejects malformed answers', async () => {
    const { approvals, ask, notify } = setup()
    notify.mockImplementation((method, payload) => {
      if (method === 'approval.request') approvals.respond({ sessionId: 'session',
        interactionId: String((payload as Record<string, unknown>).interactionId), decision: 'cancelled' })
      throw new Error('closed')
    })
    expect(await ask()).toBe('rejected')
    expect(() => approvals.respond({ sessionId: 's', interactionId: 'q', decision: 'forever' } as never)).toThrow('requires')
    expect(() => approvals.respond(undefined as never)).toThrow('requires')
    approvals.close()
  })
})
