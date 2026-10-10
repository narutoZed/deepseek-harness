/** Native permission questions owned by one SDK server lifetime. @module dsh-sdk-jsonrpc-server/approvals */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import type { ApprovalRespondParams, JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'

type Answer = 'allowed-once' | 'rejected' | 'cancelled'
interface PendingApproval {
  sessionId: string
  settle: (outcome: Answer) => void
}

/** Maps explicit answers to single-use native grants; cancellation never grants access. */
export class SdkApprovals {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly dispose: () => void
  private closed = false

  /**
   * @param ctx - event owner.
   * @param transport - SDK notification channel.
   * @param owns - exact SDK agent ownership.
   */
  constructor(ctx: Context, private readonly transport: JsonRpcTransportPeer, owns: (agent: Agent) => boolean) {
    this.dispose = ctx.on('approval/request', (request, next) => {
      if (this.closed || !owns(request.agent)) return next()
      return this.ask(request)
    }, { global: true })
  }

  private ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return Promise.resolve('cancelled')
    const interactionId = randomUUID()
    const sessionId = String(request.agent.session.id)
    return new Promise<Answer>((resolve) => {
      const settle = (outcome: Answer): void => {
        if (!this.pending.delete(interactionId)) return
        request.signal?.removeEventListener('abort', abort)
        resolve(outcome)
        if (!this.closed) {
          try { this.transport.notify('approval.resolved', { sessionId, interactionId, outcome }) }
          catch { /* The question is settled even when the transport has closed. */ }
        }
      }
      const abort = (): void => { settle('cancelled') }
      this.pending.set(interactionId, { sessionId, settle })
      request.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.transport.notify('approval.request', { sessionId, interactionId, toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
          ...(request.reason === undefined ? {} : { reason: request.reason }) })
      } catch {
        settle('cancelled')
      }
    })
  }

  /**
   * Resolve one current request under its exact session identity.
   * @param params - session, question and allow-once/reject decision from the wire.
   * @returns a consumed-question acknowledgement.
   * @throws when malformed, withdrawn, consumed, or owned by another session.
   */
  respond(params: ApprovalRespondParams | null | undefined): { accepted: true } {
    if (!params || typeof params.sessionId !== 'string' || typeof params.interactionId !== 'string'
      || !['approved', 'cancelled'].includes(params.decision)) {
      throw new TypeError('approval/respond requires sessionId, interactionId and approved/cancelled decision')
    }
    const pending = this.pending.get(params.interactionId)
    if (this.closed || pending?.sessionId !== params.sessionId) {
      throw new JsonRpcResponseError(-32000, 'The permission request is no longer available.', { code: 'interaction_expired' })
    }
    pending.settle(params.decision === 'approved' ? 'allowed-once' : 'rejected')
    return { accepted: true }
  }

  /** Withdraw all questions and detach the answerer before server teardown. */
  close(): void {
    this.closed = true
    try { this.dispose() }
    finally { for (const pending of this.pending.values()) pending.settle('cancelled') }
  }
}
