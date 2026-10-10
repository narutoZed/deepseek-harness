/**
 * SDK activity notifications over the native root and descendant waiter.
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/session-settlement
 */

interface RootActivity {
  revision: number
  awaiting: boolean
  idle: boolean
  pending: number
  checking: boolean
}

/** Publish one settled interval after the native manager joins progressing work. */
export class SdkSessionSettlement {
  private readonly roots = new Map<string, RootActivity>()
  private readonly parents = new Map<string, string>()
  private readonly tasks = new Set<Promise<void>>()
  private closed = false

  /**
   * @param wait - joins the root and native descendant work without closing parked children.
   * @param onSettled - publishes completion or a native waiter failure for this interval.
   */
  constructor(
    private readonly wait: (sessionId: string) => Promise<void>,
    private readonly onSettled: (sessionId: string, error?: Error) => void,
  ) {}

  /**
   * Begin or extend the interval owned by an accepted SDK prompt.
   * @param sessionId - SDK root receiving the prompt.
   */
  begin(sessionId: string): void {
    if (this.closed) return
    const activity = this.roots.get(sessionId)
      ?? { revision: 0, awaiting: false, idle: false, pending: 0, checking: false }
    activity.revision++
    activity.awaiting = true
    activity.idle = false
    this.roots.set(sessionId, activity)
  }

  /**
   * Retain native lineage across retirement and cold resume.
   * @param childId - local child session identity.
   * @param parentId - its direct parent session identity.
   */
  linkChild(childId: string, parentId: string): void {
    if (!this.closed) this.parents.set(childId, parentId)
  }

  /**
   * Observe raw driver status; idle starts a native descendant join.
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

  /** Stop publication before the server disposes its agents. */
  close(): void {
    this.closed = true
    this.roots.clear()
    this.parents.clear()
  }

  /**
   * Join waiter tasks after root and descendant teardown has unblocked them.
   * @returns completion after no SDK waiter can publish again.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.tasks])
  }

  private check(sessionId: string, activity: RootActivity): void {
    if (this.closed || !activity.awaiting || !activity.idle || activity.pending !== 0 || activity.checking) return
    activity.checking = true
    const revision = activity.revision
    const task = Promise.resolve().then(() => this.wait(sessionId)).then(
      () => { this.finish(sessionId, activity, revision) },
      (error: unknown) => {
        this.finish(sessionId, activity, revision, error instanceof Error ? error : new Error(String(error)))
      },
    )
    this.tasks.add(task)
    void task.then(() => { this.tasks.delete(task) }, () => { this.tasks.delete(task) })
  }

  private finish(sessionId: string, activity: RootActivity, revision: number, error?: Error): void {
    activity.checking = false
    if (this.closed) return
    if (activity.revision !== revision || !activity.idle || activity.pending !== 0) {
      this.check(sessionId, activity)
      return
    }
    activity.awaiting = false
    this.onSettled(sessionId, error)
  }

  /**
   * Test retained native lineage, including ancestors no longer live.
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
