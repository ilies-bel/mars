import { describe, expect, it } from 'vitest'
import { linkifyTaskIds } from './linkifyTaskIds'
import { taskHash } from './routing'

describe('linkifyTaskIds', () => {
  // -------------------------------------------------------------------------
  // Basic linkification
  // -------------------------------------------------------------------------

  it('linkifies a bare 8-char hex ID', () => {
    const id = '489270a0'
    expect(linkifyTaskIds(`Task ${id} was completed`)).toBe(
      `Task [${id}](${taskHash(id, 'chat')}) was completed`,
    )
  })

  it('linkifies a mars- prefixed ID', () => {
    const id = 'mars-66313edc'
    expect(linkifyTaskIds(`See ${id} for details`)).toBe(
      `See [${id}](${taskHash(id, 'chat')}) for details`,
    )
  })

  it('linkifies a fix- prefixed ID', () => {
    const id = 'fix-3b048a5e'
    expect(linkifyTaskIds(`Fixed by ${id}`)).toBe(
      `Fixed by [${id}](${taskHash(id, 'chat')})`,
    )
  })

  it('linkifies a task- prefixed ID', () => {
    const id = 'task-1234abcd'
    expect(linkifyTaskIds(id)).toBe(`[${id}](${taskHash(id, 'chat')})`)
  })

  it('linkifies a recovery- prefixed ID', () => {
    const id = 'recovery-abcdef12'
    expect(linkifyTaskIds(id)).toBe(`[${id}](${taskHash(id, 'chat')})`)
  })

  it('chip href equals taskHash(id, chat)', () => {
    const id = '489270a0'
    const result = linkifyTaskIds(id)
    expect(result).toBe(`[${id}](${taskHash(id, 'chat')})`)
  })

  it('linkifies multiple IDs in one string', () => {
    const result = linkifyTaskIds('See mars-66313edc and 489270a0 both done')
    expect(result).toContain('[mars-66313edc]')
    expect(result).toContain('[489270a0]')
  })

  it('returns unchanged text when there are no task IDs', () => {
    const text = 'Hello world, nothing to linkify here'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  // -------------------------------------------------------------------------
  // Guard: code spans and code blocks
  // -------------------------------------------------------------------------

  it('does not linkify IDs inside backtick inline code spans', () => {
    const text = 'Run `mars task get 489270a0` to check'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  it('does not linkify IDs inside fenced code blocks', () => {
    const text = '```\npsql -c "where id = \'489270a0\'"\n```'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  it('does not linkify IDs in a fenced code block with a language tag', () => {
    const text = '```bash\necho mars-66313edc\n```'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  // -------------------------------------------------------------------------
  // Guard: existing markdown links
  // -------------------------------------------------------------------------

  it('does not linkify IDs already inside an existing markdown link', () => {
    const text = '[489270a0](#/task/489270a0?from=chat)'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  it('does not touch a pre-existing link even if the href contains a task ID', () => {
    const text = '[click here](#/task/489270a0?from=chat)'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  // -------------------------------------------------------------------------
  // Overlap / double-linkify prevention
  // -------------------------------------------------------------------------

  it('does not double-linkify the bare portion of a prefixed ID', () => {
    const text = 'mars-66313edc completed'
    const result = linkifyTaskIds(text)
    expect((result.match(/\[/g) ?? []).length).toBe(1)
    expect(result).toContain('[mars-66313edc]')
    expect(result).not.toContain('[66313edc]')
  })

  // -------------------------------------------------------------------------
  // Boundary checks — must NOT match partial hex strings
  // -------------------------------------------------------------------------

  it('does not match a 9-char hex string as a bare ID', () => {
    // 489270a0f has a hex char immediately after the 8th char → no word boundary
    const text = 'not-a-task 489270a0f extra char'
    expect(linkifyTaskIds(text)).toBe(text)
  })

  it('does not match a 7-char hex string as a bare ID', () => {
    const text = 'short 489270a only seven'
    expect(linkifyTaskIds(text)).toBe(text)
  })
})
