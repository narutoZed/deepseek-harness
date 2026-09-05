/** Portable completed-turn seeds for SDK-owned session forks. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionForkSnapshot, SdkForkResource } from '@deepseek-ai/dsh-sdk-protocol'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function walk(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return }
  const object = record(value)
  if (object === undefined) return
  visit(object)
  for (const item of Object.values(object)) walk(item, visit)
}

export function assertForkBudget(value: unknown, maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer')
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('session fork exceeds maxBytes')
}

/** Export the same completed-turn prefix that the Web fork action uses. */
export async function exportFork(ctx: Context, session: Pick<Session, 'id' | 'header' | 'snapshotEvents'>, turn: number, maxBytes: number, endedAt?: number): Promise<SessionForkSnapshot> {
  if (!Number.isSafeInteger(turn) || turn < 1) throw new TypeError('turn must be a positive safe integer')
  const all = session.snapshotEvents()
  const boundary = all.findIndex(event => event.type === 'turn/end' && event.data.turn === turn
    && (endedAt === undefined || event.time === endedAt))
  if (boundary < 0) throw new Error('selected turn has not completed')
  // A later queued message may precede the next turn/start. It is not part of this fork.
  const events = all.slice(0, boundary + 1)
  const snapshot: SessionForkSnapshot = {
    sourceSessionId: String(session.id), events, resources: [],
    ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
  }
  assertForkBudget(snapshot, maxBytes)
  const references = new Map<string, { kind: 'image' | 'file'; ref: Record<string, unknown> }>()
  walk(events, (block) => {
    const attachment = record(block.attachment)
    if ((block.type === 'image' || block.type === 'file') && typeof attachment?.attachmentId === 'string') {
      references.set(attachment.attachmentId, { kind: block.type, ref: attachment })
    }
  })
  const resources: SdkForkResource[] = []
  let resourceBytes = 0
  for (const { kind, ref } of references.values()) {
    const store = ctx.get('attachments')
    if (store === undefined) throw new Error('session fork requires its attachment store')
    if (typeof ref.bytes !== 'number' || ref.bytes < 0 || resourceBytes + ref.bytes * 4 / 3 > maxBytes) {
      throw new Error('session fork attachment exceeds maxBytes')
    }
    let data: Uint8Array
    if (kind === 'image') data = (await store.readImage(ref as unknown as ImageAttachmentRef)).data
    else {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of store.readFileStream(ref as unknown as FileAttachmentRef)) {
        bytes += chunk.byteLength
        if (resourceBytes + bytes * 4 / 3 > maxBytes) throw new Error('session fork attachment exceeds maxBytes')
        chunks.push(chunk)
      }
      data = Buffer.concat(chunks)
    }
    const encoded = Buffer.from(data).toString('base64')
    resourceBytes += encoded.length
    resources.push({ kind, ref, data: encoded })
  }
  const result = { ...snapshot, resources }
  assertForkBudget(result, maxBytes)
  return result
}

/** Copy referenced bytes through the attachment capability before publishing seeded history. */
export async function importFork(ctx: Context, snapshot: SessionForkSnapshot, maxBytes: number): Promise<SessionEvent[]> {
  assertForkBudget(snapshot, maxBytes)
  if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.resources)
    || typeof snapshot.sourceSessionId !== 'string' || snapshot.sourceSessionId.length === 0) {
    throw new TypeError('invalid session fork snapshot')
  }
  const replacements = new Map<string, Record<string, unknown>>()
  for (const resource of snapshot.resources) {
    const ref = record(resource.ref)
    if (typeof ref?.attachmentId !== 'string' || typeof resource.data !== 'string') throw new TypeError('invalid fork attachment')
    const data = Buffer.from(resource.data, 'base64')
    if (data.toString('base64') !== resource.data) throw new TypeError('invalid fork attachment encoding')
    const store = ctx.get('attachments')
    if (store === undefined) throw new Error('session fork requires an attachment store')
    const name = typeof ref.name === 'string' ? { name: ref.name } : {}
    const kind = forkAttachmentKind(resource.kind)
    const saved = kind === 'image'
      ? await store.saveImage({ data, mediaType: ref.mediaType as ImageAttachmentRef['mediaType'], ...name })
      : await store.saveFile({ data, ...name })
    replacements.set(ref.attachmentId, { ...ref, ...saved })
  }
  const events = structuredClone(snapshot.events)
  walk(events, (block) => {
    const attachment = record(block.attachment)
    if ((block.type === 'image' || block.type === 'file') && typeof attachment?.attachmentId === 'string'
      && !replacements.has(attachment.attachmentId)) throw new Error('fork snapshot is missing attachment bytes')
  })
  walk(events, (object) => {
    if (typeof object.attachmentId !== 'string') return
    const replacement = replacements.get(object.attachmentId)
    if (replacement !== undefined) Object.assign(object, replacement)
  })
  return events
}

function forkAttachmentKind(kind: unknown): 'image' | 'file' {
  if (kind !== 'image' && kind !== 'file') throw new TypeError('invalid fork attachment kind')
  return kind
}
