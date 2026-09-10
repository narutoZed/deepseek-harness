/**
 * SDK-owned root activity settlement over native agent and subagent events.
 * Creation lineage alone is not active work; run epochs own descendant liveness.
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/session-settlement
 */

interface RootActivity {
  awaiting: boolean
  idle: boolean
  pending: number
}

/** Publish activity completion without changing the core agent's raw status events. */
export class SdkSessionSettlement {
  private readonly roots = new Map<string, RootActivity>()
  private readonly parents = new Map<string, string>()
  private readonly runs = new Map<string | symbol, string>()
  private closed = false

  /** @param onSettled - publishes one completed activity interval for a root. */
  constructor(private readonly onSettled: (sessionId: string) => void) {}

  /**
   * Begin or extend the interval owned by an accepted SDK prompt.
   * @param sessionId - SDK root receiving the prompt.
   */
  begin(sessionId: string): void {
    if (this.closed) return
    const activity = this.roots.get(sessionId) ?? { awaiting: false, idle: false, pending: 0 }
    activity.awaiting = true
    activity.idle = false
    this.roots.set(sessionId, activity)
  }

  /**
   * Retain local lineage across child retirement and cold resume.
   * @param childId - local child session identity.
   * @param parentId - its direct parent session identity.
   */
  linkChild(childId: string, parentId: string): void {
    if (!this.closed) this.parents.set(childId, parentId)
  }

  /**
   * Observe the core driver's status after its transition.
   * @param sessionId - session whose driver changed status.
   * @param status - raw agent status, independent of descendants.
   */
  status(sessionId: string, status: 'idle' | 'running'): void {
    const activity = this.roots.get(sessionId)
    if (activity === undefined) return
    activity.idle = status === 'idle'
    this.check(sessionId, activity)
  }

  /**
   * Observe durable next-turn mutations, including wakeups preceding driver start.
   * @param sessionId - receiving root session.
   * @param inserted - number of inserted waking messages.
   * @param removed - number of consumed or cancelled messages.
   */
  inbox(sessionId: string, inserted: number, removed: number): void {
    const activity = this.roots.get(sessionId)
    if (activity === undefined) return
    activity.pending = Math.max(0, activity.pending + inserted - removed)
    this.check(sessionId, activity)
  }

  /**
   * Track native preparation or a published run, including remote providers.
   * @param runId - process-local preparation token or unique run epoch, never a reusable child id.
   * @param parentId - local agent that owns the delegation.
   */
  startSubagent(runId: string | symbol, parentId: string): void {
    if (!this.closed) this.runs.set(runId, parentId)
  }

  /**
   * Release preparation or a run after its native terminal event.
   * @param runId - token or epoch paired with the native start event.
   */
  endSubagent(runId: string | symbol): void {
    if (!this.runs.delete(runId)) return
    for (const [sessionId, activity] of this.roots) this.check(sessionId, activity)
  }

  /** Stop publication and release all process-owned observation state. */
  close(): void {
    this.closed = true
    this.roots.clear()
    this.parents.clear()
    this.runs.clear()
  }

  private check(sessionId: string, activity: RootActivity): void {
    if (this.closed || !activity.awaiting || !activity.idle || activity.pending !== 0) return
    for (const parent of this.runs.values()) {
      if (this.belongsTo(parent, sessionId)) return
    }
    activity.awaiting = false
    this.onSettled(sessionId)
  }

  /**
   * Test retained native lineage, including ancestors whose Agent is no longer live.
   * @param parent - session whose ancestry is inspected.
   * @param root - SDK root that must own that ancestry.
   * @returns whether the session is the root or its observed descendant.
   */
  belongsTo(parent: string, root: string): boolean {
    const visited = new Set<string>()
    let current: string | undefined = parent
    while (current !== undefined && !visited.has(current)) {
      if (current === root) return true
      visited.add(current)
      current = this.parents.get(current)
    }
    return false
  }
}
