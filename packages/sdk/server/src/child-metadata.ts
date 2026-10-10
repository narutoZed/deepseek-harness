/** Child-owned descriptor metadata for synchronous SDK creation notifications. */
import { z } from 'zod'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const metadataSchema = z.object({
  seq: z.number().int().nonnegative().transform(SessionSeq),
  mode: z.enum(['one-shot', 'continuable']),
  provider: z.string(),
  label: z.string().optional(),
}).strict().transform(value => ({
  seq: value.seq, mode: value.mode, provider: value.provider,
  ...(value.label === undefined ? {} : { label: value.label }),
})).nullable()

type ChildMetadata = z.infer<typeof metadataSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    sdkChildMetadata: ChildMetadata
  }
}

function metadata(event: SessionEvent): ChildMetadata {
  try {
    const descriptor = foldSubagentDescriptor([event])
    return descriptor === undefined ? null : {
      seq: event.seq, mode: descriptor.mode, provider: descriptor.provider,
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    }
  } catch {
    // An unsupported or malformed persisted descriptor has no trustworthy display metadata.
    return null
  }
}

/** Fold descriptor fields without scanning Session history from the SDK event callback. */
export const sdkChildMetadataProjection = {
  key: 'sdkChildMetadata',
  stateSchema: metadataSchema,
  stateVersion: 1,
  init: () => null,
  apply: (state, event) => event.type === 'subagent/descriptor' ? metadata(event) : state,
} satisfies ProjectionDefinition<'sdkChildMetadata', ChildMetadata>
