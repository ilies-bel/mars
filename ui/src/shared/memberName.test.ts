import { describe, expect, it } from 'bun:test'
import { prdTitleFromBody } from './memberName'

const ID = '04b4e4e0-queue-position-ordering-for-the-cas-merg'
const BODY =
  `PRD ${ID} (Queue-position ordering for the CAS merge loop) could not be ` +
  'sliced: slice workflow failed — error: provider worker exited 1'

describe('prdTitleFromBody', () => {
  it('reads the real title the slug was cut from', () => {
    // The id ends mid-word at "merg"; the parenthetical is the whole title.
    expect(prdTitleFromBody(BODY, ID)).toBe(
      'Queue-position ordering for the CAS merge loop',
    )
  })

  it('only matches a parenthetical introduced by this row id', () => {
    // Guards the failure mode this helper exists to avoid: picking up any
    // bracketed text that happens to appear in the prose.
    expect(prdTitleFromBody(BODY, 'some-other-prd')).toBeNull()
    expect(
      prdTitleFromBody('Something failed (Connection refused) while running', ID),
    ).toBeNull()
  })

  it('keeps a title that contains its own brackets', () => {
    // Real PRD titles do this. Stopping at the first ")" cut the closing
    // bracket off and produced an obviously-broken half-title on screen.
    const id = '7f8d248a-merge-trains-batched-rebase-verify-ff'
    const body = `PRD ${id} (Merge trains (batched rebase+verify+ff)) could not be sliced: boom`
    expect(prdTitleFromBody(body, id)).toBe('Merge trains (batched rebase+verify+ff)')
  })

  it('returns null rather than empty text', () => {
    expect(prdTitleFromBody(`PRD ${ID} () could not be sliced`, ID)).toBeNull()
    expect(prdTitleFromBody(`PRD ${ID} (   ) could not be sliced`, ID)).toBeNull()
  })

  it('returns null on an unterminated parenthetical', () => {
    expect(prdTitleFromBody(`PRD ${ID} (Queue-position ordering`, ID)).toBeNull()
  })

  it('handles absent input without throwing', () => {
    expect(prdTitleFromBody(null, ID)).toBeNull()
    expect(prdTitleFromBody(BODY, null)).toBeNull()
    expect(prdTitleFromBody(BODY, '')).toBeNull()
    expect(prdTitleFromBody(undefined, undefined)).toBeNull()
  })
})
