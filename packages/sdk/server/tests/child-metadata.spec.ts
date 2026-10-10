import { expect, it } from 'vitest'
import { sdkChildMetadataProjection } from '../src/child-metadata.ts'

it.each([undefined, 'Research child'])('round-trips a descriptor checkpoint with label %s', (label) => {
  const checkpoint = { seq: 4, mode: 'one-shot', provider: 'spawn', ...(label === undefined ? {} : { label }) }
  expect(sdkChildMetadataProjection.stateSchema.parse(checkpoint)).toEqual(checkpoint)
  expect(sdkChildMetadataProjection.stateSchema.parse(null)).toBeNull()
  expect(() => sdkChildMetadataProjection.stateSchema.parse({ ...checkpoint, provider: 3 })).toThrow()
})
