import { describe, expect, it } from 'vitest'
import { SdkSessionSettlement } from '../src/session-settlement.ts'

function activity() {
  const settled: string[] = []
  const tracker = new SdkSessionSettlement(id => settled.push(id))
  return { tracker, settled }
}

describe('SDK session-tree settlement', () => {
  it('publishes once for a plain root and permits its next interval', () => {
    const { tracker, settled } = activity()
    tracker.status('root', 'idle')
    tracker.begin('root')
    tracker.inbox('root', 1, 0)
    tracker.status('root', 'running')
    tracker.inbox('root', 0, 1)
    tracker.status('root', 'idle')
    tracker.status('root', 'idle')
    expect(settled).toEqual(['root'])
    tracker.begin('root')
    tracker.status('root', 'idle')
    expect(settled).toEqual(['root', 'root'])
  })

  it('waits through root idle and the child-notice gap before the parent runs again', () => {
    const { tracker, settled } = activity()
    tracker.begin('root')
    tracker.linkChild('child', 'root')
    tracker.startSubagent('epoch', 'root')
    tracker.status('root', 'idle')
    expect(settled).toEqual([])
    tracker.inbox('root', 1, 0)
    tracker.endSubagent('epoch')
    expect(settled).toEqual([])
    tracker.status('root', 'running')
    tracker.inbox('root', 0, 1)
    tracker.status('root', 'idle')
    expect(settled).toEqual(['root'])
  })

  it('waits through provider preparation and its handoff to a published run', () => {
    const { tracker, settled } = activity()
    const preparation = Symbol('preparation')
    tracker.begin('root')
    tracker.startSubagent(preparation, 'root')
    tracker.status('root', 'idle')
    expect(settled).toEqual([])
    tracker.startSubagent('run', 'root')
    tracker.endSubagent(preparation)
    expect(settled).toEqual([])
    tracker.endSubagent('run')
    expect(settled).toEqual(['root'])
  })

  it('unblocks when provider preparation fails without publishing a run', () => {
    const { tracker, settled } = activity()
    const preparation = Symbol('preparation')
    tracker.begin('root')
    tracker.startSubagent(preparation, 'root')
    tracker.status('root', 'idle')
    expect(settled).toEqual([])
    tracker.endSubagent(preparation)
    expect(settled).toEqual(['root'])
  })

  it('retains nested lineage when an intermediate epoch ends first', () => {
    const { tracker, settled } = activity()
    tracker.begin('root')
    tracker.linkChild('middle', 'root')
    tracker.linkChild('leaf', 'middle')
    tracker.startSubagent('middle-run', 'root')
    tracker.startSubagent('leaf-run', 'middle')
    tracker.status('root', 'idle')
    tracker.endSubagent('middle-run')
    expect(settled).toEqual([])
    tracker.endSubagent('leaf-run')
    expect(settled).toEqual(['root'])
  })

  it('does not count a created child whose preparation never becomes a run', () => {
    const { tracker, settled } = activity()
    tracker.begin('root')
    tracker.linkChild('failed-start', 'root')
    tracker.status('root', 'idle')
    expect(settled).toEqual(['root'])
  })

  it('tracks resumed epochs independently and includes work preceding the next prompt', () => {
    const { tracker, settled } = activity()
    tracker.linkChild('child', 'root')
    tracker.startSubagent('old-epoch', 'root')
    tracker.endSubagent('old-epoch')
    tracker.startSubagent('resumed-epoch', 'root')
    tracker.begin('root')
    tracker.status('root', 'idle')
    tracker.endSubagent('old-epoch')
    expect(settled).toEqual([])
    tracker.endSubagent('resumed-epoch')
    expect(settled).toEqual(['root'])
  })

  it('waits for a remote native run without blocking unrelated roots', () => {
    const { tracker, settled } = activity()
    tracker.begin('a')
    tracker.begin('b')
    tracker.startSubagent('remote-run', 'a')
    tracker.status('a', 'idle')
    tracker.status('b', 'idle')
    expect(settled).toEqual(['b'])
    tracker.endSubagent('remote-run')
    expect(settled).toEqual(['b', 'a'])
  })

  it('accounts for cancelled and preexisting inbox messages without negative counts', () => {
    const { tracker, settled } = activity()
    tracker.inbox('not-owned', 1, 0)
    tracker.begin('root')
    tracker.inbox('root', 2, 0)
    tracker.status('root', 'idle')
    expect(settled).toEqual([])
    tracker.inbox('root', 0, 3)
    expect(settled).toEqual(['root'])
  })

  it('does not hang on corrupt unrelated lineage or publish after teardown', () => {
    const { tracker, settled } = activity()
    tracker.linkChild('a', 'b')
    tracker.linkChild('b', 'a')
    tracker.startSubagent('unrelated', 'a')
    tracker.begin('root')
    tracker.status('root', 'idle')
    expect(settled).toEqual(['root'])
    tracker.close()
    tracker.begin('later')
    tracker.linkChild('child', 'later')
    tracker.startSubagent('late-run', 'later')
    tracker.status('later', 'idle')
    tracker.inbox('later', 0, 1)
    tracker.endSubagent('late-run')
    expect(settled).toEqual(['root'])
  })
})
