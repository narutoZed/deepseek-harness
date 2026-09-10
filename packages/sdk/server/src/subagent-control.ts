/** SDK control admission through the native durable subagent service. @module dsh-sdk-jsonrpc-server/subagent-control */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentPromptRequestId } from '@deepseek-ai/dsh-subagent'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import type { SdkSubagentPromptParams, SdkSubagentInterruptParams, SdkSubagentPromptResult } from '@deepseek-ai/dsh-sdk-protocol'
import type { SdkSessionSettlement } from './session-settlement.ts'

function failure(code: string): JsonRpcResponseError {
  return new JsonRpcResponseError(-32000, 'The subagent control request could not be admitted.', { code })
}

function rejectControl(error: unknown): never {
  if (error instanceof JsonRpcResponseError) throw error
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
    && error.code.startsWith('subagent/') ? error.code : 'subagent/delivery-unavailable'
  throw failure(code)
}

/** Authorizes descendants and owns in-flight control calls until shutdown. */
export class SdkSubagentControl {
  private readonly abort = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly deliveries = new Map<string, { fingerprint: string; result: Promise<SdkSubagentPromptResult> }>()

  /**
   * @param ctx - native service owner.
   * @param root - open an SDK root without model input.
   * @param settlement - root activity observer.
   */
  constructor(private readonly ctx: Context, private readonly root: (id: string) => Promise<Agent>,
    private readonly settlement: SdkSessionSettlement) {}

  private isClosed(): boolean { return this.abort.signal.aborted }

  private async target(params: SdkSubagentInterruptParams | null | undefined) {
    if (this.isClosed()) throw failure('subagent/delivery-unavailable')
    if (!params || [params.rootSessionId, params.parentSessionId, params.childSessionId]
      .some(value => typeof value !== 'string' || value.length === 0)) {
      throw new TypeError('Subagent control requires non-empty rootSessionId, parentSessionId and childSessionId')
    }
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) throw failure('subagent/control-unavailable')
    const root = await this.root(params.rootSessionId)
    const entries = await subagents.listDescendants(brandString<SessionId>(params.rootSessionId), this.abort.signal)
    const child = entries.find(entry => entry.id === params.childSessionId)
    if (child === undefined || child.parentId !== params.parentSessionId) throw failure('subagent/unauthorized')
    if (child.kind !== 'child' || child.mode !== 'continuable') throw failure('subagent/not-resumable')
    if (this.isClosed() || this.ctx.agents.get(root.id) !== root) throw failure('subagent/parent-unavailable')
    return { root, subagents }
  }

  /**
   * Queue a message into its original continuable child; native code may cold-resume it.
   * @param params - root, exact direct parent/child, caller request id and content.
   * @returns durable inbox identity; an in-process identical retry is marked replayed.
   * @throws on invalid input, unrelated lineage, conflicting retry, or unavailable continuation.
   */
  async prompt(params: SdkSubagentPromptParams | null | undefined): Promise<SdkSubagentPromptResult> {
    if (!params || typeof params.requestId !== 'string' || !params.requestId || !Array.isArray(params.content) || params.content.length === 0) {
      throw new TypeError('subagent/prompt requires requestId and non-empty content')
    }
    const key = JSON.stringify([params.rootSessionId, params.requestId])
    const fingerprint = JSON.stringify([params.rootSessionId, params.parentSessionId, params.childSessionId,
      params.content, params.clientTimeZone ?? null])
    const existing = this.deliveries.get(key)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw failure('idempotency_conflict')
      return { ...await existing.result, replayed: true }
    }
    const result = this.track(this.deliver(params).catch((error: unknown) => {
      this.deliveries.delete(key)
      return rejectControl(error)
    }))
    this.deliveries.set(key, { fingerprint, result })
    return result
  }

  private async deliver(params: SdkSubagentPromptParams): Promise<SdkSubagentPromptResult> {
    const { root, subagents } = await this.target(params)
    this.settlement.begin(params.rootSessionId)
    try {
      const result = await subagents.prompt({
        requestId: brandString<SubagentPromptRequestId>(params.requestId),
        parentSessionId: brandString<SessionId>(params.parentSessionId),
        childSessionId: brandString<SessionId>(params.childSessionId), mode: 'continuable', delivery: 'queue',
        content: params.content,
        ...(params.clientTimeZone === undefined ? {} : { clientTimeZone: params.clientTimeZone }),
      }, this.abort.signal)
      return { messageId: String(result.messageId), replayed: false }
    } finally {
      // A child delivery need not wake its parent; sample the actual root driver.
      this.settlement.status(params.rootSessionId, root.status)
    }
  }

  /**
   * Request interruption of the selected child's activation only.
   * @param params - SDK root and exact direct parent/child address.
   * @returns acknowledgement of the signal, not proof of process quiescence.
   * @throws when lineage is unrelated or the control service is unavailable.
   */
  interrupt(params: SdkSubagentInterruptParams): Promise<{ accepted: true }> {
    return this.track(this.interruptTarget(params))
  }

  private async interruptTarget(params: SdkSubagentInterruptParams): Promise<{ accepted: true }> {
    try {
      const { subagents } = await this.target(params)
      return subagents.interruptByParent(brandString<SessionId>(params.childSessionId),
        brandString<SessionId>(params.parentSessionId), 'continuable')
    } catch (error: unknown) { return rejectControl(error) }
  }

  private track<T>(result: Promise<T>): Promise<T> {
    this.pending.add(result)
    void result.then(() => { this.pending.delete(result) }, () => { this.pending.delete(result) })
    return result
  }

  /** Cancel outstanding admission and wait until every native call is quiescent. */
  async close(): Promise<void> {
    this.abort.abort()
    await Promise.allSettled([...this.pending])
    this.deliveries.clear()
  }
}
