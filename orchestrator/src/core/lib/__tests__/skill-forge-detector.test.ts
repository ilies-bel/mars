import { describe, expect, it } from 'vitest'
import {
  detectCrossArcLessons,
  type CrossArcLesson,
  type DeepReflectRow,
} from '../skill-forge-detector'

// ── Fixtures ────────────────────────────────────────────────────────────────

const mkRow = (
  originId: string,
  title: string,
  rootCauseKey: string,
  summary = 'A recurring lesson.',
): DeepReflectRow => ({ originId, title, rootCauseKey, summary })

// Shared lesson present in multiple arcs
const LESSON_TITLE = 'Add retry logic to pnpm install'
const LESSON_KEY = 'pnpm_install_flakiness'
const LESSON_SUMMARY = 'pnpm install fails transiently; retries resolve it.'

const rowFor = (originId: string) =>
  mkRow(originId, LESSON_TITLE, LESSON_KEY, LESSON_SUMMARY)

// ── Tests ────────────────────────────────────────────────────────────────────

describe('detectCrossArcLessons', () => {
  it('returns [] for an empty input', () => {
    expect(detectCrossArcLessons([])).toEqual([])
  })

  it('returns [] when the same lesson appears in only 2 distinct arcs', () => {
    const rows: DeepReflectRow[] = [
      rowFor('arc-1'),
      rowFor('arc-2'),
    ]
    expect(detectCrossArcLessons(rows)).toEqual([])
  })

  it('returns 1 CrossArcLesson with 3 motivating arc IDs when the lesson spans 3 arcs', () => {
    const rows: DeepReflectRow[] = [
      rowFor('arc-1'),
      rowFor('arc-2'),
      rowFor('arc-3'),
    ]

    const result = detectCrossArcLessons(rows)

    expect(result).toHaveLength(1)
    const lesson: CrossArcLesson = result[0]
    expect(lesson.title).toBe(LESSON_TITLE)
    expect(lesson.summary).toBe(LESSON_SUMMARY)
    expect(lesson.motivatingArcOriginIds).toHaveLength(3)
    expect(new Set(lesson.motivatingArcOriginIds)).toEqual(
      new Set(['arc-1', 'arc-2', 'arc-3']),
    )
    // The key is derived deterministically from title + rootCauseKey.
    expect(lesson.key).toBe('add-retry-logic-to-pnpm-install::pnpm_install_flakiness')
  })

  it('deduplicates repeated rows for the same (originId, lesson) pair', () => {
    // Same arc appears twice with the same lesson — should still count as 1 distinct arc.
    const rows: DeepReflectRow[] = [
      rowFor('arc-1'),
      rowFor('arc-1'), // duplicate originId for the same lesson
      rowFor('arc-2'),
      rowFor('arc-3'),
    ]

    const result = detectCrossArcLessons(rows)
    expect(result).toHaveLength(1)
    expect(result[0].motivatingArcOriginIds).toHaveLength(3)
  })

  it('clusters mixed lessons independently and filters each by the 3-arc threshold', () => {
    const rows: DeepReflectRow[] = [
      // Lesson Alpha: 3 arcs → should appear
      mkRow('arc-a', 'Lesson Alpha', 'alpha_root', 'Alpha summary.'),
      mkRow('arc-b', 'Lesson Alpha', 'alpha_root', 'Alpha summary.'),
      mkRow('arc-c', 'Lesson Alpha', 'alpha_root', 'Alpha summary.'),
      // Lesson Beta: 2 arcs → filtered out
      mkRow('arc-d', 'Lesson Beta', 'beta_root', 'Beta summary.'),
      mkRow('arc-e', 'Lesson Beta', 'beta_root', 'Beta summary.'),
      // Rare: 1 arc → filtered out
      mkRow('arc-x', 'Rare lesson', 'rare_root', 'Rare summary.'),
    ]

    const result = detectCrossArcLessons(rows)

    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Lesson Alpha')
    expect(result[0].motivatingArcOriginIds).toHaveLength(3)
    expect(new Set(result[0].motivatingArcOriginIds)).toEqual(
      new Set(['arc-a', 'arc-b', 'arc-c']),
    )
  })

  it('derives the stable lesson key from slugified title and normalised rootCauseKey', () => {
    // Rows with different casing / spacing but semantically the same key
    const rows: DeepReflectRow[] = [
      mkRow('arc-1', '  Add Retry Logic  ', ' pnpm_install_flakiness ', 's'),
      mkRow('arc-2', '  Add Retry Logic  ', ' pnpm_install_flakiness ', 's'),
      mkRow('arc-3', '  Add Retry Logic  ', ' pnpm_install_flakiness ', 's'),
    ]

    const result = detectCrossArcLessons(rows)
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe('add-retry-logic::pnpm_install_flakiness')
  })
})
