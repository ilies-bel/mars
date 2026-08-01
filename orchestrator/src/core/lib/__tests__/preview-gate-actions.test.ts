/**
 * Tests for the awaiting-validation action menu and the preview-gate sentinel
 * detector — the small pure pieces that wire the gate into the action queue and
 * the daemon dispatch suppression.
 */

import { describe, expect, it } from 'vitest'
import { derivedRowActions } from '../derived-row-actions'
import { ACTION_QUEUE_KINDS } from '../action-queue-kinds'

describe('awaiting-validation kind + actions', () => {
  it('is a registered action-queue kind', () => {
    expect(ACTION_QUEUE_KINDS).toContain('awaiting-validation')
  })

  it('derivedRowActions returns Validate (no confirm) and Reject (confirm)', () => {
    const actions = derivedRowActions('awaiting-validation', 'task-1')
    expect(actions.map((a) => a.op)).toEqual(['validate', 'reject'])

    const validate = actions.find((a) => a.op === 'validate')!
    expect(validate.label).toBe('Validate')
    expect(validate.needsConfirm).toBeUndefined()

    const reject = actions.find((a) => a.op === 'reject')!
    expect(reject.label).toBe('Reject')
    // Reject is destructive (fails the task) — must confirm.
    expect(reject.needsConfirm).toBe(true)
  })

  it('unrelated kinds return no awaiting-validation actions', () => {
    expect(derivedRowActions('failed-task')).toEqual([])
  })
})
