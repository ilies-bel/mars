/**
 * ADR-0100 shared-contract pins.
 *
 * `lastSyncedRef` and `operatorWipCommitMessage` produce strings that leave the
 * process: a ref another Mars command reads back, and a commit subject the
 * operator greps for and the Notice quotes. Both are consumed by several of the
 * ADR-0100 slices independently, so their exact shape is the contract — not an
 * implementation detail either slice may quietly restate.
 */
import { describe, it, expect } from 'vitest'
import {
  LAST_SYNCED_REF_PREFIX,
  lastSyncedRef,
  operatorWipCommitMessage,
} from '../merge'

describe('lastSyncedRef', () => {
  it('names a flat ref one level under the last-synced prefix', () => {
    expect(lastSyncedRef('main')).toBe(`${LAST_SYNCED_REF_PREFIX}/main`)
  })

  it('flattens slashes so a branch like release/2026-08 cannot nest or collide', () => {
    const ref = lastSyncedRef('release/2026-08')
    expect(ref).toBe(`${LAST_SYNCED_REF_PREFIX}/release-2026-08`)
    expect(ref.slice(LAST_SYNCED_REF_PREFIX.length + 1)).not.toContain('/')
  })

  it('maps distinct integration branches to distinct refs', () => {
    expect(lastSyncedRef('main')).not.toBe(lastSyncedRef('integration'))
  })
})

describe('operatorWipCommitMessage', () => {
  it('produces the exact ADR-0100 subject, naming the task that was unblocked', () => {
    expect(operatorWipCommitMessage('mars-abc123')).toBe(
      'wip(operator): auto-committed to unblock merge of mars-abc123',
    )
  })

  it('stays a single line within the 72-character conventional-commit budget', () => {
    const subject = operatorWipCommitMessage('mars-abc123')
    expect(subject).not.toContain('\n')
    expect(subject.length).toBeLessThanOrEqual(72)
  })
})
