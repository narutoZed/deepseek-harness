import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import Subagents from '@deepseek-ai/dsh-subagent'
import type { SdkSubagentPromptParams } from '@deepseek-ai/dsh-sdk-protocol'
import { SdkSubagentControl } from '../src/subagent-control.ts'
import { SdkSessionSettlement } from '../src/session-settlement.ts'

const scopes: Context[] = []
afterEach(async () => { await Promise.all(scopes.splice(0).map(ctx => ctx.fiber.dispose())) })
async function setup() {
  const ctx = new Context(); scopes.push(ctx)
  const root = { id: SessionId('root'), session: { id: SessionId('root') }, status: 'idle' } as Agent
  const get = vi.fn(() => root)
  await ctx.plugin(AgentRegistry)
  vi.spyOn(ctx.agents, 'get').mockImplementation(get)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(Subagents)
  const entries: SubagentDescendantListEntry[] = [{ kind: 'child', id: SessionId('child'), parentId: SessionId('root'),
    mode: 'continuable', depth: 1, activity: 'inactive', hasChildren: false, label: 'Child' }]
  const service = { listDescendants: vi.fn(async (_root: SessionId, _signal?: AbortSignal) => entries),
    prompt: vi.fn(async () => ({ messageId: MessageId('message-1') })),
    interruptByParent: vi.fn(() => ({ accepted: true as const })) }
  vi.spyOn(ctx.subagents, 'listDescendants').mockImplementation(service.listDescendants)
  vi.spyOn(ctx.subagents, 'prompt').mockImplementation(service.prompt)
  vi.spyOn(ctx.subagents, 'interruptByParent').mockImplementation(service.interruptByParent)
  const settled = vi.fn(); const activity = new SdkSessionSettlement(async () => {}, settled)
  const openRoot = vi.fn(async () => root)
  const control = new SdkSubagentControl(ctx, openRoot, activity)
  const params: SdkSubagentPromptParams = { rootSessionId: 'root', parentSessionId: 'root',
    childSessionId: 'child', requestId: 'request-1', content: [{ type: 'text', text: 'Continue' }], clientTimeZone: 'Asia/Shanghai' }
  return { control, params, service, entries, get, settled, ctx }
}

describe('SDK child control', () => {
  it('uses native continuation admission and deduplicates a caller request', async () => {
    const { control, params, service, settled } = await setup()
    const [first, retry] = await Promise.all([control.prompt(params), control.prompt({ ...params })])
    expect(first).toEqual({ messageId: 'message-1', replayed: false })
    expect(retry).toEqual({ messageId: 'message-1', replayed: true })
    expect(service.prompt).toHaveBeenCalledTimes(1)
    expect(service.prompt.mock.calls[0]).toEqual([expect.objectContaining({
      parentSessionId: 'root', childSessionId: 'child', delivery: 'queue', requestId: 'request-1',
    }), expect.any(AbortSignal)])
    await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith('root', undefined) })
    await expect(control.prompt({ ...params, content: [{ type: 'text', text: 'Different' }] }))
      .rejects.toMatchObject({ data: { code: 'idempotency_conflict' } })
    await control.close()
  })

  it('rejects wrong roots, wrong direct parents, and terminal one-shot children', async () => {
    const { control, params, service, entries } = await setup()
    await expect(control.prompt({ ...params, parentSessionId: 'other' }))
      .rejects.toMatchObject({ data: { code: 'subagent/unauthorized' } })
    await expect(control.interrupt({ ...params, childSessionId: 'sibling' }))
      .rejects.toMatchObject({ data: { code: 'subagent/unauthorized' } })
    entries[0] = { kind: 'child', id: SessionId('child'), parentId: SessionId('root'), mode: 'one-shot', depth: 1, activity: 'inactive', hasChildren: false, label: 'Child' }
    await expect(control.prompt(params)).rejects.toMatchObject({ data: { code: 'subagent/not-resumable' } })
    expect(service.prompt).not.toHaveBeenCalled()
    expect(service.interruptByParent).not.toHaveBeenCalled()
    await control.close()
  })

  it('rejects controls when the optional native service is not mounted', async () => {
    const { control, params, ctx } = await setup()
    const get = vi.spyOn(ctx, 'get').mockReturnValue(undefined)
    try {
      await expect(control.interrupt(params)).rejects.toHaveProperty('data.code', 'subagent/control-unavailable')
    } finally { get.mockRestore(); await control.close() }
  })

  it('signals only the requested child through its direct-parent authority', async () => {
    const { control, params, service } = await setup()
    await expect(control.interrupt(params)).resolves.toEqual({ accepted: true })
    expect(service.interruptByParent).toHaveBeenCalledExactlyOnceWith('child', 'root', 'continuable')
    await control.close()
  })

  it('contains native errors and refuses stale or closed parents', async () => {
    const { control, params, service, get } = await setup()
    service.prompt.mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'subagent/parent-unavailable' }))
    await expect(control.prompt(params)).rejects.toMatchObject({ data: { code: 'subagent/parent-unavailable' } })
    service.prompt.mockRejectedValueOnce(new Error('private'))
    await expect(control.prompt(params)).rejects.toMatchObject({ data: { code: 'subagent/delivery-unavailable' } })
    get.mockReturnValue(undefined as never)
    await expect(control.interrupt(params)).rejects.toMatchObject({ data: { code: 'subagent/parent-unavailable' } })
    await control.close()
    await expect(control.prompt(params)).rejects.toMatchObject({ data: { code: 'subagent/delivery-unavailable' } })
  })

  it('validates the JSON-RPC inputs before admission', async () => {
    const { control, params } = await setup()
    await expect(control.prompt(undefined as never)).rejects.toThrow('requires')
    await expect(control.prompt({ ...params, content: [] })).rejects.toThrow('requires')
    await expect(control.interrupt({ ...params, rootSessionId: '' })).rejects.toMatchObject({ data: { code: 'subagent/delivery-unavailable' } })
    await control.close()
  })

  it('waits for interrupted control admission to settle before teardown returns', async () => {
    const { control, params, service } = await setup()
    const entered = Promise.withResolvers<undefined>(); let finished = false
    service.listDescendants.mockImplementationOnce(async (_root, signal) => {
      entered.resolve(undefined)
      await new Promise<undefined>((resolve) => {
        signal!.addEventListener('abort', () => { finished = true; resolve(undefined) }, { once: true })
      })
      return []
    })
    const pending = control.prompt(params).catch((error: unknown) => error)
    await entered.promise
    await control.close()
    expect(finished).toBe(true)
    expect(await pending).toHaveProperty('data.code', 'subagent/unauthorized')
    expect(service.prompt).not.toHaveBeenCalled()
  })
})
