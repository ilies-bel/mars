/**
 * Verifies that proposal lifecycle bus events trigger 'progress' SSE
 * broadcasts so the Progress tab updates in place without a page reload.
 *
 * The wiring being tested is the real one: `registerViewInvalidation` reading
 * the `proposal.*` rows of `VIEW_CHANNEL_FOR`. server.ts no longer hand-wires
 * any `bus.on(...) => hub.broadcast(...)` pair, so this file exercises the
 * subscriber directly rather than a local copy of the wiring.
 *
 * The hub itself (fan-out to SSE clients) is tested in http-view-stream.test.ts.
 * This file focuses purely on the bus-event → hub mapping.
 *
 * Acceptance criteria covered:
 *   - Proposal lifecycle events (added, promoted, sliced, dismissed) update
 *     Proposal nodes on the DAG in place.
 *   - No periodic full-refresh poll is used for these updates.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ViewStreamHub } from '../view/stream-hub'
import { registerViewInvalidation } from '../../../bus/view-invalidation'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proposal lifecycle → SSE progress broadcast', () => {
  it.each([
    'proposal.added',
    'proposal.updated',
    'proposal.dismissed',
    'proposal.promoted',
    'proposal.sliced',
    'proposal.deleted',
  ])('%s emits the progress channel on the SSE hub', (event) => {
    const bus = new EventEmitter()
    const hub = new ViewStreamHub()
    const broadcastSpy = vi.spyOn(hub, 'broadcast')

    registerViewInvalidation(bus, hub)
    bus.emit(event)

    expect(broadcastSpy).toHaveBeenCalledWith('progress')
  })

  it.each([
    'proposal.added',
    'proposal.promoted',
    'proposal.sliced',
    'proposal.dismissed',
  ])('%s does not emit unrelated channels (tasks, proposals, action-queue)', (event) => {
    const bus = new EventEmitter()
    const hub = new ViewStreamHub()
    const broadcastSpy = vi.spyOn(hub, 'broadcast')

    registerViewInvalidation(bus, hub)
    bus.emit(event)

    expect(broadcastSpy).not.toHaveBeenCalledWith('tasks')
    expect(broadcastSpy).not.toHaveBeenCalledWith('proposals')
    expect(broadcastSpy).not.toHaveBeenCalledWith('action-queue')
    expect(broadcastSpy).not.toHaveBeenCalledWith('kpis')
  })

  it('multiple proposal events each broadcast progress exactly once', () => {
    const bus = new EventEmitter()
    const hub = new ViewStreamHub()
    const broadcastSpy = vi.spyOn(hub, 'broadcast')

    registerViewInvalidation(bus, hub)
    bus.emit('proposal.added')
    bus.emit('proposal.promoted')
    bus.emit('proposal.sliced')

    expect(broadcastSpy).toHaveBeenCalledTimes(3)
    expect(broadcastSpy).toHaveBeenNthCalledWith(1, 'progress')
    expect(broadcastSpy).toHaveBeenNthCalledWith(2, 'progress')
    expect(broadcastSpy).toHaveBeenNthCalledWith(3, 'progress')
  })

  it('task events are unaffected — task.added still broadcasts tasks (not progress)', () => {
    const bus = new EventEmitter()
    const hub = new ViewStreamHub()
    const broadcastSpy = vi.spyOn(hub, 'broadcast')

    // One subscriber wires every kind — task and proposal alike.
    registerViewInvalidation(bus, hub)

    bus.emit('task.added')
    bus.emit('proposal.added')

    // task.added → 'tasks'; proposal.added → 'progress'
    expect(broadcastSpy).toHaveBeenNthCalledWith(1, 'tasks')
    expect(broadcastSpy).toHaveBeenNthCalledWith(2, 'progress')
    expect(broadcastSpy).toHaveBeenCalledTimes(2)
  })
})
