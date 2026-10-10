import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AttachmentStore, { AttachmentId, type ImageAttachmentRef, type ImageAttachmentLimits, type SaveImageAttachment, type FileAttachmentRef, type SaveFileAttachment } from '@deepseek-ai/dsh-attachment'
import { assertForkBudget, exportFork, importFork } from '../src/fork.ts'

const sourceRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('opaque-source-image'), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
}

class FixtureAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 100, maxImagesPerMessage: 10, maxMessageImageBytes: 1000,
    maxImagePixels: 100, maxImageDimension: 10, mediaTypes: ['image/png'],
  }
  async validateImage(): Promise<void> {}
  async saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return { ...sourceRef, attachmentId: AttachmentId('opaque-target-image') }
  }
  async readImage(ref: ImageAttachmentRef) { return { ref, data: new Uint8Array([1, 2, 3]) } }
  override async * readFileStream() { yield new Uint8Array([1, 2, 3]) }
  override async saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    return { attachmentId: AttachmentId('opaque-target-file'), name: input.name ?? 'file.bin', bytes: input.data.byteLength }
  }
}

async function setup() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(FixtureAttachments)
  const session = Session.create(SessionId('source'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'image', attachment: sourceRef }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0,
    inserted: [createUserMessage({ content: [{ type: 'text', text: 'future-input' }], source: { kind: 'user' } })] })
  return { ctx, session, end }
}

describe('portable SDK fork resources', () => {
  it('exports referenced bytes and rewrites references through the target attachment provider', async () => {
    const { ctx, session, end } = await setup()
    const snapshot = await exportFork(ctx, { id: session.id, header: session.header, events: session.snapshotEvents() }, 1, 10000, end.time)
    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.resources[0]?.data).toBe('AQID')
    const saveImage = vi.spyOn(ctx.attachments, 'saveImage')
    const seed = await importFork(ctx, snapshot, 10000)
    expect(JSON.stringify(seed)).toContain('opaque-target-image')
    expect(JSON.stringify(seed)).not.toContain('opaque-source-image')
    expect(JSON.stringify(session.snapshotEvents())).toContain('opaque-source-image')
    expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from([1, 2, 3]), mediaType: 'image/png' })
  })

  it('rejects missing resources and a mismatched completed-turn timestamp', async () => {
    const { ctx, session, end } = await setup()
    await expect(exportFork(ctx, { id: session.id, header: session.header, events: session.snapshotEvents() }, 1, 10000, end.time + 1)).rejects.toThrow('has not completed')
    const snapshot = await exportFork(ctx, { id: session.id, header: session.header, events: session.snapshotEvents() }, 1, 10000)
    await expect(importFork(ctx, { ...snapshot, resources: [] }, 10000)).rejects.toThrow('missing attachment bytes')
    await expect(exportFork(ctx, { id: session.id, header: session.header, events: session.snapshotEvents() }, 1, 10)).rejects.toThrow('maxBytes')
  })
})


/** A serialized source cut exercises corruption checks without mutating the native source Session. */
function sourceWithBlock(session: Session, block: unknown): Parameters<typeof exportFork>[1] {
  const events = session.snapshotEvents().map(event => event.type === 'user/message'
    ? { ...event, data: { ...event.data, content: [block] } } : event)
  return JSON.parse(JSON.stringify({ id: session.id, header: session.header, events })) as Parameters<typeof exportFork>[1]
}

describe('SDK fork attachment limits and invalid snapshots', () => {
  it('exports streamed files, preserves names, and bounds actual bytes independently of reported size', async () => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'file', attachment: {
      attachmentId: 'source-file', name: 'report.txt', bytes: 3,
    } })
    const snapshot = await exportFork(ctx, source, 1, 10000)
    const save = vi.spyOn(ctx.attachments, 'saveFile')
    const seed = await importFork(ctx, snapshot, 10000)
    expect(save).toHaveBeenCalledWith({ data: Buffer.from([1, 2, 3]), name: 'report.txt' })
    expect(JSON.stringify(seed)).toContain('opaque-target-file')
    vi.spyOn(ctx.attachments, 'readFileStream').mockImplementation(async function* () { yield new Uint8Array(20000) })
    await expect(exportFork(ctx, source, 1, 10000)).rejects.toThrow('attachment exceeds maxBytes')
  })

  it('accepts named image references with original dimensions', async () => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'image', attachment: {
      ...sourceRef, name: 'image.png', originalDimensions: { width: 2, height: 2 },
    } })
    const snapshot = await exportFork(ctx, source, 1, 10000)
    const save = vi.spyOn(ctx.attachments, 'saveImage')
    await importFork(ctx, snapshot, 10000)
    expect(save).toHaveBeenCalledWith({ data: Buffer.from([1, 2, 3]), mediaType: 'image/png', name: 'image.png' })
  })

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte budget %s', async (maxBytes) => {
    const { ctx, session } = await setup()
    expect(() => { assertForkBudget({}, maxBytes) }).toThrow('positive safe integer')
    await expect(exportFork(ctx, { id: session.id, header: session.header, events: session.snapshotEvents() }, 0, 10000))
      .rejects.toThrow('turn must be')
  })

  it('rejects missing attachment services on export and import', async () => {
    const { ctx, session } = await setup()
    const source = { id: session.id, header: session.header, events: session.snapshotEvents() }
    const snapshot = await exportFork(ctx, source, 1, 10000)
    const empty = new Context()
    onTestFinished(() => empty.fiber.dispose())
    await expect(exportFork(empty, source, 1, 10000)).rejects.toThrow('attachment store')
    await expect(importFork(empty, snapshot, 10000)).rejects.toThrow('attachment store')
  })

  it.each([
    { bytes: -1 }, { bytes: 'invalid' }, { bytes: 100000 },
  ])('rejects unavailable or oversized attachment sizes: %j', async (overrides) => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'image', attachment: { ...sourceRef, ...overrides } })
    const read = vi.spyOn(ctx.attachments, 'readImage')
    await expect(exportFork(ctx, source, 1, 10000)).rejects.toThrow('attachment exceeds maxBytes')
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    { width: 0 }, { height: 0 }, { bytes: 1.5 }, { mediaType: 3 }, { mediaType: 'invalid' },
    { name: 3 }, { originalDimensions: null }, { originalDimensions: { width: 0, height: 1 } },
    { originalDimensions: { width: 1, height: 0 } },
  ])('rejects corrupt image metadata before storage reads: %j', async (overrides) => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'image', attachment: { ...sourceRef, ...overrides } })
    await expect(exportFork(ctx, source, 1, 10000)).rejects.toThrow('invalid fork image')
  })

  it.each([{ name: 3 }, { bytes: 1.5 }])('rejects corrupt file metadata: %j', async (overrides) => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'file', attachment: {
      attachmentId: 'source-file', name: 'report.txt', bytes: 3, ...overrides,
    } })
    await expect(exportFork(ctx, source, 1, 10000)).rejects.toThrow('invalid fork file')
  })

  it.each([
    { sourceSessionId: '' }, { sourceSessionId: 3 }, { events: null }, { resources: null },
    { resources: [{ kind: 'image', ref: {}, data: 'AQID' }] },
    { resources: [{ kind: 'image', ref: { attachmentId: 'a' }, data: 3 }] },
    { resources: [{ kind: 'image', ref: { attachmentId: 'a' }, data: '!!!!' }] },
    { resources: [{ kind: 'future', ref: { attachmentId: 'a' }, data: 'AQID' }] },
  ])('refuses malformed serialized fork snapshots: %j', async (overrides) => {
    const { ctx } = await setup()
    const snapshot = JSON.parse(JSON.stringify({ sourceSessionId: 'source', events: [], resources: [], ...overrides })) as Parameters<typeof importFork>[1]
    await expect(importFork(ctx, snapshot, 10000)).rejects.toThrow()
  })

  it('leaves unrelated opaque identifiers unchanged while rewriting actual attachments', async () => {
    const { ctx, session } = await setup()
    const source = sourceWithBlock(session, { type: 'image', attachment: sourceRef,
      annotation: { attachmentId: 'metadata-only' } })
    const snapshot = await exportFork(ctx, source, 1, 10000)
    const seed = await importFork(ctx, snapshot, 10000)
    expect(JSON.stringify(seed)).toContain('metadata-only')
    expect(JSON.stringify(seed)).toContain('opaque-target-image')
  })
})
