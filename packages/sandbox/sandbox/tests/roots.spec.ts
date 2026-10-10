/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'

/** Every temp root created by this file, removed after each test. */
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    roots.push(dir)
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it.skipIf(process.platform === 'win32')('rejects a replaced directory instead of following its new symlink target', () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-root-identity-'))
    roots.push(base)
    const cache = join(realpathSync.native(base), 'cache')
    const target = join(realpathSync.native(base), 'target')
    mkdirSync(cache)
    mkdirSync(target)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: '/workspace', additionalWritableRoots: [cache] }
    expect(writableRoots(policy)).toContain(cache)
    rmSync(cache, { recursive: true })
    symlinkSync(target, cache, 'dir')
    expect(() => writableRoots(policy)).toThrow('changed its filesystem identity')
  })
  it('includes explicit cache roots only in workspace-write', () => {
    const policy = { workspaceRoot: '/workspace', additionalWritableRoots: ['/cache/uv'] }
    expect(writableRoots({ ...policy, mode: 'workspace-write' })).toContain('/cache/uv')
    expect(writableRoots({ ...policy, mode: 'read-only' })).toEqual([])
  })
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    roots.push(ws)
    const writable = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(writable).toContain(realpathSync.native(ws))
    expect(writable).toContain(canonicalPath('/tmp'))
    expect(writable).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(writable).size).toBe(writable.length)
  })
})
