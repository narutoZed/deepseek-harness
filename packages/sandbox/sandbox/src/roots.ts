/**
 * Canonical writable directories shared by process profiles and filesystem tools.
 * Deployment grants supplement the workspace and platform temporary directories
 * only under workspace-write; read-only grants no directory writes.
 * @module dsh-sandbox/roots
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxExecutionPolicy } from './index.ts'

/**
 * Resolve a granted root to the path the enforcement layer actually compares:
 * canonical (symlinks resolved), because both Seatbelt filters and the fs
 * fence's containment check match resolved paths — `/tmp` IS `/private/tmp`
 * on darwin, and an as-spelled grant would match nothing.
 * @param path - the root as configured or platform-reported.
 * @returns the canonical path, or the spelling as-is when resolution fails
 *   (a missing root matches nothing until it exists — the conservative
 *   outcome; inventing a fallback would grant a path the caller never named).
 */
export function canonicalPath(path: string): string {
  try {
    // Node's JavaScript realpath implementation lexically collapses `..`
    // before resolving a preceding symlink on some platforms. The native
    // implementation follows the filesystem's component-by-component lookup,
    // matching chdir/spawn and the enforcement layers this identity feeds.
    return realpathSync.native(path)
  } catch {
    // realpathSync.native failed: the path (or a prefix) is missing or unreadable.
    return path
  }
}

/**
 * The roots one confined execution may WRITE under — the mode's meaning as a
 * canonical, deduplicated allow-list. `read-only` allows nothing;
 * `workspace-write` allows the policy's workspace root, the host `/tmp`, and
 * deployment-authorized directories and the per-user platform temp dir (`os.tmpdir()` — the real temp area for
 * mkstemp-family tools; omitting it would deny what the mode promises).
 * @param policy - the file-effect policy to derive the allow-list from.
 * @returns the canonical writable roots; empty exactly under `read-only`.
 * @throws when a deployment-authorized root resolves to a different path after registration.
 */
export function writableRoots(policy: SandboxExecutionPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const additional = policy.additionalWritableRoots ?? []
  for (const root of additional) {
    if (canonicalPath(root) !== root) throw new Error(`Authorized writable directory changed its filesystem identity: ${root}`)
  }
  const standard = [policy.workspaceRoot, '/tmp', tmpdir()].map(canonicalPath)
  return [...new Set([...standard, ...additional])]
}
