/** Test-only operations for permission decisions and independently cancellable children. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'sdk-control-fixture'
export const inject = ['tools', 'approval', 'workingDirectory']
export function apply(ctx, config) {
  const output = { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }
  ctx.tools.register({
    name: 'control_protected', description: 'Perform the isolated test action after one explicit approval.',
    parameters: {}, output,
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('Test operation requires its agent')
      const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'control_protected',
        callId: exec.callId, reason: 'Write the isolated test marker once', signal: exec.signal })
      if (outcome !== 'allowed-once') return `DENIED:${outcome}`
      const path = join(ctx.workingDirectory.get(exec.agent.session), 'controlled-actions.json')
      let count = 0
      try { count = JSON.parse(await readFile(path, 'utf8')).count } catch (error) { if (error.code !== 'ENOENT') throw error }
      await writeFile(path, JSON.stringify({ count: count + 1 }))
      return 'ACTION_ALLOWED'
    },
  })
  ctx.tools.register({
    name: 'control_wait', description: 'Wait on one isolated test gate until released or cancelled.',
    parameters: { gate: { type: 'string', enum: ['first', 'sibling'], required: true } }, output,
    async execute(args, exec) {
      const response = await fetch(`${config.gateUrl}/wait/${args.gate}`, { signal: exec.signal })
      if (!response.ok) throw new Error('Test gate failed')
      return response.text()
    },
  })
}
