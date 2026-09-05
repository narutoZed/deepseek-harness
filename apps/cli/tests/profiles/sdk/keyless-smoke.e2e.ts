import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../src/bin.ts', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const decompress = promisify(zstdDecompress)

function waitForLine(
  lines: string[],
  predicate: (value: Record<string, unknown>) => boolean,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000
    const poll = (): void => {
      while (lines.length > 0) {
        const line = lines.shift()!
        if (!line.trim()) continue
        try {
          const value = JSON.parse(line) as Record<string, unknown>
          if (predicate(value)) {
            resolve(value)
            return
          }
        } catch {
          reject(new Error(`non-JSON stdout from JSON-RPC agent runtime: ${line}`))
          return
        }
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for JSON-RPC response; stderr=${stderr()}`))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('Python SDK dsh profile keyless smoke', () => {
  it.each([
    { label: 'reports max-token turns with the default mapping config', envValue: undefined },
    { label: 'reports max-token turns with mapping enabled through env', envValue: 'true' },
    { label: 'reports max-token turns with mapping disabled through env', envValue: 'false' },
  ])('$label', async ({ envValue }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-runtime-smoke-'))
    const modelRequests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
    // The line-predicate protocol driving below is the genuinely custom part;
    // execa owns spawn, the deadline, and exit settlement around it.
    const child = execa(process.execPath, [
      '--import',
      'tsx/esm',
      binScript,
      '--profile',
      'sdk',
    ], {
      cwd: repoRoot,
      env: {
        DSH_HOME: join(root, '.dsh'),
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        ...(envValue === undefined ? {} : { DSH_MAX_TOKENS_AS_SUCCESS: envValue }),
      },
      timeout: 35_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          cwd: root,
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
          maxTokens: 1234,
        },
      })}\n`)
      const initialized = await waitForLine(lines, value => value.id === 1, () => stderr)
      expect(initialized).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { serverInfo: { name: 'deepseek-harness-sdk-runtime' } },
      })

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'main', contentBlocks: [{ type: 'text', text: 'inspect tools' }] },
      })}\n`)
      const prompt = await waitForLine(lines, value => value.id === 2, () => stderr)
      expect(prompt).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { messageId: expect.any(String) as unknown },
      })
      const turnEnd = await waitForLine(lines, (value) => {
        if (value.method !== 'session.event') return false
        const params = value.params as Record<string, unknown> | undefined
        const event = params?.event as Record<string, unknown> | undefined
        return params?.sessionId === 'main' && event?.type === 'turn/end'
      }, () => stderr)
      expect(turnEnd).toMatchObject({
        jsonrpc: '2.0',
        method: 'session.event',
        params: {
          sessionId: 'main',
          event: {
            type: 'turn/end',
            data: { reason: { kind: 'max-tokens' } },
          },
        },
      })
      const tools = modelRequests[0]?.tools as { function?: { name?: string } }[]
      const toolNames = tools.map(tool => tool.function?.name)
      expect(modelRequests[0]?.reasoning_effort).toBe('max')
      expect(modelRequests[0]?.max_tokens).toBe(1234)
      expect(toolNames).toEqual(expect.arrayContaining(['web_fetch', 'web_search']))
      expect(toolNames).not.toContain('list_subagent_models')

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      const shutdown = await waitForLine(lines, value => value.id === 3, () => stderr)
      expect(shutdown).toMatchObject({ jsonrpc: '2.0', id: 3, result: {} })
      const exit = await child
      expect(exit.exitCode, `signal=${String(exit.signal)}; stderr=${stderr}`).toBe(0)
      const sessionsRoot = join(root, '.dsh', 'sessions')
      const files = await readdir(sessionsRoot, { recursive: true })
      const log = files.find(file => file.endsWith('.jsonl.zstd'))
      expect(log).toBeDefined()
      const compressed = await readFile(join(sessionsRoot, log!))
      expect(compressed.subarray(0, 4).toString('hex')).toBe('28b52ffd')
      expect(JSON.parse((await decompress(compressed)).toString())).toMatchObject({ type: 'session', id: 'main' })
    } finally {
      // No-op after exit; reject: false settles on every outcome, so cleanup never races teardown.
      child.kill('SIGKILL')
      await child
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('boots the standalone minimal profile through its generated manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-minimal-'))
    const modelServer = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('model server did not bind a TCP port')
    const child = execa(process.execPath, [
      '--import',
      'tsx/esm',
      binScript,
      '--profile',
      'sdk-minimal',
    ], {
      cwd: repoRoot,
      env: {
        DSH_HOME: join(root, '.dsh'),
        DSH_SYSTEM_PROMPT: 'Minimal allowlist prompt.',
        DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
      timeout: 35_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    const lines: string[] = []
    let stdoutBuffer = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const parts = stdoutBuffer.split('\n')
      stdoutBuffer = parts.pop() ?? ''
      lines.push(...parts)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      })}\n`)
      await waitForLine(lines, value => value.id === 1, () => stderr)
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId: 'minimal', contentBlocks: [{ type: 'text', text: 'inspect tools' }] },
      })}\n`)
      await waitForLine(lines, (value) => {
        const params = value.params as Record<string, unknown> | undefined
        const event = params?.event as Record<string, unknown> | undefined
        return params?.sessionId === 'minimal' && event?.type === 'turn/end'
      }, () => stderr)

      const profile = JSON.parse(
        await readFile(join(root, '.dsh', 'profiles', 'sdk-minimal', 'package.json'), 'utf8'),
      ) as { dsh?: { profile?: { bundles?: string[]; patchReload?: string } } }
      expect(profile.dsh?.profile).toEqual({
        bundles: ['@deepseek-ai/dsh-sdk-minimal'],
        patchReload: 'startup',
      })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'shutdown' })}\n`)
      await waitForLine(lines, value => value.id === 3, () => stderr)
      const exit = await child
      expect(exit.exitCode, `signal=${String(exit.signal)}; stderr=${stderr}`).toBe(0)
    } finally {
      child.kill('SIGKILL')
      await child
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)

  it('rejects an invalid max-token success env value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-python-sdk-runtime-invalid-'))
    try {
      const { exitCode, stdout, stderr } = await execa(process.execPath, [
        '--import',
        'tsx/esm',
        binScript,
        '--profile',
        'sdk',
      ], {
        cwd: repoRoot,
        env: {
          DSH_HOME: join(root, '.dsh'),
          DEEPSEEK_API_KEY: 'keyless-smoke-no-call',
          DSH_MAX_TOKENS_AS_SUCCESS: 'sometimes',
        },
        stdin: 'ignore',
        timeout: 25_000,
        killSignal: 'SIGKILL',
        reject: false,
      })

      expect(exitCode, stderr).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('plugin tree failed to load')
      expect(stderr).toContain('failed to apply loader entry sdk-jsonrpc-server (@deepseek-ai/dsh-sdk-jsonrpc-server)')
      expect(stderr).toContain('sometimes')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('SDK durable session restart', () => {
  it('keeps the first conversation when a replacement process prompts the same session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-resume-'))
    const requests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        requests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":"answer"}}]}\n\n')
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      for (const prompt of ['first question', 'second question']) {
        const child = execa(process.execPath, ['--import', 'tsx/esm', binScript, '--profile', 'sdk'], {
          cwd: repoRoot,
          env: {
            DSH_HOME: join(root, '.dsh'), DSH_TELEMETRY_DISABLED: '1',
            DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          },
          timeout: 35_000, killSignal: 'SIGKILL', reject: false,
        })
        const lines: string[] = []
        let buffer = ''
        let stderr = ''
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const complete = buffer.split('\n')
          buffer = complete.pop() ?? ''
          lines.push(...complete)
        })
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
        const send = (id: number, method: string, params?: object): void => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
        }
        try {
          send(1, 'initialize', { cwd: root, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
          const initialized = await waitForLine(lines, value => value.id === 1, () => stderr)
          expect(initialized.error, stderr).toBeUndefined()
          expect(initialized).toHaveProperty('result')
          send(2, 'session/prompt', { sessionId: 'durable', contentBlocks: [{ type: 'text', text: prompt }] })
          expect(await waitForLine(lines, value => value.id === 2, () => stderr)).toHaveProperty('result.messageId')
          await waitForLine(lines, value => value.method === 'session.status'
            && (value.params as { status?: string })?.status === 'idle', () => stderr)
          send(3, 'shutdown')
          expect(await waitForLine(lines, value => value.id === 3, () => stderr)).toHaveProperty('result')
          child.stdin.end()
          const exit = await child
          expect(exit.timedOut).toBe(false)
          expect(exit.signal).toBeUndefined()
          expect(exit.exitCode).toBe(0)
        } finally {
          child.kill('SIGKILL')
          await child
        }
      }
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain('first question')
      expect(JSON.stringify(requests[1]?.messages)).toContain('second question')
    } finally {
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SDK human interaction', () => {
  it('continues the real ask_user_question tool after a typed SDK answer', async () => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-interaction-'))
    const patch = join(root, 'questions.patch.yml')
    await writeFile(patch, JSON.stringify([{ insert: [{
      id: 'sdk-question-test-tool',
      name: join(repoRoot, 'packages/interaction/tool-ask-user/lib/index.js'),
    }] }]))
    const requests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        requests.push(JSON.parse(body) as Record<string, unknown>)
        const first = requests.length === 1
        const delta = first ? { tool_calls: [{ index: 0, id: 'question-call', type: 'function', function: {
          name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'task', question: 'Which task?' }] }),
        } }] } : { content: 'The selected task is recorded.' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    let harness: InstanceType<typeof DeepSeekHarness> | undefined
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      harness = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), profile: 'sdk', patches: [patch], env: {
        ...process.env, DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: '1',
      } })
      const client = harness.client
      const responses: Promise<boolean>[] = []
      const result = await harness.run('Ask me which task to do', { sessionId: 'questions', onNotification: (notification) => {
        if (notification.method === 'interaction.request') {
          const interactionId = notification.params.interactionId
          if (typeof interactionId !== 'string') throw new Error('interaction has no id')
          responses.push(client.respondInteraction(interactionId, [
            { id: 'task', selected: [], custom: 'Inspect the SDK' },
          ]))
        }
      } })
      expect(await Promise.all(responses), JSON.stringify(result.events.filter(event => event.type === 'tool/result'))).toEqual([true])
      expect(result.finalResponse).toBe('The selected task is recorded.')
      expect(JSON.stringify(requests[1]?.messages)).toContain('Inspect the SDK')
    } finally {
      await harness?.close()
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SDK next-step steering', () => {
  it('delivers identified steering while the first model response is still pending', async () => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-steer-'))
    const firstRequest = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const requests: Record<string, unknown>[] = []
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        requests.push(JSON.parse(body) as Record<string, unknown>)
        const send = (): void => {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('data: {"choices":[{"delta":{"role":"assistant","content":"done"}}]}\n\n')
          response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        }
        if (requests.length === 1) {
          firstRequest.resolve(undefined)
          void release.promise.then(send)
        } else send()
      })
    })
    let harness: InstanceType<typeof DeepSeekHarness> | undefined
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      harness = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), profile: 'sdk', env: {
        ...process.env, DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: '1',
      } })
      const run = harness.run('Start work', { sessionId: 'main', requestId: 'root-input' })
      // A failed control assertion still closes the runtime and settles this run.
      void run.catch(() => undefined)
      await firstRequest.promise
      const messageId = await harness.client.steer('main', [{ type: 'text', text: 'new direction' }], 'steer-input')
      expect(messageId).toBeTypeOf('string')
      expect(await harness.client.steer('main', [{ type: 'text', text: 'new direction' }], 'steer-input')).toBe(messageId)
      release.resolve(undefined)
      const result = await run
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.messages)).toContain('new direction')
      expect(result.events.some(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.id === messageId))).toBe(true)
    } finally {
      release.resolve(undefined)
      await harness?.close()
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SDK assistant streaming', () => {
  it('publishes live text before the model response and durable message finish', async () => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const { vi } = await import('vitest')
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-stream-'))
    const release = Promise.withResolvers<undefined>()
    const modelServer = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":"first"}}]}\n\n')
        void release.promise.then(() => {
          response.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n')
          response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        })
      })
    })
    let harness: InstanceType<typeof DeepSeekHarness> | undefined
    let run: ReturnType<InstanceType<typeof DeepSeekHarness>['run']> | undefined
    let liveChunk: unknown
    let durable = false
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      harness = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), profile: 'sdk', env: {
        ...process.env, DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: '1',
      } })
      run = harness.run('Stream a short answer', { sessionId: 'stream', onNotification: (notification) => {
        if (notification.method === 'session.assistant_stream') {
          const frame = notification.params.frame as { type?: string; chunk?: unknown }
          if (frame.type === 'chunk') liveChunk = frame.chunk
        }
        if (notification.method === 'session.event'
          && (notification.params.event as { type?: string }).type === 'assistant/message') durable = true
      } })
      void run.catch(() => undefined)
      await vi.waitFor(() => { expect(liveChunk).toMatchObject({ type: 'text-delta', text: 'first' }) }, { timeout: 30_000 })
      expect(durable).toBe(false)
      release.resolve(undefined)
      expect((await run).finalResponse).toBe('first second')
      expect(durable).toBe(true)
    } finally {
      release.resolve(undefined)
      await harness?.close()
      await run?.catch(() => undefined)
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SDK subagent metadata', () => {
  it.each([true, false])('reports structured metadata for background=%s without parsing tool receipts', async (background) => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-metadata-'))
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages
        const child = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('metadata-child'))
        const followup = messages.some(message => message.role === 'tool')
        const delta = child || followup ? { content: child ? 'child answer' : 'root done' } : {
          tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
            description: 'Inspect native SDK metadata', prompt: 'metadata-child', run_in_background: background,
          }) } }],
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: child || followup ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    let harness: InstanceType<typeof DeepSeekHarness> | undefined
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      harness = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), profile: 'sdk', env: {
        ...process.env, DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: '1',
      } })
      const result = await harness.run('metadata-root', { sessionId: 'root' })
      expect(result.finalResponse).toBe('root done')
      const started = result.notifications.find(notification => notification.method === 'subagent.started')
      expect(started?.params.parentSessionId).toBe('root')
      if (background) {
        expect(started?.params).toMatchObject({
          label: 'Inspect native SDK metadata', mode: 'continuable', provider: 'spawn',
        })
      } else {
        // Foreground descriptors are appended at the first pre-step, after creation.
        const metadata = result.notifications.find(notification => notification.method === 'session.event'
          && notification.params.sessionId === started?.params.childSessionId
          && (notification.params.event as { type?: string }).type === 'subagent/descriptor')
        expect(metadata?.params.event).toMatchObject({ data: {
          label: 'Inspect native SDK metadata', mode: 'one-shot', provider: 'spawn',
        } })
      }
      expect(started?.params.childSessionId).toBeTypeOf('string')
      expect(started?.params).not.toHaveProperty('persona')
      expect(started?.params).not.toHaveProperty('prompt')
    } finally {
      await harness?.close()
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('SDK session-tree settlement', () => {
  it('waits past root idle for a background child and the parent synthesis', async () => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client')
    const { vi } = await import('vitest')
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-settlement-'))
    const release = Promise.withResolvers<undefined>()
    let rootIdle = false
    let completed = false
    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] }).messages
        const child = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('settlement-child'))
        const followup = messages.some(message => message.role === 'tool')
        const hasAnswer = messages.some(message => JSON.stringify(message.content).includes('finished-child-answer'))
        const delta = child || followup ? { content: child ? 'finished-child-answer' : hasAnswer ? 'final parent synthesis' : 'waiting for child' } : {
          tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'subagent', arguments: JSON.stringify({
            description: 'Wait for a delayed child', prompt: 'settlement-child', run_in_background: true,
          }) } }],
        }
        const send = (): void => {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`)
          response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
          response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: child || followup ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
        }
        if (child) void release.promise.then(send)
        else send()
      })
    })
    let harness: InstanceType<typeof DeepSeekHarness> | undefined
    try {
      await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
      const address = modelServer.address()
      if (address === null || typeof address === 'string') throw new Error('no model port')
      harness = new DeepSeekHarness({ cwd: root, dshHome: join(root, '.dsh'), profile: 'sdk', env: {
        ...process.env, DEEPSEEK_API_KEY: 'keyless-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_TELEMETRY_DISABLED: '1',
      } })
      const run = harness.run('settlement-root', { sessionId: 'root', onNotification(notification) {
        if (notification.method === 'session.status' && notification.params.sessionId === 'root' && notification.params.status === 'idle') rootIdle = true
      } })
      void run.then(() => { completed = true }, () => { completed = true })
      await vi.waitFor(() => { expect(rootIdle).toBe(true) }, { timeout: 30_000 })
      expect(completed).toBe(false)
      release.resolve(undefined)
      const result = await run
      expect(result.finalResponse).toBe('final parent synthesis')
      expect(result.notifications.at(-1)?.method).toBe('session.settled')
      expect(result.events.filter(event => event.type === 'turn/end')).toHaveLength(2)
    } finally {
      release.resolve(undefined)
      await harness?.close()
      await new Promise<void>(resolve => modelServer.close(() => { resolve() }))
      await rm(root, { recursive: true, force: true })
    }
  })
})
