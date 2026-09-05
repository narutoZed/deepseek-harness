import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { exportFork, importFork } from '../src/fork.ts'

function source() {
  const attachment = { attachmentId: 'opaque-source-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const events = [
    { seq: 0, time: 1, type: 'user/message', data: { content: [{ type: 'image', attachment }] } },
    { seq: 1, time: 2, type: 'turn/end', data: { turn: 1 } },
    { seq: 2, time: 3, type: 'agent/inbox/spliced', data: { inserted: [{ content: 'future-input' }] } },
  ]
  return { session: { id: 'source', header: { cwd: '/workspace' }, snapshotEvents: () => events } as unknown as Session, events }
}

describe('portable SDK fork resources', () => {
  it('exports referenced bytes and rewrites references through the target attachment provider', async () => {
    const { session, events } = source()
    const readImage = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]) }))
    const snapshot = await exportFork({ get: () => ({ readImage }) } as unknown as Context, session, 1, 10000, 2)
    expect(snapshot.events).toHaveLength(2)
    expect(snapshot.resources[0]?.data).toBe('AQID')
    const saveImage = vi.fn(async () => ({ attachmentId: 'opaque-target-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }))
    const seed = await importFork({ get: () => ({ saveImage }) } as unknown as Context, snapshot, 10000)
    expect(JSON.stringify(seed)).toContain('opaque-target-image')
    expect(JSON.stringify(seed)).not.toContain('opaque-source-image')
    expect(JSON.stringify(events)).toContain('opaque-source-image')
    expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
  })
  it('rejects missing resources and a mismatched completed-turn timestamp', async () => {
    const { session } = source()
    const ctx = { get: () => ({ readImage: async () => ({ data: new Uint8Array([1, 2, 3]) }) }) } as unknown as Context
    await expect(exportFork(ctx, session, 1, 10000, 999)).rejects.toThrow('has not completed')
    const snapshot = await exportFork(ctx, session, 1, 10000)
    await expect(importFork(ctx, { ...snapshot, resources: [] }, 10000)).rejects.toThrow('missing attachment bytes')
    await expect(exportFork(ctx, session, 1, 10)).rejects.toThrow('maxBytes')
  })
})
